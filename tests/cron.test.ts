import { describe, expect, it } from 'vitest'
import {
  ScheduleError,
  describeSchedule,
  nextRunAfter,
  nextRuns,
  normalizeSchedule,
  parseEvery,
  parseSchedule,
} from '../src/cron.ts'

describe('parseSchedule / normalizeSchedule', () => {
  it('parses a bare wildcard schedule', () => {
    const parsed = parseSchedule('* * * * *')
    expect(parsed.minute.size).toBe(60)
    expect(parsed.hour.size).toBe(24)
    expect(parsed.dayOfMonth.size).toBe(31)
    expect(parsed.month.size).toBe(12)
    expect(parsed.dayOfWeek.size).toBe(7)
    expect(parsed.domRestricted).toBe(false)
    expect(parsed.dowRestricted).toBe(false)
    expect(parsed.normalized).toBe('* * * * *')
  })

  it('treats ? as * in every field', () => {
    expect(normalizeSchedule('? ? ? ? ?')).toBe('* * * * *')
    expect(parseSchedule('0 0 ? * ?').domRestricted).toBe(false)
    expect(parseSchedule('0 0 ? * ?').dowRestricted).toBe(false)
  })

  it('parses lists, ranges, steps and three-letter names', () => {
    const parsed = parseSchedule('1,15,30 9-17/2 * JAN MON-FRI')
    expect(Array.from(parsed.minute).sort((a, b) => a - b)).toEqual([1, 15, 30])
    expect(Array.from(parsed.hour).sort((a, b) => a - b)).toEqual([9, 11, 13, 15, 17])
    expect(Array.from(parsed.month)).toEqual([1])
    expect(Array.from(parsed.dayOfWeek).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(parsed.dowRestricted).toBe(true)
    expect(parsed.normalized).toBe('1,15,30 9-17/2 * 1 1-5')
  })

  it('maps day-of-week 0 and 7 both to Sunday', () => {
    const viaZero = parseSchedule('0 0 * * 0')
    const viaSeven = parseSchedule('0 0 * * 7')
    expect(viaZero.dayOfWeek.has(0)).toBe(true)
    expect(viaSeven.dayOfWeek.has(0)).toBe(true)
    expect(viaSeven.dowRestricted).toBe(true)
    expect(viaSeven.normalized).toBe('0 0 * * 7')
  })

  it('normalizes whitespace and collapses case', () => {
    expect(normalizeSchedule('  0   9  *  *  MON-FRI ')).toBe('0 9 * * 1-5')
    expect(normalizeSchedule('*/15 * * * *')).toBe('*/15 * * * *')
  })

  it('expands macros to five fields', () => {
    expect(normalizeSchedule('@hourly')).toBe('0 * * * *')
    expect(normalizeSchedule('@daily')).toBe('0 0 * * *')
    expect(normalizeSchedule('@midnight')).toBe('0 0 * * *')
    expect(normalizeSchedule('@weekly')).toBe('0 0 * * 0')
    expect(normalizeSchedule('@monthly')).toBe('0 0 1 * *')
    expect(normalizeSchedule('@yearly')).toBe('0 0 1 1 *')
    expect(normalizeSchedule('@annually')).toBe('0 0 1 1 *')
    expect(normalizeSchedule('@HOURLY')).toBe('0 * * * *')
  })

  it('marks macro day restrictions', () => {
    const weekly = parseSchedule('@weekly')
    expect(weekly.dayOfWeek.has(0)).toBe(true)
    expect(weekly.dowRestricted).toBe(true)
    const monthly = parseSchedule('@monthly')
    expect(monthly.dayOfMonth.has(1)).toBe(true)
    expect(monthly.domRestricted).toBe(true)
  })

  it('accepts interval forms', () => {
    expect(parseSchedule('every 30m').normalized).toBe('every 30m')
    expect(parseSchedule('EVERY 4H').normalized).toBe('every 4h')
    expect(parseSchedule('every 2h30m').domRestricted).toBe(false)
  })
})

describe('ScheduleError branches', () => {
  it('rejects six-field (seconds) expressions with a usable message', () => {
    expect(() => parseSchedule('*/5 * * * * *')).toThrow(ScheduleError)
    expect(() => parseSchedule('*/5 * * * * *')).toThrow(/seconds are not supported/)
  })

  it('rejects out-of-range values with the field name', () => {
    expect(() => parseSchedule('60 * * * *')).toThrow(/minute 60 is out of range/)
    expect(() => parseSchedule('0 24 * * *')).toThrow(/hour 24 is out of range/)
    expect(() => parseSchedule('0 0 1 13 *')).toThrow(/month 13 is out of range/)
    expect(() => parseSchedule('0 0 32 * *')).toThrow(/day-of-month 32 is out of range/)
    expect(() => parseSchedule('0 0 * * 8')).toThrow(/day-of-week 8 is out of range/)
  })

  it('rejects inverted ranges', () => {
    expect(() => parseSchedule('0 0 * * 5-1')).toThrow(ScheduleError)
    expect(() => parseSchedule('0 0 * * 5-1')).toThrow(/inverted range 5-1/)
  })

  it('rejects unknown macros', () => {
    expect(() => parseSchedule('@reboot')).toThrow(ScheduleError)
    expect(() => parseSchedule('@reboot')).toThrow(/unknown macro/)
  })

  it('rejects empty expressions', () => {
    expect(() => parseSchedule('')).toThrow(ScheduleError)
    expect(() => parseSchedule('   ')).toThrow(ScheduleError)
    expect(() => parseSchedule('')).toThrow(/empty/)
  })

  it('rejects unknown field syntax', () => {
    expect(() => parseSchedule('a-b-c * * * *')).toThrow(ScheduleError)
    expect(() => parseSchedule('a-b-c * * * *')).toThrow(/invalid minute field/)
  })

  it('rejects wrong field counts', () => {
    expect(() => parseSchedule('* * * *')).toThrow(/got 4/)
    expect(() => parseSchedule('* * * * * * *')).toThrow(/got 7/)
  })
})

describe('interval forms and parseEvery', () => {
  it('returns minutes for interval expressions', () => {
    expect(parseEvery('every 30m')).toBe(30)
    expect(parseEvery('every 4h')).toBe(240)
    expect(parseEvery('every 90s')).toBe(2)
    expect(parseEvery('every 2h30m')).toBe(150)
    expect(parseEvery('EVERY 30M')).toBe(30)
  })

  it('floors sub-minute intervals at one minute', () => {
    expect(parseEvery('every 30s')).toBe(1)
    expect(parseEvery('every 1s')).toBe(1)
  })

  it('returns undefined for non-interval forms', () => {
    expect(parseEvery('0 9 * * *')).toBeUndefined()
    expect(parseEvery('@daily')).toBeUndefined()
    expect(parseEvery('every 10x')).toBeUndefined()
    expect(parseEvery('every')).toBeUndefined()
    expect(parseEvery('')).toBeUndefined()
  })

  it('rejects a zero-length interval', () => {
    expect(() => parseEvery('every 0m')).toThrow(ScheduleError)
    expect(() => parseEvery('every 0m')).toThrow(/positive/)
  })

  it('nextRunAfter adds the interval exactly', () => {
    expect(
      nextRunAfter('every 4h', 'UTC', new Date('2026-01-01T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-01-01T04:00:00.000Z')
    expect(
      nextRunAfter('every 90s', 'UTC', new Date('2026-01-01T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-01-01T00:01:30.000Z')
  })

  it('nextRuns iterates intervals', () => {
    const runs = nextRuns('every 1h', 'UTC', new Date('2026-01-01T00:00:00.000Z'), 3)
    expect(runs.map((date) => date.toISOString())).toEqual([
      '2026-01-01T01:00:00.000Z',
      '2026-01-01T02:00:00.000Z',
      '2026-01-01T03:00:00.000Z',
    ])
  })
})

describe('nextRunAfter timezone math', () => {
  it('resolves a wall-clock time in a non-host timezone', () => {
    // 23:30Z is 08:30 in Tokyo; the next 09:00 Tokyo is 00:00Z the same day.
    const next = nextRunAfter('0 9 * * *', 'Asia/Tokyo', new Date('2026-01-04T23:30:00.000Z'))
    expect(next?.toISOString()).toBe('2026-01-05T00:00:00.000Z')
  })

  it('searches several days ahead for a leap-day schedule', () => {
    const next = nextRunAfter('0 0 29 2 *', 'UTC', new Date('2026-03-01T00:00:00.000Z'))
    expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
  })

  it('skips a wall time that does not exist during a spring-forward gap', () => {
    // Berlin jumps 02:00 → 03:00 on 2026-03-29, so 02:30 does not exist there.
    const next = nextRunAfter('30 2 * * *', 'Europe/Berlin', new Date('2026-03-28T02:00:00.000Z'))
    expect(next?.toISOString()).toBe('2026-03-30T00:30:00.000Z')
  })

  it('still fires on the day before a spring-forward gap', () => {
    const next = nextRunAfter('30 2 * * *', 'Europe/Berlin', new Date('2026-03-28T00:00:00.000Z'))
    expect(next?.toISOString()).toBe('2026-03-28T01:30:00.000Z')
  })

  it('uses the second occurrence of an ambiguous fall-back wall time', () => {
    // New York 01:30 on 2026-11-01 happens twice: 05:30Z (EDT) and 06:30Z (EST).
    const next = nextRunAfter('30 1 * * *', 'America/New_York', new Date('2026-11-01T05:45:00.000Z'))
    expect(next?.toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })

  it('uses the first occurrence of an ambiguous fall-back wall time', () => {
    const next = nextRunAfter('30 1 * * *', 'America/New_York', new Date('2026-11-01T04:00:00.000Z'))
    expect(next?.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('returns an instant strictly after `after`, on a minute boundary', () => {
    expect(
      nextRunAfter('* * * * *', 'UTC', new Date('2026-01-01T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-01-01T00:01:00.000Z')
    expect(
      nextRunAfter('* * * * *', 'UTC', new Date('2026-01-01T00:00:30.000Z'))?.toISOString(),
    ).toBe('2026-01-01T00:01:00.000Z')
    expect(
      nextRunAfter('0 9 * * *', 'UTC', new Date('2026-01-01T09:00:00.000Z'))?.toISOString(),
    ).toBe('2026-01-02T09:00:00.000Z')
  })

  it('rejects an invalid timezone', () => {
    expect(() => nextRunAfter('0 9 * * *', 'Not/AZone', new Date('2026-01-01T00:00:00.000Z'))).toThrow(ScheduleError)
  })

  it('rejects an invalid anchor date', () => {
    expect(() => nextRunAfter('0 9 * * *', 'UTC', new Date('not a date'))).toThrow(ScheduleError)
  })
})

describe('Vixie day matching', () => {
  it('matches on either day-of-month or day-of-week when both are restricted', () => {
    // 2026-03-01 is a Sunday and 2026-03-02 is a Monday: day 2 must still fire.
    const monday = nextRunAfter('0 3 1 * 1', 'UTC', new Date('2026-03-01T03:30:00.000Z'))
    expect(monday?.toISOString()).toBe('2026-03-02T03:00:00.000Z')
    // 2026-03-30 is a Monday, 2026-04-01 is a Wednesday: day 1 must still fire.
    const first = nextRunAfter('0 3 1 * 1', 'UTC', new Date('2026-03-30T03:30:00.000Z'))
    expect(first?.toISOString()).toBe('2026-04-01T03:00:00.000Z')
  })

  it('matches day-of-month alone regardless of weekday', () => {
    const next = nextRunAfter('0 0 1 * *', 'UTC', new Date('2026-02-28T00:30:00.000Z'))
    expect(next?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('matches day-of-week alone regardless of day-of-month', () => {
    const next = nextRunAfter('0 0 * * 1', 'UTC', new Date('2026-03-02T00:30:00.000Z'))
    expect(next?.toISOString()).toBe('2026-03-09T00:00:00.000Z')
  })
})

describe('nextRuns', () => {
  it('returns consecutive daily fire times', () => {
    const runs = nextRuns('0 9 * * *', 'UTC', new Date('2026-01-01T00:00:00.000Z'), 3)
    expect(runs.map((date) => date.toISOString())).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
    ])
  })

  it('returns an empty list when the schedule never fires again', () => {
    expect(nextRuns('0 0 31 2 *', 'UTC', new Date('2026-01-01T00:00:00.000Z'), 3)).toEqual([])
  })

  it('returns an empty list for a non-positive count', () => {
    expect(nextRuns('0 9 * * *', 'UTC', new Date('2026-01-01T00:00:00.000Z'), 0)).toEqual([])
    expect(nextRuns('0 9 * * *', 'UTC', new Date('2026-01-01T00:00:00.000Z'), -1)).toEqual([])
  })
})

describe('describeSchedule', () => {
  it('matches the exact contract phrases', () => {
    expect(describeSchedule('* * * * *')).toBe('every minute')
    expect(describeSchedule('*/15 * * * *')).toBe('every 15 minutes')
    expect(describeSchedule('0 * * * *')).toBe('every hour')
    expect(describeSchedule('30 8 * * 1-5')).toBe('weekdays at 08:30')
    expect(describeSchedule('0 9 * * *')).toBe('every day at 09:00')
    expect(describeSchedule('0 0 * * 0')).toBe('every Sunday at 00:00')
    expect(describeSchedule('every 4h')).toBe('every 4 hours')
    expect(describeSchedule('0 3 1 * *')).toBe('on the 1st of every month at 03:00')
    expect(describeSchedule('0 3 1 * 1')).toBe('on day 1 or every Monday at 03:00')
  })

  it('describes interval combinations', () => {
    expect(describeSchedule('every 2h30m')).toBe('every 2 hours and 30 minutes')
    expect(describeSchedule('every 90s')).toBe('every 90 seconds')
    expect(describeSchedule('every 1h')).toBe('every hour')
  })
})

describe('performance', () => {
  it('resolves a far-away leap-day schedule quickly', () => {
    const started = Date.now()
    const next = nextRunAfter('0 0 29 2 *', 'UTC', new Date('2026-03-01T00:00:00.000Z'))
    expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
    expect(Date.now() - started).toBeLessThan(500)
  })
})
