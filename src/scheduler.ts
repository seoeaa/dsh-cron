/**
 * dsh-cron — the due-time sweep.
 *
 * One tick decides, per job, whether the schedule has come due since its last
 * launch, and then applies that job's overlap policy. The durable anchor lives
 * in `state.json` (`lastRunAt`) and is written *before* a run starts: a process
 * that dies mid-run must not re-fire the same minute when it comes back, and the
 * missed-run policy is then simply "the schedule is due, run it once".
 *
 * A running job is registered on `ctx.jobs`, so the harness's own job surfaces
 * (the session header list, the jobs tool) show scheduled work as first-class
 * background work rather than an invisible timer.
 *
 * @module dsh-cron/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the disposer-aware `ctx.interval` / `ctx.timeout` mixin in.
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: merges this job kind into the harness's job vocabulary at compile time.
import type {} from '@deepseek-ai/dsh-jobs'
import { nextRunAfter } from './cron.ts'
import { optionalService } from './optional.ts'
import type { CronService } from './service.ts'
import { writeRun } from './runs.ts'
import type { CronJob, RunRecord, RunStatus } from './types.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** One scheduled dsh-cron job run. */
    cron: 'cron'
  }
}

/** Scheduler knobs, taken from plugin configuration. */
export interface SchedulerConfig {
  /** Seconds between two sweeps. */
  tickSeconds: number
  /** Whether a manual run may be started out of band. */
  allowRunNow: boolean
}

/** The minimal job registry surface the sweep uses. */
interface JobRegistry {
  start(spec: {
    kind: 'cron'
    label: string
    run: () => {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'failed' | 'killed'; detail?: string; output?: string }>
    }
  }): string
  kill(id: string, caller?: undefined, reason?: string): void
}

/** A job the sweep decided is due. */
export interface DueJob {
  job: CronJob
  /** The scheduled instant that came due (epoch ms). */
  scheduledFor: number
}

/**
 * The sweep owner.
 *
 * `tick` is public and takes its clock as an argument, so the whole decision
 * matrix (due, not due, paused, overlapping, cancelled) is testable without
 * waiting for a timer.
 */
export class JobScheduler {
  private timer: (() => void) | undefined
  private started = false
  /**
   * The instant this scheduler took responsibility for firing jobs.
   *
   * A job that has never run is anchored here (minus one tick), NOT at "now
   * minus one tick" recomputed per sweep: a sliding anchor moves forward with
   * every tick, so `next` would always sit in the future and an interval job
   * like `every 30m` would never fire at all.
   */
  private readonly armedAt = new Date()

  constructor(
    private readonly ctx: Context,
    private readonly service: CronService,
    private readonly config: SchedulerConfig,
  ) {}

  /** Begin sweeping. Safe to call once; later calls are ignored. */
  start(): void {
    if (this.started) return
    this.started = true
    this.timer = this.ctx.interval(() => { this.tick(new Date()) }, this.config.tickSeconds * 1000)
    // One immediate sweep catches up anything that came due while the process
    // was not running, instead of waiting a full tick to notice it.
    this.tick(new Date())
  }

  /** Stop sweeping. Runs already in flight keep their own lifetime. */
  stop(): void {
    this.timer?.()
    this.timer = undefined
    this.started = false
  }

  /**
   * Jobs whose schedule came due at or before `now`.
   *
   * The anchor is the job's last launch; a job that has never run is anchored
   * one tick back, so a freshly written definition fires on the first sweep only
   * when its schedule is already due — adding a job does not replay history.
   */
  due(now: Date): DueJob[] {
    const state = this.service.state()
    const due: DueJob[] = []
    for (const job of this.service.list()) {
      if (job.paused) continue
      const anchorMs = state.lastRunAt[job.name]
      const anchor = anchorMs !== undefined
        ? new Date(anchorMs)
        : new Date(this.armedAt.getTime() - this.config.tickSeconds * 1000)
      let next: Date | undefined
      try {
        next = nextRunAfter(job.schedule, job.timezone, anchor)
      } catch {
        // A definition that stopped parsing after a hand edit: the store already
        // reports it as invalid, and one bad schedule must not stop the sweep.
        continue
      }
      if (next !== undefined && next.getTime() <= now.getTime()) {
        due.push({ job, scheduledFor: next.getTime() })
      }
    }
    return due
  }

  /** One decision pass. */
  tick(now: Date): void {
    for (const entry of this.due(now)) {
      try {
        this.activate(entry)
      } catch (error) {
        this.warn(`could not start "${entry.job.name}": ${describe(error)}`)
      }
    }
  }

  /** Apply one due job's overlap policy, then launch it. */
  private activate(entry: DueJob): void {
    const { job, scheduledFor } = entry
    if (this.service.running().includes(job.name)) {
      if (job.overlap === 'skip') {
        this.service.markLaunched(job.name, scheduledFor, 'skipped')
        this.recordSkip(job, scheduledFor)
        return
      }
      if (job.overlap === 'queue') {
        // The anchor is deliberately left alone: the job stays due and fires on
        // the first sweep after the current run releases its name.
        return
      }
      this.service.cancel(job.name, 'superseded by the next scheduled run')
    }
    this.launch(job, scheduledFor, 'schedule')
  }

  /** Launch one run, and wire its job registration, timeout and completion. */
  launch(job: CronJob, scheduledFor: number, trigger: 'schedule' | 'manual'): void {
    const handle = this.service.launchScheduled(job, trigger)
    this.service.markLaunched(job.name, scheduledFor, 'running')

    const jobs = optionalService<JobRegistry>(this.ctx, 'jobs')
    let jobId: string | undefined
    if (jobs !== undefined) {
      try {
        jobId = jobs.start({
          kind: 'cron',
          label: `cron ${job.name} (${handle.runId})`,
          run: () => ({
            cancel: (reason?: string) => { handle.kill(reason ?? 'cancelled') },
            done: handle.done.then((record: RunRecord) => ({
              status: jobStatusOf(record.status),
              ...(record.error !== undefined ? { detail: record.error } : {}),
              ...(record.digest !== undefined ? { output: record.digest } : {}),
            })),
          }),
        })
      } catch (error) {
        this.warn(`job registry refused "${job.name}": ${describe(error)}`)
      }
    }

    // A wedged run must not still hold the workspace when the next day starts.
    const stop = this.ctx.timeout(() => {
      if (this.service.running().includes(job.name)) handle.kill('timeout')
      if (jobId !== undefined) jobs?.kill(jobId, undefined, 'cron timeout')
    }, job.timeoutMin * 60_000)

    void handle.done.then(
      (record: RunRecord) => {
        stop()
        this.service.recordOutcome(job.name, record)
        this.service.notify()
      },
      () => { stop() },
    )
  }

  /** Write the audit record of a run the overlap policy refused to start. */
  private recordSkip(job: CronJob, scheduledFor: number): void {
    const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    writeRun(job.cwd, {
      runId: `${job.name}-${stamp}-skipped`,
      routine: job.name,
      profile: job.profile,
      cwd: job.cwd,
      status: 'skipped',
      trigger: 'schedule',
      startedAt: scheduledFor,
      finishedAt: Date.now(),
      error: 'overlap: the previous run was still in flight (policy: skip)',
    })
    this.service.notify()
  }

  private warn(message: string): void {
    const logger = this.ctx.logger as { warn?(text: string): void } | undefined
    logger?.warn?.(`dsh-cron: ${message}`)
  }
}

/** Translate a finished run's status into the job registry's vocabulary. */
function jobStatusOf(status: RunStatus): 'completed' | 'failed' | 'killed' {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'timeout') return 'failed'
  return 'killed'
}

/** Human text for an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
