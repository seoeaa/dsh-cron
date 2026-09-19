/**
 * dsh-cron — unit tests for src/state.ts.
 *
 * Everything runs inside a fresh `os.tmpdir()` fixture; nothing under the
 * user's real `~/.dsh` is read, written or removed.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_STATE, loadState, saveState, statePathFor, type SchedulerState } from '../src/state.ts'

/** Fresh project directory per test. */
let project = ''

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-cron-state-'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/** Write raw bytes to the state path, creating its directory. */
function writeRawState(text: string): void {
  const path = statePathFor(project)
  mkdirSync(join(project, '.dsh', 'routines'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

describe('statePathFor', () => {
  it('names the shared compatibility path', () => {
    expect(statePathFor('/p')).toBe(join('/p', '.dsh', 'routines', 'state.json'))
  })
})

describe('loadState', () => {
  it('returns an empty state when nothing was ever written', () => {
    expect(loadState(project)).toEqual(EMPTY_STATE)
  })

  it('returns a fresh object, so a caller may mutate what it loaded', () => {
    const first = loadState(project)
    expect(first).not.toBe(EMPTY_STATE)
    first.paused.push('x')
    first.lastRunAt.x = Date.now()
    expect(loadState(project)).toEqual(EMPTY_STATE)
    expect(EMPTY_STATE.paused).toEqual([])
    expect(EMPTY_STATE.lastRunAt).toEqual({})
  })

  it('falls back to an empty state for unparsable JSON', () => {
    writeRawState('{ this is not json')
    expect(loadState(project)).toEqual(EMPTY_STATE)
  })

  it('falls back to an empty state for JSON that is not an object', () => {
    for (const text of ['[]', 'null', '"paused"', '42']) {
      writeRawState(text)
      expect(loadState(project)).toEqual(EMPTY_STATE)
    }
  })

  it('reads a file written by the other plugin, which has no lastStatus', () => {
    writeRawState('{\n  "paused": ["beget-ticket-check"],\n  "lastRunAt": { "beget-ticket-check": 1726000000000 }\n}\n')
    expect(loadState(project)).toEqual({
      paused: ['beget-ticket-check'],
      lastRunAt: { 'beget-ticket-check': 1726000000000 },
      lastStatus: {},
    })
  })

  it('ignores unknown top-level keys', () => {
    writeRawState('{"paused":[],"lastRunAt":{},"lastStatus":{},"somethingElse":{"a":1}}')
    expect(loadState(project)).toEqual(EMPTY_STATE)
  })

  it('drops malformed entries field by field', () => {
    writeRawState(
      '{"paused":[1,"ok",null,{},["nested"]],'
      + '"lastRunAt":{"good":5,"string":"x","null":null,"array":[],"bool":true},'
      + '"lastStatus":{"good":{"status":"failed","error":"boom","at":7}}}',
    )
    expect(loadState(project)).toEqual({
      paused: ['ok'],
      lastRunAt: { good: 5 },
      lastStatus: { good: { status: 'failed', error: 'boom', at: 7 } },
    })
  })

  it('drops status records that cannot describe a run', () => {
    writeRawState(
      '{"lastStatus":{'
      + '"unknownStatus":{"status":"exploded","at":1},'
      + '"noTime":{"status":"completed"},'
      + '"badTime":{"status":"completed","at":"yesterday"},'
      + '"notAnObject":"completed",'
      + '"noError":{"status":"timeout","at":2,"error":9},'
      + '"plain":{"status":"skipped","at":3}}}',
    )
    expect(loadState(project).lastStatus).toEqual({
      noError: { status: 'timeout', at: 2 },
      plain: { status: 'skipped', at: 3 },
    })
  })

  it('treats a wrong-typed paused or lastRunAt as absent', () => {
    writeRawState('{"paused":"all","lastRunAt":[1,2]}')
    expect(loadState(project)).toEqual(EMPTY_STATE)
  })
})

describe('saveState', () => {
  it('round-trips every field, including our additive lastStatus', () => {
    const state: SchedulerState = {
      paused: ['kwork-new-projects'],
      lastRunAt: { 'kwork-new-projects': 1726000000000 },
      lastStatus: {
        'kwork-new-projects': { status: 'completed', at: 1726000001000 },
        'beget-ticket-check': { status: 'failed', error: 'exit 1', at: 1726000002000 },
      },
    }
    saveState(project, state)
    expect(loadState(project)).toEqual(state)
  })

  it('creates the directory, and writes pretty JSON with a trailing newline', () => {
    const state: SchedulerState = { paused: [], lastRunAt: {}, lastStatus: {} }
    saveState(project, state)
    const text = readFileSync(statePathFor(project), 'utf8')
    expect(text).toBe(`${JSON.stringify(state, null, 2)}\n`)
    expect(JSON.parse(text)).toEqual(state)
  })

  it('leaves no temp file behind and republishes the whole file', () => {
    const dir = join(project, '.dsh', 'routines')
    saveState(project, { paused: ['a'], lastRunAt: { a: 1 }, lastStatus: {} })
    saveState(project, { paused: ['b'], lastRunAt: { b: 2 }, lastStatus: {} })
    expect(readdirSync(dir)).toEqual(['state.json'])
    expect(loadState(project)).toEqual({ paused: ['b'], lastRunAt: { b: 2 }, lastStatus: {} })
  })

  it('overwrites a corrupt file with a readable one', () => {
    writeRawState('{ broken')
    expect(loadState(project)).toEqual(EMPTY_STATE)
    saveState(project, { paused: ['a'], lastRunAt: {}, lastStatus: {} })
    expect(loadState(project).paused).toEqual(['a'])
  })
})
