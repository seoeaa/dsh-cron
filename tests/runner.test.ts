import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunLauncher } from '../src/runner.ts'
import { listRuns, recordPathFor, runsDirFor, writeRun } from '../src/runs.ts'
import type { CronJob } from '../src/types.ts'

const dirs: string[] = []

/** A job rooted in a fresh temp workspace. */
function workspace(overrides: Partial<CronJob> = {}): { job: CronJob; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-cron-run-'))
  dirs.push(cwd)
  return {
    cwd,
    job: {
      name: 'nightly',
      schedule: '0 2 * * *',
      timezone: 'UTC',
      prompt: 'run the tests',
      cwd,
      profile: 'headless',
      overlap: 'skip',
      timeoutMin: 45,
      deliver: [{ type: 'file' }],
      source: 'project',
      file: join(cwd, 'nightly.yaml'),
      paused: false,
      running: false,
      ...overrides,
    },
  }
}

/** The launcher config a test uses. */
const CONFIG = {
  dshBin: 'dsh',
  runModule: '/opt/dsh-cron/lib/run.js',
  digestMaxChars: 2000,
  summaryMaxChars: 24000,
  summaryMaxTokens: 400,
  summaryTimeoutMs: 60000,
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RunLauncher', () => {
  it('pre-creates a running record, then reconciles what the child wrote', async () => {
    const { job, cwd } = workspace()
    const seen: { overlay: string; args: string[]; cwd: string } = { overlay: '', args: [], cwd: '' }
    const launcher = new RunLauncher({} as never, CONFIG, (bin, args, runCwd) => {
      seen.args = [bin, ...args]
      seen.cwd = runCwd
      seen.overlay = readFileSync(args[3] as string, 'utf8')
      // The real child writes the record with its own status and digest.
      const running = listRuns(cwd)[0]
      expect(running?.status).toBe('running')
      writeRun(cwd, {
        ...(running as NonNullable<typeof running>),
        status: 'completed',
        finishedAt: running?.startedAt,
        digest: 'all tests passed',
      })
      return { child: { kill: vi.fn() } as never, exit: Promise.resolve({ code: 0, signal: null }) }
    })

    const handle = launcher.launch(job, 'schedule')
    expect(launcher.running()).toEqual(['nightly'])
    const record = await handle.done

    expect(record.status).toBe('completed')
    expect(record.digest).toBe('all tests passed')
    expect(record.routine).toBe('nightly')
    expect(record.trigger).toBe('schedule')
    expect(record.exitCode).toBe(0)
    expect(record.deliveries).toEqual([{ type: 'file', ok: true }])
    expect(launcher.running()).toEqual([])

    // The child is spawned with the job's profile, a generated overlay and the prompt.
    expect(seen.args[0]).toBe('dsh')
    expect(seen.args[1]).toBe('--profile')
    expect(seen.args[2]).toBe('headless')
    expect(seen.args).toContain('--patch')
    expect(seen.args.at(-1)).toBe('run the tests')
    expect(seen.cwd).toBe(cwd)

    // The overlay is what makes a run unable to block on a prompt or nest.
    expect(seen.overlay).toContain('- id: approval')
    expect(seen.overlay).toContain('policy: never')
    expect(seen.overlay).toContain('name: "/opt/dsh-cron/lib/run.js"')
    expect(seen.overlay).toContain('task: !!js ctx.headlessStartup.task')
    expect(seen.overlay).toMatch(/^ {0,6}- id: headless-runner$/m)
    expect(seen.overlay).toContain('disabled: true')
    expect(seen.overlay).toContain('runId:')

    // The digest file lands next to the record.
    const digestPath = recordPathFor(cwd, record.runId).replace(/\.json$/, '.md')
    expect(readFileSync(digestPath, 'utf8')).toContain('all tests passed')
  })

  it('fails the run when the child never reported completion', async () => {
    const { job } = workspace()
    const launcher = new RunLauncher({} as never, CONFIG, () => ({
      child: { kill: vi.fn() } as never,
      exit: Promise.resolve({ code: 3, signal: null }),
    }))

    const record = await launcher.launch(job, 'manual').done
    expect(record.status).toBe('failed')
    expect(record.exitCode).toBe(3)
    expect(record.error).toContain('exit code 3')
    expect(record.trigger).toBe('manual')
  })

  it('reports a missing conversation node instead of failing the run', async () => {
    const { job } = workspace({ deliver: [{ type: 'file' }, { type: 'chatnode' }] })
    const launcher = new RunLauncher({} as never, CONFIG, () => ({
      child: { kill: vi.fn() } as never,
      exit: Promise.resolve({ code: 1, signal: null }),
    }))
    const record = await launcher.launch(job, 'schedule').done
    expect(record.deliveries).toEqual([
      { type: 'file', ok: true },
      { type: 'chatnode', ok: false, error: 'no conversation node is mounted (ctx.chatnode)' },
    ])
  })

  it('delivers to a mounted conversation node', async () => {
    const { job } = workspace({ deliver: [{ type: 'file' }, { type: 'chatnode' }] })
    const sent: Array<{ text: string; title?: string }> = []
    const launcher = new RunLauncher(
      { chatnode: { send: async (input: { text: string; title?: string }) => { sent.push(input) } } } as never,
      CONFIG,
      () => ({ child: { kill: vi.fn() } as never, exit: Promise.resolve({ code: 1, signal: null }) }),
    )
    const record = await launcher.launch(job, 'schedule').done
    expect(record.deliveries).toEqual([{ type: 'file', ok: true }, { type: 'chatnode', ok: true }])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.title).toContain('nightly')
  })

  it('records a timeout when the run is stopped for exceeding its budget', async () => {
    const { job } = workspace()
    let release: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
    const launcher = new RunLauncher({} as never, CONFIG, () => ({
      child: { kill: vi.fn() } as never,
      exit: new Promise((resolve) => { release = resolve }),
    }))
    const handle = launcher.launch(job, 'schedule')
    handle.kill('timeout')
    release({ code: null, signal: 'SIGTERM' })
    const record = await handle.done
    expect(record.status).toBe('timeout')
    expect(record.error).toContain('timeout')
  })

  it('keeps the run directory clean of generated overlays', async () => {
    const { job, cwd } = workspace()
    const launcher = new RunLauncher({} as never, CONFIG, () => ({
      child: { kill: vi.fn() } as never,
      exit: Promise.resolve({ code: 1, signal: null }),
    }))
    await launcher.launch(job, 'schedule').done
    const leftovers = readdirSync(runsDirFor(cwd)).filter((name) => name.endsWith('.patch.yml'))
    expect(leftovers).toEqual([])
    expect(listRuns(cwd)).toHaveLength(1)
  })
})
