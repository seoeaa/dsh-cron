/**
 * dsh-cron — launching one unattended run.
 *
 * A run is a *process*, not an in-process agent turn. That is deliberate: an
 * unattended run must be unable to block on a permission prompt, must not be
 * able to take the host down with it, and must leave a complete session log of
 * its own. The child boots `dsh --profile <profile> --patch <overlay> --` with
 * the job's cwd as its workspace; the generated overlay forces the approval
 * policy to `never`, disables every scheduler row (a run must never schedule a
 * run), and swaps the stock headless runner for `dsh-cron/run`, which drives one
 * Agent and writes the run record.
 *
 * The parent owns everything the child cannot know: the pre-created record
 * (so the panel sees a run the moment it starts), the hard timeout, the exit
 * code, and the delivery attempts.
 *
 * @module dsh-cron/runner
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { recordPathFor, runsDirFor, writeRun } from './runs.ts'
import type { CronJob, DeliveryResult, RunRecord, RunTrigger } from './types.ts'

/** Cap on captured child output kept for diagnostics. */
const OUTPUT_TAIL_BYTES = 8_192
/** Grace between SIGTERM and SIGKILL for a wedged run. */
const KILL_GRACE_MS = 10_000

/** One run the parent is tracking. */
export interface RunHandle {
  runId: string
  job: CronJob
  /** Resolves once the child exited and the final record is on disk. */
  done: Promise<RunRecord>
  /** Ask the child to stop; `reason` is recorded when the run did not finish. */
  kill(reason: string): void
}

/** What the launcher needs from plugin configuration. */
export interface LauncherConfig {
  dshBin: string
  runModule: string
  digestMaxChars: number
  summaryMaxChars: number
  summaryMaxTokens: number
  summaryTimeoutMs: number
}

/** Services the launcher reads off the context. */
interface LauncherServices {
  chatnode?: { send(input: { text: string; title?: string }): Promise<void> }
}

/** One spawned child, reduced to what the launcher tracks. */
interface Spawned {
  child: ChildProcess
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>
  /** Last bytes the child wrote, for diagnosing a run that did not complete. */
  tail(): string
}

/** Default spawner: a real child process, inheriting the parent environment. */
function spawnRun(bin: string, args: string[], cwd: string): Spawned {
  const isScript = bin.endsWith('.js') || bin.endsWith('.mjs') || bin.endsWith('.cjs')
  const child = isScript
    ? spawn(process.execPath, [bin, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  const capture = (chunk: Buffer): void => {
    tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_BYTES)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    child.on('error', (error) => { resolve({ code: null, signal: null, error: error.message }) })
    child.on('close', (code, signal) => { resolve({ code, signal }) })
  })
  return { child, exit, tail: () => tail }
}

/** Classify a subprocess exit for the digest line. */
function describeExit(exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: string }): string {
  if (exitInfo.error !== undefined) return exitInfo.error
  if (exitInfo.signal !== null) return `signal ${exitInfo.signal}`
  return `exit code ${String(exitInfo.code)}`
}

/**
 * Reduce a child's captured output to one bounded, single-line evidence string.
 * @param tail - raw captured output (stdout + stderr, bounded by the spawner).
 * @returns the last meaningful line, or `''` when the child printed nothing.
 */
function describeTail(tail: string): string {
  const lines = tail.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const last = lines.at(-1) ?? ''
  return last.length > 400 ? `${last.slice(0, 399)}…` : last
}

/** One run id: sortable, unique, and readable in a file listing. */
function newRunId(now: Date, jobName: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return `${jobName}-${stamp}-${randomUUID().slice(0, 8)}`
}

/**
 * Launches runs and owns their lifecycle.
 *
 * `fallbackRunModule` is the compiled driver of this package; the loader may
 * have installed the bundle from a tarball, a git checkout or a `file:` link,
 * and in every case the child needs an absolute path it can import.
 */
export class RunLauncher {
  private readonly inFlight = new Map<string, RunHandle>()

  constructor(
    private readonly ctx: Context,
    private readonly config: LauncherConfig,
    private readonly spawner: (bin: string, args: string[], cwd: string) => Spawned = spawnRun,
  ) {}

  /** The driver module path this launcher hands to a run overlay. */
  get runModule(): string {
    return this.config.runModule
  }

  /** Launch one job now; the returned handle is already tracked. */
  launch(job: CronJob, trigger: RunTrigger): RunHandle {
    const now = new Date()
    const runId = newRunId(now, job.name)
    const recordPath = recordPathFor(job.cwd, runId)
    const runsDir = runsDirFor(job.cwd)
    const patchPath = join(runsDir, `.${runId}.patch.yml`)

    writeRun(job.cwd, {
      runId,
      routine: job.name,
      profile: job.profile,
      cwd: job.cwd,
      status: 'running',
      trigger,
      startedAt: now.getTime(),
    })

    mkdirSync(runsDir, { recursive: true })
    writeFileSync(patchPath, this.overlay(job, runId), 'utf8')

    const args = ['--profile', job.profile, '--patch', patchPath, '--', job.prompt]
    const spawned = this.spawner(this.config.dshBin, args, job.cwd)

    let killReason: string | undefined
    const handle: RunHandle = {
      runId,
      job,
      done: this.finalize(job, runId, recordPath, patchPath, spawned, () => killReason),
      kill: (reason: string) => {
        if (killReason === undefined) killReason = reason
        this.terminate(spawned, runId)
      },
    }
    this.inFlight.set(job.name, handle)
    return handle
  }

  /** Whether a job has a run in flight right now. */
  running(): string[] {
    return [...this.inFlight.keys()]
  }

  /** Run id of a job's in-flight run, when it has one. */
  runIdOf(jobName: string): string | undefined {
    return this.inFlight.get(jobName)?.runId
  }

  /** Ask a running job to stop. */
  cancel(jobName: string, reason: string): boolean {
    const handle = this.inFlight.get(jobName)
    if (handle === undefined) return false
    handle.kill(reason)
    return true
  }

  /** Stop every in-flight run (plugin disposal). */
  dispose(): void {
    for (const handle of this.inFlight.values()) handle.kill('plugin unloaded')
  }

  /** SIGTERM, then SIGKILL after a grace period. */
  private terminate(spawned: Spawned, runId: string): void {
    try {
      spawned.child.kill('SIGTERM')
    } catch {
      return
    }
    const timer = setTimeout(() => {
      try {
        spawned.child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS)
    timer.unref?.()
    void spawned.exit.then(() => { clearTimeout(timer) }, () => { clearTimeout(timer) })
  }

  /** Wait for the child, reconcile its record, and deliver the digest. */
  private async finalize(
    job: CronJob,
    runId: string,
    recordPath: string,
    patchPath: string,
    spawned: Spawned,
    killReason: () => string | undefined,
  ): Promise<RunRecord> {
    const exitInfo = await spawned.exit
    rmSync(patchPath, { force: true })

    const existing = readRecordFile(recordPath)
    const reason = killReason()
    const finishedAt = Date.now()
    const childCompleted = existing?.status === 'completed'
    const timedOut = reason === 'timeout'

    const record: RunRecord = {
      runId,
      routine: job.name,
      profile: job.profile,
      cwd: job.cwd,
      status: childCompleted ? 'completed' : timedOut ? 'timeout' : 'failed',
      trigger: existing?.trigger ?? 'manual',
      startedAt: existing?.startedAt ?? finishedAt,
      finishedAt,
      durationMs: finishedAt - (existing?.startedAt ?? finishedAt),
      exitCode: exitInfo.code ?? undefined,
      ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
      ...(existing?.digest !== undefined ? { digest: existing.digest } : {}),
      ...(existing?.denied !== undefined ? { denied: existing.denied } : {}),
      ...(childCompleted
        ? {}
        : {
            error: [existing?.error
              ?? (timedOut
                ? `run exceeded its ${job.timeoutMin}-minute timeout and was stopped`
                : reason !== undefined
                  ? `run stopped: ${reason}`
                  : `run did not complete (${describeExit(exitInfo)})`),
              // A run that dies before writing its own record leaves nothing
              // else behind, so what the child printed is the only evidence a
              // person can act on. Keep it bounded; it ends up in the panel.
              describeTail(spawned.tail()),
            ].filter((part) => part !== '').join(' — '),
          }),
    }

    const deliveries = await this.deliver(job, record)
    if (deliveries.length > 0) record.deliveries = deliveries
    writeRun(job.cwd, record)
    this.inFlight.delete(job.name)
    return record
  }

  /**
   * Deliver one finished run's digest.
   *
   * `file` delivery is inherent: the record and its `.md` digest are already
   * next to the job's cwd. A `chatnode` delivery needs a conversation node to
   * be mounted; when none is, the attempt is recorded as a failure rather than
   * thrown, because a missing delivery channel must not fail the run.
   */
  private async deliver(job: CronJob, record: RunRecord): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = []
    const wanted = job.deliver.map((entry) => entry.type)
    if (wanted.includes('file')) results.push({ type: 'file', ok: true })
    if (!wanted.includes('chatnode')) return results

    const services = this.ctx as unknown as LauncherServices
    const chatnode = services.chatnode
    if (chatnode === undefined) {
      results.push({ type: 'chatnode', ok: false, error: 'no conversation node is mounted (ctx.chatnode)' })
      return results
    }
    try {
      await chatnode.send({
        title: `cron ${job.name}: ${record.status}`,
        text: record.digest ?? `(no digest) — ${record.error ?? 'no detail'}`,
      })
      results.push({ type: 'chatnode', ok: true })
    } catch (error) {
      results.push({
        type: 'chatnode',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return results
  }

  /**
   * The generated `--patch` overlay for one run.
   *
   * Unattended safety comes from two rows: the approval policy is forced to
   * `never`, and the permission table registers the matching preset so the
   * table still validates (workspace-write sandbox + never approval).
   */
  private overlay(job: CronJob, runId: string): string {
    const q = (value: string): string => JSON.stringify(value)
    return [
      '# dsh-cron run overlay (generated; safe to delete)',
      `# run ${runId} of ${job.name}`,
      '',
      '# Anything that would prompt is auto-denied and reported in the run record.',
      '- id: approval',
      '  config:',
      '    policy: never',
      '# The permission table must still validate for the unattended combination.',
      '- id: permission',
      '  config:',
      '    defaultPreset: workspace-write-deny',
      '    presets:',
      '      workspace-write-deny:',
      '        sandbox: workspace-write',
      '        approval: never',
      '',
      '# A run must never schedule nested runs, from this plugin or any other.',
      '- id: cron-scheduler',
      '  disabled: true',
      '- id: routines-scheduler',
      '  disabled: true',
      '',

      '# Replace the stock headless runner with the dsh-cron run driver.',
      '- id: headless-runner',
      '  disabled: true',
      '- insert:',
      '    - id: dsh-cron-run-driver',
      `      name: ${q(this.config.runModule)}`,
      '      inject: [headlessStartup]',
      '      config:',
      '        task: !!js ctx.headlessStartup.task',
      `        routine: ${q(job.name)}`,
      `        runId: ${q(runId)}`,
      `        digestMaxChars: ${this.config.digestMaxChars}`,
      `        summaryMaxChars: ${this.config.summaryMaxChars}`,
      `        summaryMaxTokens: ${this.config.summaryMaxTokens}`,
      `        summaryTimeoutMs: ${this.config.summaryTimeoutMs}`,
      '',
    ].join('\n')
  }
}

/**
 * Read a run record by absolute path, tolerating absence or a torn file.
 *
 * The launcher reconciles the record its child wrote at the path it chose
 * itself, so it reads that path directly instead of re-deriving it from the
 * cwd — one less way for the two halves to disagree.
 */
function readRecordFile(path: string): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  } catch {
    return undefined
  }
}
