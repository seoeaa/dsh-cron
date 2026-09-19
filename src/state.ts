/**
 * dsh-cron — durable scheduler state IO (host half, Node only).
 *
 * State lives at `<projectDir>/.dsh/routines/state.json` and holds the paused
 * set, the last observed launch time per job (the anchor the missed-run policy
 * advances from) and, additively, the last observed terminal status.
 *
 * Why the tolerance: the same file is written by the already-installed
 * `dsh-routines` plugin, which knows only `paused` and `lastRunAt` and ignores
 * unknown keys. So this module must survive their file (missing `lastStatus`)
 * and they must survive ours (an extra key). Reading is therefore
 * shape-tolerant field by field and never throws; writing is atomic so a killed
 * process cannot leave a half-written file that would silently wipe state.
 *
 * @module dsh-cron/state
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunStatus } from './types.ts'

/** One job's last observed terminal status, as persisted. */
export interface JobStatusRecord {
  /** Terminal status of the most recent finished run. */
  status: RunStatus
  /** Failure text of that run, when it carried one. */
  error?: string
  /** When the status was observed, as epoch milliseconds. */
  at: number
}

/** Everything dsh-cron remembers across restarts, per project. */
export interface SchedulerState {
  /** Names of jobs the user paused. */
  paused: string[]
  /** Last observed start per job name, as epoch milliseconds. */
  lastRunAt: Record<string, number>
  /** Last observed terminal status per job name (our additive field). */
  lastStatus: Record<string, JobStatusRecord>
}

/**
 * A template for "no state at all".
 *
 * Exported for callers that need a starting value, NOT as something to share:
 * {@link loadState} always returns a fresh object, so a caller may mutate what
 * it loaded without corrupting every other reader of this constant.
 */
export const EMPTY_STATE: SchedulerState = { paused: [], lastRunAt: {}, lastStatus: {} }

/** Every status a persisted record may carry, in one runtime-checkable list. */
const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'completed',
  'failed',
  'killed',
  'timeout',
  'skipped',
]

/** A fresh, mutable empty state (never the shared {@link EMPTY_STATE} object). */
function emptyState(): SchedulerState {
  return { paused: [], lastRunAt: {}, lastStatus: {} }
}

/** `true` for a JSON object: not `null`, not an array, not a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown value to a known {@link RunStatus}. */
function toRunStatus(value: unknown): RunStatus | undefined {
  return typeof value === 'string' ? RUN_STATUSES.find((status) => status === value) : undefined
}

/** Keep only the strings of a `paused` list written by either plugin. */
function readPaused(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Keep only the finite timestamps of a `lastRunAt` mapping. */
function readLastRunAt(value: unknown): Record<string, number> {
  const lastRunAt: Record<string, number> = {}
  if (!isPlainObject(value))
    return lastRunAt
  for (const [name, at] of Object.entries(value)) {
    if (typeof at === 'number' && Number.isFinite(at))
      lastRunAt[name] = at
  }
  return lastRunAt
}

/**
 * Keep only well-formed status records. A record without a known `status` or a
 * finite `at` is dropped whole: both fields are required to render it, and
 * inventing either one would put a wrong status in the panel.
 */
function readLastStatus(value: unknown): Record<string, JobStatusRecord> {
  const lastStatus: Record<string, JobStatusRecord> = {}
  if (!isPlainObject(value))
    return lastStatus
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry))
      continue
    const status = toRunStatus(entry.status)
    const at = entry.at
    if (status === undefined || typeof at !== 'number' || !Number.isFinite(at))
      continue
    lastStatus[name] = typeof entry.error === 'string' ? { status, error: entry.error, at } : { status, at }
  }
  return lastStatus
}

/** The state file path for one project directory. */
export function statePathFor(projectDir: string): string {
  return join(projectDir, '.dsh', 'routines', 'state.json')
}

/**
 * Load the persisted state.
 *
 * Absent, unreadable, unparsable or non-object content yields a fresh empty
 * state rather than an error: a corrupt file must degrade to "nothing is
 * paused yet", never take the scheduler down. Individual malformed entries are
 * dropped field by field so one bad job name cannot hide the rest.
 */
export function loadState(projectDir: string): SchedulerState {
  let text: string
  try {
    text = readFileSync(statePathFor(projectDir), 'utf8')
  }
  catch {
    return emptyState()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return emptyState()
  }
  if (!isPlainObject(parsed))
    return emptyState()
  return {
    paused: readPaused(parsed.paused),
    lastRunAt: readLastRunAt(parsed.lastRunAt),
    lastStatus: readLastStatus(parsed.lastStatus),
  }
}

/**
 * Persist the state, atomically and creating the directory when missing.
 *
 * Two-space JSON with a trailing newline is exactly what `dsh-routines` writes,
 * which keeps a shared file from flip-flopping between two diff shapes. The
 * temp-then-rename dance is what makes a concurrent reader see either the old
 * file or the new one, never a truncated one.
 */
export function saveState(projectDir: string, state: SchedulerState): void {
  const path = statePathFor(projectDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }
  catch (error) {
    // Leave no temp turd behind when the write or the rename failed.
    try {
      unlinkSync(tmp)
    }
    catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error
  }
}
