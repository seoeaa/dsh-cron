/**
 * dsh-cron — unit tests for src/runs.ts.
 *
 * Every fixture lives in a fresh `os.tmpdir()` directory; the user's real
 * `~/.dsh` tree is never touched.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listRuns, pruneRuns, readRun, recordPathFor, runsDirFor, writeRun } from '../src/runs.ts'
import type { RunRecord } from '../src/types.ts'

/** Fresh run working directory per test. */
let cwd = ''

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'dsh-cron-runs-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

/** Build a complete record, overriding only what a test cares about. */
function makeRecord(overrides: Partial<RunRecord> & { runId: string; startedAt: number }): RunRecord {
  return {
    routine: 'beget-ticket-check',
    profile: 'web',
    cwd,
    status: 'completed',
    trigger: 'schedule',
    ...overrides,
  }
}

/** Write raw text as `<name>.json` in the runs directory, bypassing validation. */
function writeRawRecord(name: string, text: string): string {
  const dir = runsDirFor(cwd)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)
  writeFileSync(file, text, 'utf8')
  return file
}

describe('paths', () => {
  it('places records under the run cwd, the way the other plugin does', () => {
    expect(runsDirFor('/w')).toBe(join('/w', '.dsh', 'routines', 'runs'))
    expect(recordPathFor('/w', 'run-1')).toBe(join('/w', '.dsh', 'routines', 'runs', 'run-1.json'))
  })

  it('refuses a run id that could address another directory', () => {
    for (const runId of ['../escape', 'a/b', 'a\\b', '', '.', '..', '.hidden'])
      expect(() => recordPathFor(cwd, runId)).toThrow(/invalid run id/)
    for (const runId of ['run-1726000000000-ab12', 'beget-ticket-check-20260920T0900-a1b2c3d4', 'x'])
      expect(recordPathFor(cwd, runId)).toContain(`${runId}.json`)
  })
})

describe('writeRun and readRun', () => {
  it('round-trips the record and writes pretty JSON with a trailing newline', () => {
    const record = makeRecord({
      runId: 'run-1',
      startedAt: 1726000000000,
      finishedAt: 1726000042000,
      durationMs: 42000,
      exitCode: 0,
      sessionId: 'sess-1',
      digest: 'Checked the ticket; still waiting on the domain department.',
      denied: [{ toolName: 'write', reason: 'unattended' }],
      deliveries: [{ type: 'file', ok: true }],
    })
    writeRun(cwd, record)
    expect(readRun(cwd, 'run-1')).toEqual(record)
    const text = readFileSync(recordPathFor(cwd, 'run-1'), 'utf8')
    expect(text).toBe(`${JSON.stringify(record, null, 2)}\n`)
  })

  it('returns undefined for a missing, unparsable or unusable record', () => {
    expect(readRun(cwd, 'nope')).toBeUndefined()
    writeRawRecord('broken', '{ not json')
    expect(readRun(cwd, 'broken')).toBeUndefined()
    writeRawRecord('unusable', '{"runId":"unusable","routine":"r"}')
    expect(readRun(cwd, 'unusable')).toBeUndefined()
    expect(readRun(cwd, '../escape')).toBeUndefined()
  })

  it('never invents durationMs, and keeps an explicit zero', () => {
    writeRun(cwd, makeRecord({ runId: 'run-open', startedAt: 1726000000000, status: 'running' }))
    expect(readRun(cwd, 'run-open')?.durationMs).toBeUndefined()
    expect(readFileSync(recordPathFor(cwd, 'run-open'), 'utf8')).not.toContain('durationMs')

    writeRun(cwd, makeRecord({ runId: 'run-zero', startedAt: 1726000000001, durationMs: 0 }))
    expect(readRun(cwd, 'run-zero')?.durationMs).toBe(0)
  })

  it('drops junk fields and wrong-typed values instead of leaking them', () => {
    writeRawRecord(
      'junk',
      JSON.stringify({
        runId: 'junk',
        routine: 'r',
        status: 'skipped',
        startedAt: 5,
        nonsense: { a: 1 },
        durationMs: 'fast',
        denied: [{ nope: true }, { toolName: 'bash' }],
        deliveries: [{ type: 'telegram', ok: true }, { type: 'file', ok: true }],
      }),
    )
    const record = readRun(cwd, 'junk')
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('nonsense')
    expect(record?.durationMs).toBeUndefined()
    expect(record?.denied).toEqual([{ toolName: 'bash' }])
    expect(record?.deliveries).toEqual([{ type: 'file', ok: true }])
    // The file's own location is the truth for the fields it omitted.
    expect(record?.cwd).toBe(cwd)
    expect(record?.profile).toBe('')
    expect(record?.trigger).toBe('schedule')
  })

  it('writes the digest next to the record', () => {
    writeRun(cwd, makeRecord({ runId: 'run-md', startedAt: 1, digest: 'all good' }))
    expect(existsSync(join(runsDirFor(cwd), 'run-md.md'))).toBe(true)
  })

  it('survives a digest file it cannot write', () => {
    // A directory where the digest file belongs makes the write fail; the
    // authoritative JSON record must still land, and nothing may throw.
    mkdirSync(join(runsDirFor(cwd), 'run-clash.md'), { recursive: true })
    expect(() => {
      writeRun(cwd, makeRecord({ runId: 'run-clash', startedAt: 9, digest: 'x' }))
    }).not.toThrow()
    expect(readRun(cwd, 'run-clash')?.digest).toBe('x')
  })
})

describe('digest markdown', () => {
  it('lists every present fact, then the prose', () => {
    const startedAt = Date.UTC(2026, 8, 20, 6, 0, 0)
    const finishedAt = Date.UTC(2026, 8, 20, 6, 0, 42)
    writeRun(cwd, makeRecord({
      runId: 'run-digest',
      routine: 'kwork-new-projects',
      startedAt,
      finishedAt,
      durationMs: 42000,
      sessionId: 'sess-42',
      digest: 'New projects found:\n1. parser job',
    }))
    const md = readFileSync(join(runsDirFor(cwd), 'run-digest.md'), 'utf8')
    expect(md).toBe([
      '# dsh-cron digest — kwork-new-projects',
      '- run: run-digest',
      '- status: completed',
      '- session: sess-42',
      `- started: ${new Date(startedAt).toISOString()}`,
      `- finished: ${new Date(finishedAt).toISOString()}`,
      '- duration: 42000 ms',
      '',
      'New projects found:',
      '1. parser job',
      '',
    ].join('\n'))
  })

  it('omits the lines a run has no value for', () => {
    writeRun(cwd, makeRecord({ runId: 'run-bare', startedAt: 1726000000000, status: 'running' }))
    const md = readFileSync(join(runsDirFor(cwd), 'run-bare.md'), 'utf8')
    expect(md).toContain('# dsh-cron digest — beget-ticket-check\n- run: run-bare\n- status: running\n')
    expect(md).not.toContain('- session:')
    expect(md).not.toContain('- finished:')
    expect(md).not.toContain('- duration:')
  })
})

describe('listRuns', () => {
  it('returns nothing for a directory that does not exist yet', () => {
    expect(listRuns(cwd)).toEqual([])
  })

  it('orders newest first, breaking ties by run id', () => {
    writeRun(cwd, makeRecord({ runId: 'b', startedAt: 30 }))
    writeRun(cwd, makeRecord({ runId: 'a', startedAt: 30 }))
    writeRun(cwd, makeRecord({ runId: 'old', startedAt: 10 }))
    writeRun(cwd, makeRecord({ runId: 'new', startedAt: 40 }))
    expect(listRuns(cwd).map((record) => record.runId)).toEqual(['new', 'a', 'b', 'old'])
  })

  it('skips files it cannot parse or trust', () => {
    writeRun(cwd, makeRecord({ runId: 'good', startedAt: 20 }))
    writeRawRecord('broken', '{ not json')
    writeRawRecord('array', '[]')
    writeRawRecord('partial', '{"runId":"partial"}')
    writeRawRecord('badStatus', '{"runId":"badStatus","routine":"r","status":"exploded","startedAt":1}')
    writeRawRecord('badStart', '{"runId":"badStart","routine":"r","status":"completed","startedAt":"1"}')
    expect(listRuns(cwd).map((record) => record.runId)).toEqual(['good'])
  })

  it('honours a limit, and ignores a nonsensical one', () => {
    for (const startedAt of [10, 20, 30, 40])
      writeRun(cwd, makeRecord({ runId: `run-${startedAt}`, startedAt }))
    expect(listRuns(cwd, 2).map((record) => record.startedAt)).toEqual([40, 30])
    expect(listRuns(cwd, 99)).toHaveLength(4)
    expect(listRuns(cwd, 0)).toHaveLength(4)
    expect(listRuns(cwd, Number.NaN)).toHaveLength(4)
  })
})

describe('pruneRuns', () => {
  it('keeps the newest keep records, with their digests', () => {
    for (const startedAt of [10, 20, 30, 40])
      writeRun(cwd, makeRecord({ runId: `run-${startedAt}`, startedAt }))
    pruneRuns(cwd, 2)
    expect(listRuns(cwd).map((record) => record.startedAt)).toEqual([40, 30])
    expect(readdirSync(runsDirFor(cwd)).sort()).toEqual(['run-30.json', 'run-30.md', 'run-40.json', 'run-40.md'])
    expect(existsSync(recordPathFor(cwd, 'run-10'))).toBe(false)
    expect(existsSync(join(runsDirFor(cwd), 'run-10.md'))).toBe(false)
  })

  it('keeps a file it cannot parse', () => {
    writeRun(cwd, makeRecord({ runId: 'new', startedAt: 40 }))
    writeRawRecord('broken', '{ not json')
    pruneRuns(cwd, 0)
    expect(existsSync(recordPathFor(cwd, 'new'))).toBe(false)
    expect(existsSync(join(runsDirFor(cwd), 'broken.json'))).toBe(true)
  })

  it('does nothing when there is nothing to prune, and never throws', () => {
    writeRun(cwd, makeRecord({ runId: 'only', startedAt: 1 }))
    pruneRuns(cwd, 5)
    pruneRuns(cwd, 1)
    pruneRuns(cwd, Number.NaN)
    pruneRuns(cwd, -1)
    expect(existsSync(recordPathFor(cwd, 'only'))).toBe(true)
    expect(() => pruneRuns(join(cwd, 'does-not-exist'), 1)).not.toThrow()
  })
})
