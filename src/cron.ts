/**
 * dsh-cron — pure cron math shared by the host scheduler and the Web panel.
 *
 * This module is imported by BOTH halves of the plugin, so it must stay
 * browser-safe: only `Date` and `Intl` from the JavaScript standard library,
 * no `node:*` imports, no npm dependencies, no `process`, no `fs`.
 *
 * The hard part is timezone math. Every schedule is evaluated against a named
 * IANA zone (`job.timezone`), never against the host's own zone, and the only
 * zone primitive a browser guarantees is `Intl.DateTimeFormat`. The search
 * below therefore iterates wall-clock *days* (pure civil arithmetic), and maps
 * each matching wall-clock time to an instant through offset probing — a few
 * `Intl` calls per matching time, never one call per scanned minute.
 *
 * @module dsh-cron/cron
 */

/** Error thrown when a schedule expression cannot be parsed or resolved. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

/** The five cron fields of one parsed schedule, expanded into value sets. */
export interface ParsedSchedule {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  /**
   * True when the day-of-month field was restricted, i.e. not `*` or `?`.
   * With Vixie semantics a day matches on DOM OR DOW when both are restricted.
   */
  domRestricted: boolean
  /** True when the day-of-week field was restricted, i.e. not `*` or `?`. */
  dowRestricted: boolean
  /** The expression exactly as it was passed in. */
  source: string
  /** The expression canonicalized to a five-field string (or an interval). */
  normalized: string
}

/** One civil date in the proleptic Gregorian calendar. */
interface CivilDate {
  year: number
  /** 1–12. */
  month: number
  /** 1–31. */
  day: number
}

/** Bounds and vocabulary of one cron field. */
interface FieldSpec {
  min: number
  max: number
  /** Human label used in error messages, e.g. `minute`. */
  label: string
  /** Optional three-letter names, e.g. `jan` → 1. */
  names?: ReadonlyMap<string, number>
}

/** A parsed interval such as `every 4h` or `every 2h30m`. */
interface ParsedInterval {
  /** Total duration in seconds. */
  seconds: number
  /** Canonical lowercase form, e.g. `every 4h`. */
  normalized: string
  /** Unit breakdown used by `describeSchedule`. */
  parts: { hours: number; minutes: number; seconds: number }
}

/** The result of parsing one cron field: expanded values plus canonical text. */
interface FieldParse {
  values: Set<number>
  canonical: string
}

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
/** Upper bound of the next-run search in wall-clock days. */
const MAX_SEARCH_DAYS = 1600

/** Three-letter month names, case-insensitive, mapped to 1–12. */
const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])

/** Three-letter weekday names, case-insensitive, mapped to 0–6 (Sunday = 0). */
const DOW_NAMES: ReadonlyMap<string, number> = new Map([
  ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6],
])

const MINUTE_SPEC: FieldSpec = { min: 0, max: 59, label: 'minute' }
const HOUR_SPEC: FieldSpec = { min: 0, max: 23, label: 'hour' }
const DAY_OF_MONTH_SPEC: FieldSpec = { min: 1, max: 31, label: 'day-of-month' }
const MONTH_SPEC: FieldSpec = { min: 1, max: 12, label: 'month', names: MONTH_NAMES }
const DAY_OF_WEEK_SPEC: FieldSpec = { min: 0, max: 7, label: 'day-of-week', names: DOW_NAMES }

const MACROS: ReadonlyMap<string, string> = new Map([
  ['@hourly', '0 * * * *'],
  ['@daily', '0 0 * * *'],
  ['@midnight', '0 0 * * *'],
  ['@weekly', '0 0 * * 0'],
  ['@monthly', '0 0 1 * *'],
  ['@yearly', '0 0 1 1 *'],
  ['@annually', '0 0 1 1 *'],
])

const MONTH_NAMES_LIST: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const DOW_NAMES_LIST: readonly string[] = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

const UNIT_SECONDS: ReadonlyMap<string, number> = new Map([
  ['s', 1],
  ['m', 60],
  ['h', 3600],
])

/** Cached per timezone: constructing an `Intl.DateTimeFormat` is expensive. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

/**
 * Parse a cron expression, a macro, or an interval into its five fields.
 *
 * @param expr - `0 2 * * *`, `@daily`, or `every 30m`.
 * @returns the parsed schedule.
 * @throws {ScheduleError} when the expression is empty, unknown, or invalid.
 */
export function parseSchedule(expr: string): ParsedSchedule {
  if (typeof expr !== 'string') {
    throw new ScheduleError('cron expression must be a string')
  }
  const trimmed = expr.trim()
  if (trimmed === '') {
    throw new ScheduleError('cron expression is empty')
  }

  const lower = trimmed.toLowerCase()
  if (lower.startsWith('@')) {
    const mapped = MACROS.get(lower)
    if (mapped === undefined) {
      throw new ScheduleError(
        `unknown macro "${trimmed}"; expected one of @hourly, @daily, @midnight, @weekly, @monthly, @yearly, @annually`,
      )
    }
    return fromFields(mapped.split(' '), trimmed, mapped)
  }

  const interval = parseInterval(trimmed)
  if (interval !== undefined) {
    return {
      minute: fullRange(0, 59),
      hour: fullRange(0, 23),
      dayOfMonth: fullRange(1, 31),
      month: fullRange(1, 12),
      dayOfWeek: fullRange(0, 6),
      domRestricted: false,
      dowRestricted: false,
      source: trimmed,
      normalized: interval.normalized,
    }
  }

  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    if (fields.length === 6) {
      throw new ScheduleError(`cron must have 5 fields (seconds are not supported): "${trimmed}"`)
    }
    throw new ScheduleError(`cron must have 5 fields (got ${fields.length}): "${trimmed}"`)
  }
  return fromFields(fields, trimmed)
}

/**
 * Canonicalize an expression to five fields.
 *
 * Macros expand to their five-field equivalent, month/weekday names become
 * numbers (`sun` → `0`), `?` becomes `*`, whitespace collapses, and intervals
 * are returned lowercased as written (they have no five-field form).
 *
 * @param expr - any schedule expression accepted by {@link parseSchedule}.
 * @returns the canonical expression.
 * @throws {ScheduleError} when the expression cannot be parsed.
 */
export function normalizeSchedule(expr: string): string {
  return parseSchedule(expr).normalized
}

/**
 * The first instant strictly after `after` at which `expr` fires in `timezone`.
 *
 * The returned instant sits on a minute boundary (seconds and milliseconds are
 * zero) for cron schedules; interval schedules return `after + interval`
 * exactly, as the contract requires.
 *
 * @param expr - cron expression, macro, or interval (`every 30m`).
 * @param timezone - IANA zone name, e.g. `Asia/Tokyo` or `UTC`.
 * @param after - exclusive lower bound (any sub-minute fraction is respected).
 * @returns the next fire time, or `undefined` when nothing fires within the
 *          bounded search window (~1600 days).
 * @throws {ScheduleError} for an invalid expression, timezone, or `after`.
 */
export function nextRunAfter(expr: string, timezone: string, after: Date): Date | undefined {
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    throw new ScheduleError(`after must be a valid Date, got: ${String(after)}`)
  }

  const interval = parseInterval(expr)
  if (interval !== undefined) {
    return new Date(after.getTime() + interval.seconds * 1000)
  }

  return nextCronRun(parseSchedule(expr), timezone, after)
}

/**
 * The next `count` fire times of `expr` in `timezone`, strictly after `after`.
 *
 * Each entry is produced by iterating {@link nextRunAfter}, so intervals stay
 * exact and cron schedules advance minute by minute.
 *
 * @param expr - cron expression, macro, or interval.
 * @param timezone - IANA zone name.
 * @param after - exclusive lower bound of the first result.
 * @param count - how many fire times to resolve.
 * @returns up to `count` instants; empty when nothing fires again (or
 *          `count <= 0`).
 */
export function nextRuns(expr: string, timezone: string, after: Date, count: number): Date[] {
  if (!Number.isFinite(count) || count <= 0) return []
  const runs: Date[] = []
  let cursor = after
  const limit = Math.floor(count)
  for (let i = 0; i < limit; i++) {
    const next = nextRunAfter(expr, timezone, cursor)
    if (next === undefined) break
    runs.push(next)
    cursor = next
  }
  return runs
}

/**
 * A short, deterministic English description of `expr` for the settings panel.
 *
 * @param expr - any schedule expression accepted by {@link parseSchedule}.
 * @returns e.g. `every day at 09:00`, `weekdays at 08:30`, `every 4 hours`.
 * @throws {ScheduleError} when the expression cannot be parsed.
 */
export function describeSchedule(expr: string): string {
  const interval = parseInterval(expr)
  if (interval !== undefined) return describeInterval(interval)
  return describeParsed(parseSchedule(expr))
}

/**
 * The period of an interval expression in minutes.
 *
 * @param expr - e.g. `every 30m`.
 * @returns 30 for `every 30m`, 240 for `every 4h`; seconds are converted to
 *          the nearest minute with a floor of 1 (`every 30s` → 1). `undefined`
 *          when the expression is not an interval form.
 * @throws {ScheduleError} when the expression is an interval with zero length.
 */
export function parseEvery(expr: string): number | undefined {
  const interval = parseInterval(expr)
  if (interval === undefined) return undefined
  return Math.max(1, Math.round(interval.seconds / 60))
}

/** Build the parsed schedule from exactly five field strings. */
function fromFields(fields: string[], source: string, normalized?: string): ParsedSchedule {
  if (fields.length !== 5) {
    throw new ScheduleError(`internal error: expected 5 fields, got ${fields.length}`)
  }
  const minute = parseField(fields[0]!, MINUTE_SPEC, source)
  const hour = parseField(fields[1]!, HOUR_SPEC, source)
  const dayOfMonth = parseField(fields[2]!, DAY_OF_MONTH_SPEC, source)
  const month = parseField(fields[3]!, MONTH_SPEC, source)
  const dayOfWeek = parseField(fields[4]!, DAY_OF_WEEK_SPEC, source)
  const domField = fields[2]!
  const dowField = fields[4]!
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    domRestricted: domField !== '*' && domField !== '?',
    dowRestricted: dowField !== '*' && dowField !== '?',
    source,
    normalized:
      normalized ??
      [minute.canonical, hour.canonical, dayOfMonth.canonical, month.canonical, dayOfWeek.canonical].join(' '),
  }
}

/** Parse one cron field (`*`, `?`, lists, ranges, steps, names) into values. */
function parseField(field: string, spec: FieldSpec, source: string): FieldParse {
  const values = new Set<number>()
  const canonicalTokens: string[] = []
  const tokens = field.split(',')
  for (const rawToken of tokens) {
    if (rawToken === '') {
      throw new ScheduleError(`invalid ${spec.label} field "${field}" in "${source}": empty list item`)
    }

    let rangePart = rawToken
    let step: number | undefined
    const slash = rawToken.indexOf('/')
    if (slash >= 0) {
      rangePart = rawToken.slice(0, slash)
      const stepText = rawToken.slice(slash + 1)
      if (rangePart === '' || !/^\d+$/.test(stepText)) {
        throw new ScheduleError(`invalid ${spec.label} field syntax "${rawToken}" in "${source}"`)
      }
      step = Number(stepText)
      if (step < 1) {
        throw new ScheduleError(`step must be at least 1 in ${spec.label} field of "${source}": "${rawToken}"`)
      }
    }

    let lo: number
    let hi: number
    let canonicalBase: string
    if (rangePart === '*' || rangePart === '?') {
      lo = spec.min
      hi = spec.max
      canonicalBase = '*'
    } else {
      const dashParts = rangePart.split('-')
      if (dashParts.length > 2) {
        throw new ScheduleError(`invalid ${spec.label} field syntax "${rawToken}" in "${source}"`)
      }
      if (dashParts.length === 2) {
        const loText = dashParts[0]!
        const hiText = dashParts[1]!
        if (loText === '' || hiText === '') {
          throw new ScheduleError(`invalid ${spec.label} field syntax "${rawToken}" in "${source}"`)
        }
        const loValue = parseValue(loText, spec, source)
        const hiValue = parseValue(hiText, spec, source)
        if (loValue > hiValue) {
          throw new ScheduleError(`inverted range ${loValue}-${hiValue} in ${spec.label} field of "${source}"`)
        }
        lo = loValue
        hi = hiValue
        canonicalBase = `${canonicalValue(loValue)}-${canonicalValue(hiValue)}`
      } else {
        const value = parseValue(rangePart, spec, source)
        lo = value
        hi = value
        canonicalBase = canonicalValue(value)
      }
    }

    const stride = step ?? 1
    for (let value = lo; value <= hi; value += stride) {
      addFieldValue(values, value, spec)
    }
    canonicalTokens.push(step !== undefined ? `${canonicalBase}/${step}` : canonicalBase)
  }
  return { values, canonical: canonicalTokens.join(',') }
}

/** Parse one numeric or named value and validate its range. */
function parseValue(text: string, spec: FieldSpec, source: string): number {
  const named = spec.names?.get(text.toLowerCase())
  let value: number
  if (named !== undefined) {
    value = named
  } else if (/^\d+$/.test(text)) {
    value = Number(text)
  } else {
    throw new ScheduleError(`invalid ${spec.label} value "${text}" in "${source}"`)
  }
  if (value < spec.min || value > spec.max) {
    throw new ScheduleError(`${spec.label} ${value} is out of range (${spec.min}-${spec.max}): "${source}"`)
  }
  return value
}

/** Add a parsed value, folding crontab's `7` (Sunday) into `0` for weekdays. */
function addFieldValue(values: Set<number>, value: number, spec: FieldSpec): void {
  if (spec.label === 'day-of-week' && value === 7) {
    values.add(0)
    return
  }
  values.add(value)
}

/** Canonical text of an already-parsed value (names were mapped to numbers). */
function canonicalValue(value: number): string {
  return String(value)
}

/**
 * Parse `every 30m`, `every 4h`, `every 90s`, `every 2h30m` (case-insensitive,
 * whitespace-tolerant). Returns `undefined` for anything that is not an
 * interval form, so callers can fall through to cron parsing.
 */
function parseInterval(expr: string): ParsedInterval | undefined {
  if (typeof expr !== 'string') return undefined
  const match = /^every\s+(.+)$/i.exec(expr.trim())
  if (match === null) return undefined
  const rest = (match[1] ?? '').toLowerCase()
  const tokens = rest.split(/\s+/)
  let totalSeconds = 0
  let hours = 0
  let minutes = 0
  let seconds = 0
  for (const token of tokens) {
    if (!/^(?:\d+[smh])+$/.test(token)) return undefined
    const unitPattern = /(\d+)([smh])/g
    let unitMatch: RegExpExecArray | null
    let consumed = 0
    while ((unitMatch = unitPattern.exec(token)) !== null) {
      const valueText = unitMatch[1]!
      const unitText = unitMatch[2]!.toLowerCase()
      consumed += unitMatch[0]!.length
      const value = Number(valueText)
      const unitSeconds = UNIT_SECONDS.get(unitText) ?? 0
      totalSeconds += value * unitSeconds
      if (unitText === 'h') hours += value
      else if (unitText === 'm') minutes += value
      else seconds += value
    }
    if (consumed !== token.length) return undefined
  }
  if (totalSeconds <= 0) {
    throw new ScheduleError(`interval must be positive: "${expr}"`)
  }
  return { seconds: totalSeconds, normalized: `every ${rest}`, parts: { hours, minutes, seconds } }
}

/** Search forward one wall-clock day at a time until a fire time is found. */
function nextCronRun(parsed: ParsedSchedule, timezone: string, after: Date): Date | undefined {
  const afterMs = after.getTime()

  // Fast path: every minute is every minute in any zone whose offset is a
  // whole number of minutes (all modern IANA zones), so wall minute
  // boundaries coincide with UTC minute boundaries.
  if (
    parsed.minute.size === 60 &&
    parsed.hour.size === 24 &&
    parsed.month.size === 12 &&
    !parsed.domRestricted &&
    !parsed.dowRestricted
  ) {
    return new Date(Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
  }

  const formatter = getFormatter(timezone)
  const afterSecond = Math.floor(afterMs / 1000) * 1000
  const wallMs = afterSecond + offsetAtMs(afterSecond, formatter)
  const startEpochDay = Math.floor(wallMs / DAY_MS)
  const hours = sortedValues(parsed.hour)
  const minutes = sortedValues(parsed.minute)
  const times: Array<[number, number]> = []
  for (const hour of hours) {
    for (const minute of minutes) times.push([hour, minute])
  }

  for (let dayOffset = 0; dayOffset < MAX_SEARCH_DAYS; dayOffset++) {
    const epochDay = startEpochDay + dayOffset
    const civil = civilFromEpochDay(epochDay)
    if (!parsed.month.has(civil.month)) continue
    if (!dayMatches(parsed, civil.day, weekdayOfEpochDay(epochDay))) continue

    let best: number | undefined
    for (const [hour, minute] of times) {
      const candidates = wallUtcCandidates(civil.year, civil.month, civil.day, hour, minute, formatter)
      for (const candidate of candidates) {
        if (candidate > afterMs && (best === undefined || candidate < best)) {
          best = candidate
        }
      }
    }
    if (best !== undefined) return new Date(best)
  }
  return undefined
}

/**
 * Vixie day rule: with only one restricted day field that field must match;
 * with BOTH restricted, a day matches when EITHER field matches.
 */
function dayMatches(parsed: ParsedSchedule, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = parsed.dayOfMonth.has(dayOfMonth)
  const dowMatch = parsed.dayOfWeek.has(dayOfWeek)
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch
  if (parsed.domRestricted) return domMatch
  if (parsed.dowRestricted) return dowMatch
  return true
}

/**
 * Resolve one wall-clock time in `timezone` to the set of instants (0, 1, or
 * 2) at which the zone's clock actually reads that time.
 *
 * The offset function `f(guess) = wallMs - offsetAt(guess)` is a step function:
 * a fixed point is a real instant with the requested wall reading. Probing from
 * two far-away starts (well before and well after any DST transition of that
 * wall day) finds both occurrences of an ambiguous fall-back time, finds the
 * single occurrence of an ordinary time, and finds nothing for a spring-forward
 * gap (the iteration then oscillates and never converges).
 */
function wallUtcCandidates(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  formatter: Intl.DateTimeFormat,
): number[] {
  const wallMs = wallClockAsUtcMs(year, month, day, hour, minute, 0)
  const found: number[] = []
  for (const start of [wallMs - 2 * DAY_MS, wallMs + 2 * DAY_MS]) {
    let guess = start
    let converged = false
    for (let i = 0; i < 5; i++) {
      const next = wallMs - offsetAtMs(guess, formatter)
      if (next === guess) {
        converged = true
        break
      }
      guess = next
    }
    if (converged && !found.includes(guess)) found.push(guess)
  }
  found.sort((a, b) => a - b)
  return found
}

/** The zone's UTC offset (ms east) at one instant, via `Intl` only. */
function offsetAtMs(utcMs: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(new Date(utcMs))
  let year = 1970
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  let second = 0
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      case 'hour':
        hour = Number(part.value)
        break
      case 'minute':
        minute = Number(part.value)
        break
      case 'second':
        second = Number(part.value)
        break
    }
  }
  return wallClockAsUtcMs(year, month, day, hour, minute, second) - Math.floor(utcMs / 1000) * 1000
}

/** Build a wall-clock pseudo-UTC timestamp; handles years 0–99 correctly. */
function wallClockAsUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getTime()
}

/** Cached `Intl.DateTimeFormat` per zone (construction is the costly part). */
function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone)
  if (cached !== undefined) return cached
  try {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timezone, formatter)
    return formatter
  } catch {
    throw new ScheduleError(`invalid timezone "${timezone}"`)
  }
}

/** All integers in `[min, max]`, used for unrestricted interval fields. */
function fullRange(min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (let value = min; value <= max; value++) values.add(value)
  return values
}

/** The elements of a set, ascending. */
function sortedValues(values: Set<number>): number[] {
  return Array.from(values).sort((a, b) => a - b)
}

/** Civil date from a day count, using Howard Hinnant's `civil_from_days`. */
function civilFromEpochDay(epochDay: number): CivilDate {
  let z = epochDay + 719_468
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  )
  const year = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: year + (month <= 2 ? 1 : 0), month, day }
}

/** Weekday of a day count: 0 = Sunday … 6 = Saturday (1970-01-01 was Thursday). */
function weekdayOfEpochDay(epochDay: number): number {
  return (((epochDay + 4) % 7) + 7) % 7
}

/** Short English description of a parsed cron schedule. */
function describeParsed(parsed: ParsedSchedule): string {
  const fields = parsed.normalized.split(' ')
  const minuteField = fields[0] ?? '*'
  const hourField = fields[1] ?? '*'
  const monthField = fields[3] ?? '*'
  const hours = sortedValues(parsed.hour)
  const minutes = sortedValues(parsed.minute)
  const monthRestricted = monthField !== '*'

  const timePhrase = describeTime(minuteField, hourField, hours, minutes)

  if (!parsed.domRestricted && !parsed.dowRestricted && !monthRestricted) {
    // `every minute` / `every 15 minutes` / `every hour` already say it all.
    if (timePhrase === 'every minute' || timePhrase === 'every hour' || /^every \d+ minutes$/.test(timePhrase)) {
      return timePhrase
    }
    return `every day ${timePhrase}`
  }

  const dayPhrase = describeDay(parsed, monthRestricted)
  return `${dayPhrase} ${timePhrase}`
}

/** The time part of a description: `at 08:30`, `every hour`, `every 15 minutes`. */
function describeTime(
  minuteField: string,
  hourField: string,
  hours: number[],
  minutes: number[],
): string {
  if (hours.length === 1 && minutes.length === 1) {
    return `at ${pad2(hours[0] ?? 0)}:${pad2(minutes[0] ?? 0)}`
  }
  if (hourField === '*' && minuteField === '*') return 'every minute'
  if (hourField === '*' && minuteField === '0') return 'every hour'
  const step = plainStepOf(minuteField)
  if (hourField === '*' && step !== undefined) {
    return step === 1 ? 'every minute' : `every ${step} minutes`
  }
  const times: string[] = []
  for (const hour of hours) {
    for (const minute of minutes) times.push(`${pad2(hour)}:${pad2(minute)}`)
  }
  return `at ${joinNatural(times)}`
}

/** The day part of a description, e.g. `weekdays`, `on the 1st of every month`. */
function describeDay(parsed: ParsedSchedule, monthRestricted: boolean): string {
  const dayOfMonth = sortedValues(parsed.dayOfMonth)
  const dayOfWeek = sortedValues(parsed.dayOfWeek)
  const months = sortedValues(parsed.month)

  if (!parsed.domRestricted && !parsed.dowRestricted) {
    return monthRestricted ? `in ${joinNatural(months.map(monthName))}` : 'every day'
  }

  if (parsed.domRestricted && parsed.dowRestricted) {
    // Vixie either-match phrasing: keep the DOM side terse so the OR reads well.
    return `on day ${dayOfMonth.join(', ')} or ${describeDow(dayOfWeek)}`
  }

  if (parsed.dowRestricted) {
    const dow = describeDow(dayOfWeek)
    return monthRestricted ? `${dow} in ${joinNatural(months.map(monthName))}` : dow
  }

  if (monthRestricted) {
    const monthText = joinNatural(months.map(monthName))
    if (dayOfMonth.length === 1) {
      return `on the ${ordinal(dayOfMonth[0] ?? 1)} of ${monthText}`
    }
    return `on days ${dayOfMonth.join(', ')} of ${monthText}`
  }
  if (dayOfMonth.length === 1) {
    return `on the ${ordinal(dayOfMonth[0] ?? 1)} of every month`
  }
  return `on the ${joinNatural(dayOfMonth.map(ordinal))} of every month`
}

/** Describe a restricted weekday set: `weekdays`, `every Sunday`, … */
function describeDow(dayOfWeek: number[]): string {
  if (dayOfWeek.length === 5 && dayOfWeek[0] === 1 && dayOfWeek[4] === 5) return 'weekdays'
  const names = dayOfWeek.map(dowName)
  if (names.length === 1) return `every ${names[0] ?? ''}`
  return `every ${joinNatural(names)}`
}

/** Short English description of an interval expression. */
function describeInterval(interval: ParsedInterval): string {
  const { hours, minutes, seconds } = interval.parts
  if (hours === 1 && minutes === 0 && seconds === 0) return 'every hour'
  if (hours === 0 && minutes === 1 && seconds === 0) return 'every minute'
  if (hours === 0 && minutes === 0 && seconds === 1) return 'every second'
  const bits: string[] = []
  if (hours > 0) bits.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`)
  if (minutes > 0) bits.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`)
  if (seconds > 0) bits.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`)
  return `every ${bits.join(' and ')}`
}

/** Plain minute step (`asterisk/15` → 15), otherwise `undefined`. */
function plainStepOf(field: string): number | undefined {
  const match = /^\*\/(\d+)$/.exec(field)
  if (match === null) return undefined
  return Number(match[1])
}

/** English ordinal: 1 → `1st`, 22 → `22nd`. */
function ordinal(value: number): string {
  const rem10 = value % 10
  const rem100 = value % 100
  if (rem10 === 1 && rem100 !== 11) return `${value}st`
  if (rem10 === 2 && rem100 !== 12) return `${value}nd`
  if (rem10 === 3 && rem100 !== 13) return `${value}rd`
  return `${value}th`
}

/** `['a']`, `['a', 'b']` → `a and b`, three-plus → `a, b, and c`. */
function joinNatural(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0] ?? ''} and ${items[1] ?? ''}`
  const last = items[items.length - 1] ?? ''
  return `${items.slice(0, -1).join(', ')}, and ${last}`
}

/** Month name for 1–12. */
function monthName(month: number): string {
  return MONTH_NAMES_LIST[month - 1] ?? String(month)
}

/** Weekday name for 0–6. */
function dowName(dayOfWeek: number): string {
  return DOW_NAMES_LIST[dayOfWeek] ?? String(dayOfWeek)
}

/** Two-digit zero-padded number for `HH:MM` rendering. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
