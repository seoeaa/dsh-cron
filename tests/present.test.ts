import { describe, expect, it } from 'vitest'
import {
  dayLabelKey,
  formatAbsoluteTime,
  formatDayDate,
  formatDuration,
  groupRunsByDay,
  overlapLabelKey,
  relativeTime,
  runStatusLabelKey,
  runStatusTone,
  sourceLabelKey,
  truncatePath,
  validateJobName,
} from '../src/client/present.ts'
import type { RunRecord } from '../src/types.ts'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: 'run-1',
    routine: 'demo',
    profile: 'headless',
    cwd: '/tmp/demo',
    status: 'completed',
    trigger: 'schedule',
    startedAt: new Date(2026, 6, 21, 9, 30).getTime(),
    ...overrides,
  }
}

describe('runStatusTone', () => {
  it('maps every terminal and live status to a dot tone', () => {
    expect(runStatusTone('completed')).toBe('done')
    expect(runStatusTone('running')).toBe('ongoing')
    expect(runStatusTone('failed')).toBe('error')
    expect(runStatusTone('killed')).toBe('warning')
    expect(runStatusTone('timeout')).toBe('warning')
    expect(runStatusTone('skipped')).toBe('idle')
  })
})

describe('runStatusLabelKey', () => {
  it('returns the locale key suffix for every status', () => {
    expect(runStatusLabelKey('completed')).toBe('statusCompleted')
    expect(runStatusLabelKey('running')).toBe('statusRunning')
    expect(runStatusLabelKey('failed')).toBe('statusFailed')
    expect(runStatusLabelKey('killed')).toBe('statusKilled')
    expect(runStatusLabelKey('timeout')).toBe('statusTimeout')
    expect(runStatusLabelKey('skipped')).toBe('statusSkipped')
  })
})

describe('overlapLabelKey / sourceLabelKey', () => {
  it('returns the localized key for each policy and scope', () => {
    expect(overlapLabelKey('skip')).toBe('overlapSkip')
    expect(overlapLabelKey('queue')).toBe('overlapQueue')
    expect(overlapLabelKey('cancel-previous')).toBe('overlapCancel')
    expect(sourceLabelKey('project')).toBe('sourceProject')
    expect(sourceLabelKey('global')).toBe('sourceGlobal')
  })
})

describe('formatDuration', () => {
  it('returns null for missing durations', () => {
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
  })

  it('renders compact symbol durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(999)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(4 * MINUTE + 5_000)).toBe('4m 05s')
    expect(formatDuration(HOUR + 2 * MINUTE + 3_000)).toBe('1h 02m 03s')
  })
})

describe('relativeTime', () => {
  const now = new Date(2026, 6, 21, 12, 0, 0).getTime()

  it('is "now" inside the 45s window in both directions', () => {
    expect(relativeTime(now + 20_000, now)).toEqual({ direction: 'now', time: '' })
    expect(relativeTime(now - 44_000, now)).toEqual({ direction: 'now', time: '' })
  })

  it('uses seconds just beyond the now window', () => {
    expect(relativeTime(now + 50_000, now)).toEqual({ direction: 'in', time: '50s' })
    expect(relativeTime(now - 89_000, now)).toEqual({ direction: 'ago', time: '89s' })
  })

  it('clamps to at least one unit so it never says 0', () => {
    expect(relativeTime(now + 46_000, now)).toEqual({ direction: 'in', time: '46s' })
    expect(relativeTime(now + 91 * MINUTE, now)).toEqual({ direction: 'in', time: '1h' })
  })

  it('uses minutes, hours and days with increasing distance', () => {
    expect(relativeTime(now + 5 * MINUTE, now)).toEqual({ direction: 'in', time: '5m' })
    expect(relativeTime(now - 12 * MINUTE, now)).toEqual({ direction: 'ago', time: '12m' })
    expect(relativeTime(now + 2 * HOUR, now)).toEqual({ direction: 'in', time: '2h' })
    expect(relativeTime(now - 47 * HOUR, now)).toEqual({ direction: 'ago', time: '47h' })
    expect(relativeTime(now + 3 * DAY, now)).toEqual({ direction: 'in', time: '3d' })
    expect(relativeTime(now - 400 * DAY, now)).toEqual({ direction: 'ago', time: '400d' })
  })
})

describe('formatAbsoluteTime / formatDayDate', () => {
  it('renders stable numeric patterns', () => {
    const ms = new Date(2026, 6, 21, 9, 5).getTime()
    expect(formatAbsoluteTime(ms)).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/)
    expect(formatDayDate(ms)).toMatch(/^\d{1,2} \w{3} \d{4}$/)
  })
})

describe('dayLabelKey', () => {
  const now = new Date(2026, 6, 21, 18, 0).getTime()
  const today = new Date(2026, 6, 21, 0, 0).getTime()
  const yesterday = new Date(2026, 6, 20, 0, 0).getTime()
  const older = new Date(2026, 6, 19, 0, 0).getTime()

  it('labels today and yesterday relative to the reference clock', () => {
    expect(dayLabelKey(today, now)).toBe('today')
    expect(dayLabelKey(yesterday, now)).toBe('yesterday')
    expect(dayLabelKey(older, now)).toBeNull()
  })
})

describe('truncatePath', () => {
  it('keeps short paths untouched', () => {
    expect(truncatePath('/short/path', 48)).toBe('/short/path')
  })

  it('keeps both ends of long paths', () => {
    const path = '/very/long/path/that/needs/to/be/truncated/somewhere/deep/file.yaml'
    const result = truncatePath(path, 48)
    expect(result.length).toBe(48)
    expect(result).toContain('…')
    expect(result.startsWith('/very/long/path')).toBe(true)
    expect(result.endsWith('file.yaml')).toBe(true)
  })
})

describe('groupRunsByDay', () => {
  it('groups runs by local day, newest group and newest run first', () => {
    const day1 = new Date(2026, 6, 21, 9, 0).getTime()
    const day1Later = new Date(2026, 6, 21, 22, 0).getTime()
    const day2 = new Date(2026, 6, 20, 8, 0).getTime()
    const groups = groupRunsByDay([
      run({ runId: 'a', startedAt: day1 }),
      run({ runId: 'b', startedAt: day2 }),
      run({ runId: 'c', startedAt: day1Later }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.key).toBe('2026-07-21')
    expect(groups[0]?.runs.map(item => item.runId)).toEqual(['c', 'a'])
    expect(groups[1]?.key).toBe('2026-07-20')
    expect(groups[1]?.runs.map(item => item.runId)).toEqual(['b'])
  })
})

describe('validateJobName', () => {
  it('accepts lowercase names with dashes', () => {
    expect(validateJobName('daily-digest')).toBeNull()
    expect(validateJobName('a1')).toBeNull()
  })

  it('rejects empty, uppercase, underscores, spaces and leading dashes', () => {
    expect(validateJobName('')).toBe('pattern')
    expect(validateJobName('Daily')).toBe('pattern')
    expect(validateJobName('daily_digest')).toBe('pattern')
    expect(validateJobName('daily digest')).toBe('pattern')
    expect(validateJobName('-daily')).toBe('pattern')
  })

  it('rejects names longer than 64 characters', () => {
    expect(validateJobName('a'.repeat(65))).toBe('length')
    expect(validateJobName('a'.repeat(64))).toBeNull()
  })
})
