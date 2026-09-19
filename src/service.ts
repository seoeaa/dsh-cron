/**
 * dsh-cron — the `cron` service: one facade over definitions, state, runs.
 *
 * Both consumers sit on this single object: the model-facing tools call the
 * typed methods, and the Web panel calls the four Remote methods that answer
 * JSON strings (Web returns to the panel through `src/wire.ts`). Keeping one
 * owner for reading the store, for the durable pause state and for the launch
 * decision is what stops the panel and the tools from disagreeing about what
 * "paused" or "next run" means.
 *
 * Scheduling itself is optional here: the service decides whether this plugin
 * or another engine owns it, so an installed second scheduler can never
 * double-fire a job.
 *
 * @module dsh-cron/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { JobScheduler } from './scheduler.ts'
import { RunLauncher, type RunHandle } from './runner.ts'
import {
  expandHome,
  readJobs,
  removeJob,
  resolveDirs,
  watchJobs,
  writeJob,
  type StoreDirs,
} from './store.ts'
import { loadState, saveState, type SchedulerState } from './state.ts'
import { listRuns } from './runs.ts'
import { describeSchedule, nextRuns, normalizeSchedule } from './cron.ts'
import { optionalService } from './optional.ts'
import { CRON_NAMESPACE, encodeWire } from './wire.ts'
import type { Config } from './config.ts'
import type {
  CronJob,
  CronSnapshot,
  DeliveryTarget,
  EngineState,
  InvalidJob,
  JobInput,
  JobMutation,
  MutationResult,
  RunRecord,
  RunStatus,
  RunTrigger,
  SchedulePreview,
} from './types.ts'

/** Drop explicitly undefined fields so a spread cannot erase a default. */
function withoutUndefined<T extends object>(input: T): T {
  const result = {} as Record<string, unknown>
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value
  }
  return result as T
}

/** Plugin version reported in the panel (kept in step with package.json). */
export const VERSION = '0.1.0'

/** Why scheduling is (not) owned by this plugin. */
export interface EngineLookup {
  mode: 'own' | 'companion' | 'off'
  owner?: string
  reason?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scheduled-job definitions, durable state and run launching. */
    cron?: CronService
  }
}

/**
 * The scheduled-job facade.
 *
 * Definitions are re-read from disk on every mutation and on every watched
 * change, never cached behind a stale promise: a user editing a YAML file in an
 * editor must see the same job the panel sees.
 */
export class CronService extends TypertRemoteService {
  private jobs: CronJob[] = []
  private invalid: InvalidJob[] = []
  /**
   * The project root, expanded once.
   *
   * Two different things are easy to confuse here and both hurt: the state file
   * is keyed by the PROJECT ROOT (`<root>/.dsh/routines/state.json`, the path the
   * other scheduler engine reads), while a job's default cwd is that same root —
   * not the `.dsh/routines` bookkeeping directory the definitions live in.
   */
  private readonly projectRoot: string
  private readonly dirs: StoreDirs
  private readonly launcher: RunLauncher
  private scheduler: JobScheduler | undefined
  private watcher: { dispose(): void } | undefined
  private readonly listeners = new Set<() => void>()
  private engineState: EngineState = { mode: 'own' }

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    // The service key (`cron`) and the wire namespace (`dshCron`) differ on
    // purpose: the key is what the tools and the sweep read, the namespace is
    // the Remote surface the Web page mounts. The binding is what lets the
    // gateway find this exact instance for `dshCron/*` invocations.
    super(ctx, 'cron', { namespace: CRON_NAMESPACE })
    this.projectRoot = expandHome(config.projectDir)
    this.dirs = resolveDirs(this.projectRoot, config.globalDir)
    this.launcher = new RunLauncher(
      ctx,
      {
        dshBin: config.dshBin,
        runModule: config.runModule ?? '',
        digestMaxChars: config.digestMaxChars,
        summaryMaxChars: config.summaryMaxChars,
        summaryMaxTokens: config.summaryMaxTokens,
        summaryTimeoutMs: config.summaryTimeoutMs,
      },
    )
    // Resolved once here so the panel and the tools never see a stale "own"
    // before `start()` runs; `start()` resolves again, because the set of
    // mounted neighbours can still change while this plugin activates.
    this.engineState = this.resolveEngine()
    this.reload()
    if (config.watch) {
      this.watcher = watchJobs(this.dirs, () => {
        this.reload()
        this.notify()
      })
    }
    ctx.effect(() => () => {
      this.watcher?.dispose()
      this.launcher.dispose()
    })
  }

  /** Start scheduling, deciding first who owns it. */
  start(): void {
    this.engineState = this.resolveEngine()
    if (this.engineState.mode !== 'own') return
    this.scheduler = new JobScheduler(this.ctx, this, {
      tickSeconds: this.config.tickSeconds,
      allowRunNow: this.config.allowRunNow,
    })
    this.scheduler.start()
  }

  /** Whether this plugin owns scheduling, and who does when it does not. */
  engine(): EngineState {
    return this.engineState
  }

  /** Directories watched for definitions. */
  directories(): StoreDirs {
    return this.dirs
  }

  /** Every definition, project over global, sorted by name. */
  list(): CronJob[] {
    const state = this.state()
    return this.jobs.map((job) => this.decorate(job, state))
  }

  /** One definition by name, decorated with its live state. */
  get(name: string): CronJob | undefined {
    const job = this.jobs.find((candidate) => candidate.name === name)
    return job === undefined ? undefined : this.decorate(job, this.state())
  }

  /** Definition files that failed validation. */
  invalidFiles(): InvalidJob[] {
    return this.invalid
  }

  /** Names of jobs with a run in flight. */
  running(): string[] {
    return this.launcher.running()
  }

  /**
   * Launch one job now, whoever asked (the sweep or a manual trigger).
   *
   * The caller owns the returned handle; the launcher already tracks the run
   * under the job's name, which is what makes `running()` the single answer to
   * "is this job busy" for the sweep, the panel and the tools.
   */
  launchScheduled(job: CronJob, trigger: RunTrigger = 'schedule'): RunHandle {
    if (this.launcher.runIdOf(job.name) !== undefined) {
      throw new Error(`job "${job.name}" is already running`)
    }
    const handle = this.launcher.launch(job, trigger)
    this.notify()
    return handle
  }

  /**
   * Advance the durable anchor of a job before its run starts.
   *
   * Written before the child process exists, so a crash mid-run cannot re-fire
   * the same minute when the process comes back. This is also the anchor the
   * missed-run policy advances from, which is why `lastRunAt` holds the
   * *scheduled* instant rather than the wall clock.
   */
  markLaunched(name: string, at: number, status: RunStatus): void {
    this.mutateState((state) => {
      state.lastRunAt[name] = at
      state.lastStatus[name] = { status, at }
    })
  }

  /** Recent run records of one job, newest first. */
  records(name: string, limit = 20): RunRecord[] {
    const job = this.jobs.find((candidate) => candidate.name === name)
    if (job === undefined) return []
    return listRuns(job.cwd, limit)
  }

  /** Ask a running job to stop. */
  cancel(name: string, reason = 'cancelled'): boolean {
    return this.launcher.cancel(name, reason)
  }

  /**
   * Create or replace one definition; returns the stored job.
   *
   * An omitted timezone becomes the configured default here rather than in the
   * store, so the panel, the tools and a hand-written file all land on the same
   * zone instead of three different fallbacks.
   */
  save(input: JobInput): CronJob {
    const stored = writeJob(this.dirs, {
      timezone: this.config.defaultTimezone,
      ...withoutUndefined(input),
    })
    this.reload()
    this.notify()
    return stored
  }

  /** Delete one definition from whichever scope holds it. */
  remove(name: string): boolean {
    const removed = removeJob(this.dirs, name)
    if (removed) {
      this.reload()
      this.notify()
    }
    return removed
  }

  /** Pause or resume one job; the flag lives in the durable state file. */
  setPaused(name: string, paused: boolean): boolean {
    if (!this.jobs.some((job) => job.name === name)) return false
    this.mutateState((state) => {
      const set = new Set(state.paused)
      if (paused) set.add(name)
      else set.delete(name)
      state.paused = [...set].sort()
    })
    this.notify()
    return true
  }

  /** Launch one job immediately, ignoring its schedule but not its overlap policy. */
  async runNow(name: string): Promise<RunRecord> {
    const job = this.jobs.find((candidate) => candidate.name === name)
    if (job === undefined) throw new Error(`no job named "${name}"`)
    if (!this.config.allowRunNow) {
      throw new Error('running jobs from the panel is disabled (allowRunNow: false)')
    }
    const handle = this.launchScheduled(job, 'manual')
    this.markLaunched(name, Date.now(), 'running')
    const record = await handle.done
    this.recordOutcome(name, record)
    this.notify()
    return record
  }

  /** Resolve one schedule expression without saving anything. */
  schedulePreview(schedule: string, timezone?: string): SchedulePreview {
    const zone = timezone !== undefined && timezone !== '' ? timezone : this.config.defaultTimezone
    try {
      const now = new Date()
      const next = nextRuns(schedule, zone, now, 3)
      return {
        ok: true,
        description: describeSchedule(schedule),
        normalized: normalizeSchedule(schedule),
        nextRuns: next.map((date) => date.toISOString()),
      }
    } catch (error) {
      return {
        ok: false,
        description: '',
        error: error instanceof Error ? error.message : String(error),
        nextRuns: [],
      }
    }
  }

  /** Delivery channels reachable from this process right now. */
  targets(): DeliveryTarget[] {
    const chatnode = optionalService<{ send(input: { text: string; title?: string }): Promise<void> }>(this.ctx, 'chatnode')
    return [
      {
        kind: 'file',
        id: 'file',
        label: 'File digest',
        available: true,
        note: 'always written next to the job cwd under .dsh/routines/runs/',
      },
      {
        kind: 'chatnode',
        id: 'chatnode',
        label: 'Conversation node',
        available: chatnode !== undefined,
        note: chatnode === undefined
          ? 'no conversation node is mounted (a chatnode plugin provides ctx.chatnode)'
          : 'delivered through ctx.chatnode after each run',
      },
    ]
  }

  /** The whole panel state in one object. */
  snapshot(): CronSnapshot {
    return {
      jobs: this.list(),
      invalid: this.invalid,
      engine: this.engineState,
      dirs: this.dirs,
      running: this.running(),
      paused: this.state().paused,
      targets: this.targets(),
      now: new Date().toISOString(),
      plugin: 'dsh-cron',
      version: VERSION,
    }
  }

  /** Subscribe to definition, state and run changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify subscribers of a change (panel refresh, watcher reload). */
  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // one broken listener must not stop the others
      }
    }
  }

  /**
   * The durable state, read fresh.
   *
   * A second engine (another scheduler plugin) writes the same file, so the
   * service never holds a cached copy across mutations: read-modify-write is
   * the only shape that cannot silently revert someone else's pause.
   */
  state(): SchedulerState {
    return loadState(this.projectRoot)
  }

  /** Read-modify-write one durable state change. */
  mutateState(mutate: (state: SchedulerState) => void): SchedulerState {
    const state = this.state()
    mutate(state)
    saveState(this.projectRoot, state)
    return state
  }

  /**
   * Record the terminal status of a finished run.
   *
   * The launch anchor is left untouched: it is the scheduled instant the sweep
   * advanced past, and overwriting it with the completion time would let a long
   * run silently swallow every occurrence it overlapped.
   */
  recordOutcome(name: string, record: RunRecord): void {
    this.mutateState((state) => {
      state.lastStatus[name] = {
        status: record.status,
        ...(record.error !== undefined ? { error: record.error } : {}),
        at: record.finishedAt ?? Date.now(),
      }
    })
  }

  /** Record that a due run was skipped by the overlap policy. */
  recordSkip(name: string, at: number): void {
    this.mutateState((state) => {
      state.lastRunAt[name] = at
      state.lastStatus[name] = { status: 'skipped', at }
    })
  }

  // ---------------------------------------------------------------- Remote face
  // The four methods the Web panel calls. Payloads cross as JSON strings
  // (`src/wire.ts` owns the descriptors), and every failure is reported inside
  // the payload: a Remote throw would reach the user as a blank panel.

  /** `dshCron/status` — the whole snapshot. */
  status(): string {
    return encodeWire(this.snapshot())
  }

  /** `dshCron/mutate` — one panel action, answered with the refreshed snapshot. */
  async mutate(requestJson: string): Promise<string> {
    let request: JobMutation
    try {
      request = JSON.parse(requestJson) as JobMutation
    } catch {
      return encodeWire(this.failure('the request could not be parsed'))
    }
    try {
      switch (request.action) {
        case 'save':
          this.save(request.job)
          return encodeWire(this.success(`saved "${request.job.name}"`))
        case 'remove':
          return encodeWire(this.remove(request.name)
            ? this.success(`deleted "${request.name}"`)
            : this.failure(`no job named "${request.name}"`))
        case 'pause':
          return encodeWire(this.setPaused(request.name, true)
            ? this.success(`paused "${request.name}"`)
            : this.failure(`no job named "${request.name}"`))
        case 'resume':
          return encodeWire(this.setPaused(request.name, false)
            ? this.success(`resumed "${request.name}"`)
            : this.failure(`no job named "${request.name}"`))
        case 'run':
          await this.runNow(request.name)
          return encodeWire(this.success(`ran "${request.name}"`))
        default:
          return encodeWire(this.failure('unknown action'))
      }
    } catch (error) {
      return encodeWire(this.failure(error instanceof Error ? error.message : String(error)))
    }
  }

  /** `dshCron/history` — recent run records of one job. */
  history(name: string, limit?: number): string {
    return encodeWire(this.records(name, typeof limit === 'number' ? limit : 20))
  }

  /** `dshCron/preview` — live schedule feedback for the editor. */
  preview(schedule: string, timezone?: string): string {
    return encodeWire(this.schedulePreview(schedule, timezone))
  }

  /** A successful mutation answer, carrying the refreshed snapshot. */
  private success(message: string): MutationResult {
    return { ok: true, message, snapshot: this.snapshot() }
  }

  /** A failed mutation answer, carrying the refreshed snapshot too. */
  private failure(error: string): MutationResult {
    return { ok: false, message: error, error, snapshot: this.snapshot() }
  }

  // --------------------------------------------------------------------- internals

  /** Re-read both definition directories. */
  reload(): void {
    const result = readJobs(this.dirs, {
      timezone: this.config.defaultTimezone,
      projectDir: this.projectRoot,
    })
    this.jobs = result.jobs
    this.invalid = result.invalid
  }

  /** Attach live state (pause, next/last run, running) to one definition. */
  private decorate(job: CronJob, state: SchedulerState): CronJob {
    const status = state.lastStatus[job.name]
    const lastRunAt = state.lastRunAt[job.name]
    const paused = state.paused.includes(job.name)
    const next = paused ? undefined : this.nextRunOf(job, lastRunAt)
    return {
      ...job,
      paused,
      running: this.launcher.runIdOf(job.name) !== undefined,
      ...(next !== undefined ? { nextRunAt: next.toISOString() } : {}),
      ...(lastRunAt !== undefined ? { lastRunAt: new Date(lastRunAt).toISOString() } : {}),
      ...(status !== undefined ? { lastStatus: status.status, ...(status.error !== undefined ? { lastError: status.error } : {}) } : {}),
    }
  }

  /**
   * The next fire time of one job.
   *
   * `undefined` when the schedule cannot be resolved (an invalid expression in
   * a definition that validated at load time — the schedule is only checked
   * when it is written, so a hand-edited file can still be unparsable here) and
   * when the schedule never fires again.
   */
  private nextRunOf(job: CronJob, after?: number): Date | undefined {
    const anchor = after !== undefined ? new Date(after) : new Date()
    const [next] = nextRuns(job.schedule, job.timezone, anchor, 1)
    return next
  }

  /** Decide whether scheduling belongs to this plugin. */
  private resolveEngine(): EngineState {
    const other = optionalService<unknown>(this.ctx, 'routinesScheduler')
    if (this.config.engine === 'off') {
      return { mode: 'companion', reason: 'scheduling is disabled (engine: off); definitions are editable here' }
    }
    if (this.config.engine === 'own') {
      return { mode: 'own' }
    }
    if (other !== undefined) {
      return {
        mode: 'companion',
        owner: 'routinesScheduler',
        reason: 'another scheduler plugin (dsh-routines) owns scheduling; set engine: own to take over',
      }
    }
    return { mode: 'own' }
  }
}
