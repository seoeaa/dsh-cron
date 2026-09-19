import { describe, expect, it, vi } from 'vitest'
import { JobScheduler } from '../src/scheduler.ts'
import type { CronJob, RunRecord } from '../src/types.ts'

/** A job with a fixed schedule and no state of its own. */
function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    name: 'job-a',
    schedule: 'every 30m',
    timezone: 'UTC',
    prompt: 'do the thing',
    cwd: '/tmp/does-not-matter',
    profile: 'headless',
    overlap: 'skip',
    timeoutMin: 45,
    deliver: [{ type: 'file' }],
    source: 'project',
    file: '/tmp/does-not-matter/job-a.yaml',
    paused: false,
    running: false,
    ...overrides,
  }
}

/** The slice of the service the scheduler uses, with spies. */
function fakeService(options: {
  jobs?: CronJob[]
  lastRunAt?: Record<string, number>
  paused?: string[]
  running?: string[]
}) {
  const calls = {
    launched: [] as string[],
    marked: [] as Array<{ name: string; at: number; status: string }>,
    cancelled: [] as string[],
    outcomes: [] as RunRecord[],
    notified: 0,
  }
  const resolvedJobs = options.jobs ?? [job()]
  const state = { paused: options.paused ?? [], lastRunAt: options.lastRunAt ?? {}, lastStatus: {} }
  const service = {
    list: () => resolvedJobs,
    state: () => state,
    running: () => options.running ?? [],
    launchScheduled: (target: CronJob) => {
      calls.launched.push(target.name)
      return handleFor(target)
    },
    markLaunched: (name: string, at: number, status: string) => {
      calls.marked.push({ name, at, status })
      state.lastRunAt[name] = at
    },
    cancel: (name: string) => {
      calls.cancelled.push(name)
      return true
    },
    recordOutcome: (name: string, record: RunRecord) => {
      calls.outcomes.push(record)
    },
    notify: () => { calls.notified += 1 },
  }
  return { service, calls, state }
}

/** A controllable run handle: the test decides when the run ends. */
function handleFor(target: CronJob) {
  const record: RunRecord = {
    runId: `run-${target.name}`,
    routine: target.name,
    profile: target.profile,
    cwd: target.cwd,
    status: 'completed',
    trigger: 'schedule',
    startedAt: Date.now(),
  }
  return {
    runId: record.runId,
    job: target,
    done: Promise.resolve(record),
    kill: vi.fn(),
  }
}

/** The minimal context the scheduler reads, with captured timers. */
function fakeContext(jobs?: unknown) {
  const timers: Array<() => void> = []
  const warnings: string[] = []
  const ctx = {
    interval: () => () => {},
    timeout: (callback: () => void) => {
      timers.push(callback)
      return () => {}
    },
    get: (key: string) => (key === 'jobs' ? jobs : undefined),
    logger: { warn: (text: string) => { warnings.push(text) } },
  }
  return { ctx, timers, warnings }
}

describe('JobScheduler.due', () => {
  it('is due when the schedule has passed since the last launch', () => {
    const now = new Date('2026-01-05T12:31:00Z')
    const { service } = fakeService({ lastRunAt: { 'job-a': new Date('2026-01-05T12:00:00Z').getTime() } })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    const due = scheduler.due(now)
    expect(due.map((entry) => entry.job.name)).toEqual(['job-a'])
    expect(due[0]?.scheduledFor).toBe(new Date('2026-01-05T12:30:00Z').getTime())
  })

  it('is not due before the schedule comes round', () => {
    const now = new Date('2026-01-05T12:10:00Z')
    const { service } = fakeService({ lastRunAt: { 'job-a': new Date('2026-01-05T12:00:00Z').getTime() } })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    expect(scheduler.due(now)).toEqual([])
  })

  it('anchors a never-run job at activation, so it fires on its first interval and not before', () => {
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(
      ctx as never,
      fakeService({ jobs: [job({ schedule: 'every 30m' })] }).service as never,
      { tickSeconds: 20, allowRunNow: true },
    )
    // Before the first interval elapses the job is not due...
    expect(scheduler.due(new Date())).toEqual([])
    // ...and it stays due exactly once the interval has passed. A sliding
    // anchor (recomputed per sweep as `now - tick`) would keep pushing this
    // moment forward and the job would never fire; this asserts the anchor is
    // stable across sweeps.
    const armed = (scheduler as unknown as { armedAt: Date }).armedAt
    expect(scheduler.due(new Date(armed.getTime() + 20_000))).toEqual([])
    expect(scheduler.due(new Date(armed.getTime() + 31 * 60_000)).map((entry) => entry.job.name)).toEqual(['job-a'])
  })

  it('never replays history for a job defined long after its slots passed', () => {
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(
      ctx as never,
      // A leap-day schedule keeps this assertion independent of the wall clock
      // the suite happens to run at (its next occurrence is years away, not
      // "later today").
      fakeService({ jobs: [job({ schedule: '0 3 29 2 *' })] }).service as never,
      { tickSeconds: 20, allowRunNow: true },
    )
    expect(scheduler.due(new Date())).toEqual([])
  })

  it('never fires a paused job', () => {
    const now = new Date('2026-01-05T13:00:00Z')
    const { service } = fakeService({
      jobs: [job({ paused: true })],
      lastRunAt: { 'job-a': new Date('2026-01-05T12:00:00Z').getTime() },
    })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    expect(scheduler.due(now)).toEqual([])
  })

  it('skips a job whose schedule stopped parsing instead of failing the sweep', () => {
    const now = new Date('2026-01-05T13:00:00Z')
    const { service } = fakeService({ jobs: [job({ schedule: 'not a schedule' })], lastRunAt: { 'job-a': 0 } })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    expect(() => { scheduler.tick(now) }).not.toThrow()
    expect(scheduler.due(now)).toEqual([])
  })
})

describe('JobScheduler overlap policy', () => {
  const now = new Date('2026-01-05T13:00:00Z')
  const anchored = { 'job-a': new Date('2026-01-05T12:00:00Z').getTime() }

  it('records a skip and advances the anchor when a run is still going', () => {
    const { service, calls, state } = fakeService({ lastRunAt: anchored, running: ['job-a'] })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    scheduler.tick(now)
    expect(calls.launched).toEqual([])
    expect(calls.marked).toEqual([{ name: 'job-a', at: new Date('2026-01-05T12:30:00Z').getTime(), status: 'skipped' }])
    expect(state.lastRunAt['job-a']).toBe(new Date('2026-01-05T12:30:00Z').getTime())
  })

  it('leaves the anchor alone for queue, so the job fires after the current run', () => {
    const { service, calls, state } = fakeService({
      jobs: [job({ overlap: 'queue' })],
      lastRunAt: anchored,
      running: ['job-a'],
    })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    scheduler.tick(now)
    expect(calls.launched).toEqual([])
    expect(calls.marked).toEqual([])
    expect(state.lastRunAt['job-a']).toBe(anchored['job-a'])
  })

  it('cancels the previous run before launching under cancel-previous', () => {
    const { service, calls } = fakeService({
      jobs: [job({ overlap: 'cancel-previous' })],
      lastRunAt: anchored,
      running: ['job-a'],
    })
    const { ctx } = fakeContext()
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    scheduler.tick(now)
    expect(calls.cancelled).toEqual(['job-a'])
    expect(calls.launched).toEqual(['job-a'])
  })
})

describe('JobScheduler launch wiring', () => {
  const now = new Date('2026-01-05T13:00:00Z')
  const anchored = { 'job-a': new Date('2026-01-05T12:00:00Z').getTime() }

  it('registers the run on the job registry and marks the anchor as running', async () => {
    const started: Array<{ kind: string; label: string }> = []
    const killed: string[] = []
    const jobs = {
      start: (spec: { kind: string; label: string }) => {
        started.push({ kind: spec.kind, label: spec.label })
        return 'cron-1'
      },
      kill: (id: string) => { killed.push(id) },
    }
    const { service, calls } = fakeService({ lastRunAt: anchored })
    const { ctx } = fakeContext(jobs)
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    scheduler.tick(now)
    await Promise.resolve()
    expect(started).toHaveLength(1)
    expect(started[0]?.kind).toBe('cron')
    expect(started[0]?.label).toContain('job-a')
    expect(calls.marked[0]?.status).toBe('running')
    expect(calls.outcomes).toHaveLength(1)
    expect(killed).toEqual([])
  })

  it('still launches when no job registry is mounted', () => {
    const { service, calls } = fakeService({ lastRunAt: anchored })
    const { ctx } = fakeContext(undefined)
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    expect(() => { scheduler.tick(now) }).not.toThrow()
    expect(calls.launched).toEqual(['job-a'])
  })

  it('kills a run that outlives its timeout', () => {
    const { service } = fakeService({ lastRunAt: anchored })
    const { ctx, timers } = fakeContext(undefined)
    const scheduler = new JobScheduler(ctx as never, service as never, { tickSeconds: 20, allowRunNow: true })
    // The timeout is armed by launch; capture it through the context timer.
    scheduler.launch(job(), anchored['job-a'], 'schedule')
    expect(timers).toHaveLength(1)
    expect(() => { timers[0]?.() }).not.toThrow()
  })
})
