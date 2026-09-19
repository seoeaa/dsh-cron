import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CronService } from '../src/service.ts'
import { writeJob, resolveDirs } from '../src/store.ts'
import { writeRun } from '../src/runs.ts'
import type { Config } from '../src/config.ts'
import type { CronSnapshot, MutationResult } from '../src/types.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A project root plus a global directory, both in a fresh temp tree. */
function tree(): { projectDir: string; globalDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cron-svc-'))
  roots.push(base)
  return { projectDir: join(base, 'project'), globalDir: join(base, 'global') }
}

/** A complete plugin configuration for one test tree. */
function configFor(treeDirs: { projectDir: string; globalDir: string }, overrides: Partial<Config> = {}): Config {
  return {
    projectDir: treeDirs.projectDir,
    globalDir: treeDirs.globalDir,
    engine: 'off',
    tickSeconds: 20,
    dshBin: 'dsh',
    defaultProfile: 'headless',
    defaultTimezone: 'UTC',
    defaultTimeoutMin: 45,
    allowRunNow: true,
    maxHistoryPerJob: 50,
    watch: false,
    digestMaxChars: 2000,
    summaryMaxChars: 24000,
    summaryMaxTokens: 400,
    summaryTimeoutMs: 60000,
    runModule: '/opt/dsh-cron/lib/run.js',
    ...overrides,
  }
}

/**
 * Mount the service on a fresh context.
 *
 * The timer plugin is mounted first because a real composition has one
 * (`inject: ['timer']`); `start()` is what a test calls when it wants a sweep.
 */
async function mount(config: Config, context?: Context): Promise<{ ctx: Context; service: CronService }> {
  const ctx = context ?? new Context()
  // A caller-supplied context may or may not carry the timer service; a real
  // profile always does, so the test supplies one when it is missing.
  if (typeof (ctx as unknown as { interval?: unknown }).interval !== 'function') await ctx.plugin(Timer)
  const service = new CronService(ctx, config)
  return { ctx, service }
}

/** A definition as the panel or a tool would save one. */
function saveBasic(service: CronService, name = 'nightly'): void {
  service.save({
    name,
    schedule: '0 2 * * *',
    prompt: 'run the tests',
    cwd: undefined,
    scope: 'project',
  })
}

describe('CronService state file location', () => {
  it('keeps durable state at the shared project path, not under the definitions directory', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    expect(service.setPaused('nightly', true)).toBe(true)

    // The path the other scheduler engine reads and writes.
    const shared = join(dirs.projectDir, '.dsh', 'routines', 'state.json')
    expect(existsSync(shared)).toBe(true)
    expect(JSON.parse(readFileSync(shared, 'utf8')).paused).toEqual(['nightly'])

    // The wrong path this service must never produce.
    expect(existsSync(join(dirs.projectDir, '.dsh', 'routines', '.dsh', 'routines', 'state.json'))).toBe(false)
  })

  it('reads a state file another engine wrote', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    service.mutateState((state) => {
      state.paused = ['nightly']
      state.lastRunAt['nightly'] = 1_760_000_000_000
      state.lastStatus['nightly'] = { status: 'failed', error: 'boom', at: 1_760_000_000_001 }
    })
    expect(service.list()[0]?.paused).toBe(true)
    expect(service.list()[0]?.lastStatus).toBe('failed')
    expect(service.list()[0]?.lastError).toBe('boom')
    expect(service.list()[0]?.lastRunAt).toBe(new Date(1_760_000_000_000).toISOString())
  })
})

describe('CronService definitions', () => {
  it('defaults a job without cwd to the project root, not the definitions directory', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    expect(service.list()[0]?.cwd).toBe(dirs.projectDir)
  })

  it('applies the configured timezone when a definition omits one', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs, { defaultTimezone: 'Europe/Moscow' }))
    saveBasic(service)
    expect(service.list()[0]?.timezone).toBe('Europe/Moscow')
  })

  it('overrides a global definition with a project one of the same name', async () => {
    const dirs = tree()
    writeJob(resolveDirs(dirs.projectDir, dirs.globalDir), {
      name: 'nightly',
      schedule: '0 3 * * *',
      prompt: 'global version',
      timezone: 'UTC',
      scope: 'global',
    })
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    const jobs = service.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.source).toBe('project')
    expect(jobs[0]?.schedule).toBe('0 2 * * *')
  })

  it('reports an unparsable definition file without losing the valid ones', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    const broken = join(dirs.projectDir, '.dsh', 'routines', 'broken.yaml')
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(broken, 'name: [unclosed\n', 'utf8')
    service.reload()
    expect(service.list().map((job) => job.name)).toEqual(['nightly'])
    expect(service.invalidFiles().map((entry) => entry.name)).toEqual(['broken'])
  })

  it('reports the next fire time in the job timezone', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    service.save({ name: 'tokyo', schedule: '0 9 * * *', timezone: 'Asia/Tokyo', prompt: 'x' })
    const next = service.list()[0]?.nextRunAt
    expect(next).toBeDefined()
    // 09:00 Tokyo is 00:00 UTC; the instant must not be the local 09:00.
    expect(new Date(next as string).getUTCHours()).toBe(0)
  })

  it('does not report a next run for a paused job', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    service.setPaused('nightly', true)
    expect(service.list()[0]?.nextRunAt).toBeUndefined()
  })
})

describe('CronService engine ownership', () => {
  it('owns scheduling when nothing else does', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs, { engine: 'auto' }))
    service.start()
    expect(service.engine().mode).toBe('own')
  })

  it('stands down when another scheduler is mounted', async () => {
    const dirs = tree()
    const ctx = new Context()
    ctx.provide('routinesScheduler' as never, {} as never)
    const { service } = await mount(configFor(dirs, { engine: 'auto' }), ctx)
    service.start()
    expect(service.engine()).toMatchObject({ mode: 'companion', owner: 'routinesScheduler' })
  })

  it('honours an explicit own, and an explicit off', async () => {
    const dirs = tree()
    // One context per service: cordis refuses a second registration of the
    // same service key on one context, which is exactly the guard wanted here.
    const forcedCtx = new Context()
    forcedCtx.provide('routinesScheduler' as never, {} as never)
    const forced = await mount(configFor(dirs, { engine: 'own' }), forcedCtx)
    forced.service.start()
    expect(forced.service.engine().mode).toBe('own')

    const offCtx = new Context()
    offCtx.provide('routinesScheduler' as never, {} as never)
    const off = await mount(configFor(dirs, { engine: 'off' }), offCtx)
    off.service.start()
    expect(off.service.engine().mode).toBe('companion')
  })
})

describe('CronService targets and snapshot', () => {
  it('always offers the file digest and reports a missing conversation node as unavailable', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    const targets = service.targets()
    expect(targets.find((target) => target.id === 'file')?.available).toBe(true)
    expect(targets.find((target) => target.id === 'chatnode')?.available).toBe(false)
  })

  it('marks the conversation node available when one is mounted', async () => {
    const dirs = tree()
    const ctx = new Context()
    ctx.provide('chatnode' as never, { send: async () => {} } as never)
    const { service } = await mount(configFor(dirs), ctx)
    expect(service.targets().find((target) => target.id === 'chatnode')?.available).toBe(true)
  })

  it('reports the directories it watches and the plugin identity', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    const snapshot = service.snapshot()
    expect(snapshot.dirs).toEqual(resolveDirs(dirs.projectDir, dirs.globalDir))
    expect(snapshot.plugin).toBe('dsh-cron')
    expect(snapshot.version).toBe('0.1.0')
    expect(Date.parse(snapshot.now)).not.toBeNaN()
  })
})

describe('CronService remote face', () => {
  const decode = <T,>(text: string): T => JSON.parse(text) as T

  it('answers status with the whole snapshot', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    const snapshot = decode<CronSnapshot>(service.status())
    expect(snapshot.jobs.map((job) => job.name)).toEqual(['nightly'])
    expect(snapshot.engine.mode).toBe('companion') // engine: off in the fixture
  })

  it('saves through mutate and returns the refreshed snapshot', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    const result = decode<MutationResult>(await service.mutate(JSON.stringify({
      action: 'save',
      job: { name: 'fresh', schedule: 'every 30m', prompt: 'check things' },
    })))
    expect(result.ok).toBe(true)
    expect(result.snapshot?.jobs.map((job) => job.name)).toEqual(['fresh'])
  })

  it('reports a bad request and a missing job instead of throwing', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    expect(decode<MutationResult>(await service.mutate('{not json')).ok).toBe(false)
    expect(decode<MutationResult>(await service.mutate(JSON.stringify({ action: 'remove', name: 'ghost' }))).ok).toBe(false)
    expect(decode<MutationResult>(await service.mutate(JSON.stringify({ action: 'nonsense' }))).ok).toBe(false)
  })

  it('refuses a manual run when the operator disabled it', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs, { allowRunNow: false }))
    saveBasic(service)
    const result = decode<MutationResult>(await service.mutate(JSON.stringify({ action: 'run', name: 'nightly' })))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('disabled')
  })

  it('previews a valid and an invalid schedule', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs, { defaultTimezone: 'Europe/Moscow' }))
    const good = decode<{ ok: boolean; description: string; nextRuns: string[] }>(service.preview('0 9 * * 1-5'))
    expect(good.ok).toBe(true)
    expect(good.description).toContain('weekday')
    expect(good.nextRuns).toHaveLength(3)
    const bad = decode<{ ok: boolean; error?: string }>(service.preview('every fortnight'))
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
  })

  it('serves run history of one job', async () => {
    const dirs = tree()
    const { service } = await mount(configFor(dirs))
    saveBasic(service)
    writeRun(dirs.projectDir, {
      runId: 'nightly-1',
      routine: 'nightly',
      profile: 'headless',
      cwd: dirs.projectDir,
      status: 'completed',
      trigger: 'schedule',
      startedAt: Date.now(),
      digest: 'done',
    })
    const runs = decode<Array<{ runId: string }>>(service.history('nightly'))
    expect(runs.map((run) => run.runId)).toEqual(['nightly-1'])
    expect(decode<unknown[]>(service.history('ghost'))).toEqual([])
  })
})
