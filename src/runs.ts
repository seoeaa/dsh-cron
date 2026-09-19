/**
 * dsh-cron — run history IO (host half, Node only).
 *
 * Run records live at `<cwd>/.dsh/routines/runs/<runId>.json`, keyed by the
 * working directory of the run rather than by project, because that is where
 * the run's own digests belong and where `dsh-routines` already writes them. A
 * human `<runId>.md` digest sits beside each record.
 *
 * Two rules shape this module. Records are the audit trail of unattended work,
 * so a record this process cannot parse is skipped and, on prune, kept — losing
 * history silently is worse than showing one unreadable file. And the JSON file
 * is the artifact of record: the digest beside it is a convenience, so a digest
 * that cannot be written must never fail the run that produced it.
 *
 * @module dsh-cron/runs
 */

import type { Dirent } from 'node:fs'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DeliveryKind,
  DeliveryResult,
  DeniedApproval,
  RunRecord,
  RunStatus,
  RunTrigger,
} from './types.ts'

/** Every status a persisted record may carry, in one runtime-checkable list. */
const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'completed',
  'failed',
  'killed',
  'timeout',
  'skipped',
]

/** Delivery kinds a record may mention. */
const DELIVERY_KINDS: readonly DeliveryKind[] = ['file', 'chatnode']

/**
 * Run ids accepted from a caller.
 *
 * The id becomes a file name, so anything with a path separator could address a
 * file outside the runs directory. Real ids look like `run-1726000000000-ab12`.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One parsed record together with the file it came from. */
interface LoadedRun {
  /** The normalized record. */
  record: RunRecord
  /** Absolute path of the `.json` file. */
  file: string
}

/** `true` for a JSON object: not `null`, not an array, not a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown value to a known {@link RunStatus}. */
function toRunStatus(value: unknown): RunStatus | undefined {
  return typeof value === 'string' ? RUN_STATUSES.find((status) => status === value) : undefined
}

/** Keep a value only when it is a finite number. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Keep a value only when it is a string. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Narrow an unknown value to a {@link RunTrigger}, defaulting to a scheduled run. */
function toRunTrigger(value: unknown): RunTrigger {
  return value === 'manual' ? 'manual' : 'schedule'
}

/** Keep the well-formed entries of a `denied` list. */
function toDenied(value: unknown): DeniedApproval[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const denied: DeniedApproval[] = []
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.toolName !== 'string')
      continue
    denied.push(
      typeof entry.reason === 'string'
        ? { toolName: entry.toolName, reason: entry.reason }
        : { toolName: entry.toolName },
    )
  }
  return denied
}

/** Keep the well-formed entries of a `deliveries` list. */
function toDeliveries(value: unknown): DeliveryResult[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const deliveries: DeliveryResult[] = []
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.ok !== 'boolean')
      continue
    const type = DELIVERY_KINDS.find((kind) => kind === entry.type)
    if (type === undefined)
      continue
    deliveries.push(
      typeof entry.error === 'string'
        ? { type, ok: entry.ok, error: entry.error }
        : { type, ok: entry.ok },
    )
  }
  return deliveries
}

/**
 * Turn file text into a record this module can hand out, or `undefined`.
 *
 * The required fields are the ones the rest of the plugin orders, filters and
 * renders by; a file missing any of them is not a record we can trust to be one
 * run. The optional half is copied only when it has the right type — unknown
 * keys and wrong-typed values are dropped rather than leaking into the panel.
 * Nothing is invented: in particular `durationMs` is `undefined` unless the
 * file carried a number.
 */
function parseRecord(text: string, cwd: string): RunRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return undefined
  }
  if (!isPlainObject(parsed))
    return undefined
  const runId = parsed.runId
  const routine = parsed.routine
  const status = toRunStatus(parsed.status)
  const startedAt = finiteNumber(parsed.startedAt)
  if (typeof runId !== 'string' || runId === '' || typeof routine !== 'string')
    return undefined
  if (status === undefined || startedAt === undefined)
    return undefined

  const finishedAt = finiteNumber(parsed.finishedAt)
  const durationMs = finiteNumber(parsed.durationMs)
  const exitCode = finiteNumber(parsed.exitCode)
  const sessionId = optionalString(parsed.sessionId)
  const digest = optionalString(parsed.digest)
  const error = optionalString(parsed.error)
  const denied = toDenied(parsed.denied)
  const deliveries = toDeliveries(parsed.deliveries)

  return {
    runId,
    routine,
    // A partially written record is still history worth showing; the missing
    // identity fields fall back to what the file's own location proves.
    profile: optionalString(parsed.profile) ?? '',
    cwd: optionalString(parsed.cwd) ?? cwd,
    status,
    trigger: toRunTrigger(parsed.trigger),
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(digest !== undefined ? { digest } : {}),
    ...(denied !== undefined ? { denied } : {}),
    ...(deliveries !== undefined ? { deliveries } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * Order records newest first, ties broken by run id.
 *
 * The tie-break matters: a skipped occurrence and the run it skipped can share
 * a millisecond, and the panel must not reorder its own history between two
 * reads.
 */
function byNewestFirst(a: RunRecord, b: RunRecord): number {
  if (a.startedAt !== b.startedAt)
    return b.startedAt - a.startedAt
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0
}

/** The run id a caller may use, or `undefined` when it could escape the directory. */
function safeRunId(runId: string): string | undefined {
  return RUN_ID_PATTERN.test(runId) ? runId : undefined
}

/** Read every parsable record in a runs directory. */
function readAll(cwd: string): LoadedRun[] {
  const dir = runsDirFor(cwd)
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    // No runs yet, or the directory is unreadable: no history either way.
    return []
  }
  const loaded: LoadedRun[] = []
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.json'))
      continue
    const file = join(dir, entry.name)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    }
    catch {
      continue
    }
    const record = parseRecord(text, cwd)
    if (record !== undefined)
      loaded.push({ record, file })
  }
  return loaded
}

/** The `.md` digest path that belongs to a record file. */
function digestPathBeside(file: string): string {
  return file.replace(/\.json$/, '.md')
}

/**
 * Format one instant for the digest, tolerating a value that is not a date.
 *
 * A caller that hands over a broken timestamp should get a readable digest, not
 * a `RangeError` thrown out of `writeRun`.
 */
function readableTime(at: number): string {
  return Number.isFinite(at) ? new Date(at).toISOString() : String(at)
}

/** The markdown digest for one record: a scan line per fact, then the prose. */
function digestMarkdown(record: RunRecord): string {
  const lines: string[] = [
    `# dsh-cron digest — ${record.routine}`,
    `- run: ${record.runId}`,
    `- status: ${record.status}`,
    ...(record.sessionId !== undefined ? [`- session: ${record.sessionId}`] : []),
    `- started: ${readableTime(record.startedAt)}`,
    ...(record.finishedAt !== undefined ? [`- finished: ${readableTime(record.finishedAt)}`] : []),
    ...(record.durationMs !== undefined ? [`- duration: ${record.durationMs} ms`] : []),
    '',
    record.digest ?? '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Write the JSON record and, beside it, the human digest.
 *
 * The digest is written inside a guard: it is derived output, and a read-only
 * directory or a full disk must not turn a finished run into a failed one. The
 * caller's fields are written exactly as given — a run that never reported a
 * duration has no duration field at all, so the history never claims a run was
 * instantaneous.
 */
function writeAtomically(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
  }
  catch (error) {
    try {
      unlinkSync(tmp)
    }
    catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error
  }
}

/** The runs directory for one run's working directory. */
export function runsDirFor(cwd: string): string {
  return join(cwd, '.dsh', 'routines', 'runs')
}

/**
 * The record path for one run.
 *
 * Throws on a run id that could address a file outside the runs directory; the
 * reader tolerates that by reporting "no such run" instead.
 */
export function recordPathFor(cwd: string, runId: string): string {
  const id = safeRunId(runId)
  if (id === undefined)
    throw new Error(`invalid run id ${JSON.stringify(runId)}: run ids must not address other directories`)
  return join(runsDirFor(cwd), `${id}.json`)
}

/**
 * One run's record, or `undefined` when it is absent, unreadable or not a
 * record we can trust.
 */
export function readRun(cwd: string, runId: string): RunRecord | undefined {
  let file: string
  try {
    file = recordPathFor(cwd, runId)
  }
  catch {
    return undefined
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  }
  catch {
    return undefined
  }
  return parseRecord(text, cwd)
}

/**
 * Recent runs, newest first.
 *
 * `limit` counts records, not files: unparsable ones are skipped before the
 * limit is applied, so a limit of 5 means five runs the caller can actually
 * show. A missing, non-finite or non-positive limit means "no limit".
 */
export function listRuns(cwd: string, limit?: number): RunRecord[] {
  const records = readAll(cwd)
    .map((loaded) => loaded.record)
    .sort(byNewestFirst)
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
    return records
  return records.slice(0, Math.floor(limit))
}

/**
 * Persist one run record, atomically, with its markdown digest beside it.
 *
 * Throws only for a run id that could address a file outside the runs
 * directory: writing a record somewhere unexpected is worse than failing the
 * call that asked for it.
 */
export function writeRun(cwd: string, record: RunRecord): void {
  const file = recordPathFor(cwd, record.runId)
  mkdirSync(runsDirFor(cwd), { recursive: true })
  writeAtomically(file, `${JSON.stringify(record, null, 2)}\n`)
  try {
    writeFileSync(digestPathBeside(file), digestMarkdown(record), 'utf8')
  }
  catch {
    // The digest is a convenience beside the authoritative JSON record.
  }
}

/**
 * Keep the newest `keep` runs and delete the rest, with their digests.
 *
 * A file this module cannot parse is never deleted: an unreadable record is
 * evidence of a problem, and pruning must not destroy evidence it cannot even
 * read. A non-finite or negative `keep` is ignored rather than interpreted, so
 * a bad argument cannot wipe the history it was meant to bound.
 */
export function pruneRuns(cwd: string, keep: number): void {
  if (!Number.isFinite(keep) || keep < 0)
    return
  const keepCount = Math.floor(keep)
  const doomed = readAll(cwd).sort((a, b) => byNewestFirst(a.record, b.record)).slice(keepCount)
  for (const { file } of doomed) {
    try {
      unlinkSync(file)
    }
    catch {
      // Already gone, or not removable; the digest is still worth a try.
    }
    try {
      unlinkSync(digestPathBeside(file))
    }
    catch {
      // A record without a digest is normal (the digest is best-effort).
    }
  }
}
