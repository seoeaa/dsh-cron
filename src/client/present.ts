/**
 * Pure view helpers for the dsh-cron settings page. No React, no Node, no
 * dependencies — only `../types.ts` (type-only, erased at build time). Every
 * function is deterministic given its inputs, so the unit test covers exactly
 * these transforms.
 *
 * Copy stays in `locales.ts`; what lives here are the *decisions*: which tone
 * a run status maps to, which locale key a label needs, how a duration or a
 * relative time is reduced to its numeric+unit parts, and how history is
 * grouped by local calendar day.
 *
 * @module dsh-cron/client/present
 */

import type { OverlapPolicy, RoutineSource, RunRecord, RunStatus } from '../types.ts'

/** Visual tone vocabulary shared with the primitives `StateDot`. */
export type Tone = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/** Localized label key for one run status (namespace `settings.dshCron`). */
export type RunStatusLabelKey =
  | 'statusCompleted'
  | 'statusRunning'
  | 'statusFailed'
  | 'statusKilled'
  | 'statusTimeout'
  | 'statusSkipped'

/** Localized label key for one overlap policy. */
export type OverlapLabelKey = 'overlapSkip' | 'overlapQueue' | 'overlapCancel'

/** Localized label key for one definition source. */
export type SourceLabelKey = 'sourceProject' | 'sourceGlobal'

/** Relative time decision: which locale phrase to use and its `{time}` value. */
export interface RelativeTime {
  direction: 'now' | 'in' | 'ago'
  /** Compact amount+unit, e.g. `5m`, `2h`, `45s` (units are symbols, not words). */
  time: string
}

/** One calendar-day group of run records. */
export interface RunDayGroup {
  /** Stable group key, e.g. `2026-07-21`. */
  key: string
  /** Local midnight of the group's day, in ms since epoch. */
  startOfDayMs: number
  /** Runs in this day, newest first. */
  runs: RunRecord[]
}

/** Job-name validation verdicts; `null` means the name is acceptable. */
export type JobNameError = 'pattern' | 'length'

/** The definition name rule shared with the host store. */
export const JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Hard cap for definition names (mirrors `src/store.ts`). */
export const JOB_NAME_MAX_LENGTH = 64

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** Map a run status to its StateDot-compatible visual tone. */
export function runStatusTone(status: RunStatus): Tone {
  switch (status) {
    case 'completed': return 'done'
    case 'running': return 'ongoing'
    case 'failed': return 'error'
    case 'killed': return 'warning'
    case 'timeout': return 'warning'
    case 'skipped': return 'idle'
  }
}

/** Localized label key for one run status. */
export function runStatusLabelKey(status: RunStatus): RunStatusLabelKey {
  switch (status) {
    case 'completed': return 'statusCompleted'
    case 'running': return 'statusRunning'
    case 'failed': return 'statusFailed'
    case 'killed': return 'statusKilled'
    case 'timeout': return 'statusTimeout'
    case 'skipped': return 'statusSkipped'
  }
}

/** Localized label key for one overlap policy. */
export function overlapLabelKey(overlap: OverlapPolicy): OverlapLabelKey {
  switch (overlap) {
    case 'skip': return 'overlapSkip'
    case 'queue': return 'overlapQueue'
    case 'cancel-previous': return 'overlapCancel'
  }
}

/** Localized label key for one definition source. */
export function sourceLabelKey(source: RoutineSource): SourceLabelKey {
  return source === 'project' ? 'sourceProject' : 'sourceGlobal'
}

/**
 * Compact duration with unit symbols (`1h 02m 03s`, `4m 05s`, `45s`, `0s`).
 * Unit symbols are data, not copy; prose around the value is localized.
 */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || Number.isNaN(ms)) return null
  if (ms < 1000) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`
  return `${seconds}s`
}

/**
 * Reduce one instant to a relative-time decision against `nowMs`. `nowMs`
 * defaults to `Date.now()`; callers pass the snapshot's clock (`snapshot.now`)
 * when they want the same reference the host used.
 */
export function relativeTime(ms: number, nowMs: number = Date.now()): RelativeTime {
  const diff = ms - nowMs
  const abs = Math.abs(diff)
  const direction: RelativeTime['direction'] = abs < 45_000 ? 'now' : diff > 0 ? 'in' : 'ago'
  if (direction === 'now') return { direction, time: '' }
  if (abs < 90_000) {
    return { direction, time: `${Math.max(1, Math.round(abs / 1000))}s` }
  }
  if (abs < 90 * MINUTE_MS) {
    return { direction, time: `${Math.max(1, Math.floor(abs / MINUTE_MS))}m` }
  }
  if (abs < 48 * HOUR_MS) {
    return { direction, time: `${Math.max(1, Math.floor(abs / HOUR_MS))}h` }
  }
  return { direction, time: `${Math.max(1, Math.floor(abs / DAY_MS))}d` }
}

/** Absolute timestamp for tooltips: `21/07/2026, 09:05` in local time. */
export function formatAbsoluteTime(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** Localized day label decision for one history group. */
export function dayLabelKey(startOfDayMs: number, nowMs: number = Date.now()): 'today' | 'yesterday' | null {
  const now = new Date(nowMs)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - DAY_MS
  if (startOfDayMs === today) return 'today'
  if (startOfDayMs === yesterday) return 'yesterday'
  return null
}

/** Calendar date for older history groups: `21 Jul 2026`. */
export function formatDayDate(startOfDayMs: number): string {
  return new Date(startOfDayMs).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Truncate a path for table cells, keeping both ends readable. */
export function truncatePath(path: string, max = 48): string {
  if (path.length <= max) return path
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  if (head <= 0 || tail <= 0) return path.slice(0, max)
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`
}

/** Group run records by the local calendar day of `startedAt`, newest first. */
export function groupRunsByDay(runs: RunRecord[]): RunDayGroup[] {
  const byKey = new Map<string, RunDayGroup>()
  for (const run of runs) {
    const date = new Date(run.startedAt)
    const startOfDayMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    const existing = byKey.get(key)
    if (existing !== undefined) {
      existing.runs.push(run)
    } else {
      byKey.set(key, { key, startOfDayMs, runs: [run] })
    }
  }
  const groups = [...byKey.values()]
  groups.sort((a, b) => b.startOfDayMs - a.startOfDayMs)
  for (const group of groups) {
    group.runs.sort((a, b) => b.startedAt - a.startedAt)
  }
  return groups
}

/**
 * Validate a definition name against the host rule: `[a-z0-9][a-z0-9-]*`,
 * at most 64 characters. Returns a localized error key, or `null` when valid.
 */
export function validateJobName(name: string): JobNameError | null {
  if (name.length > JOB_NAME_MAX_LENGTH) return 'length'
  if (!JOB_NAME_PATTERN.test(name)) return 'pattern'
  return null
}
