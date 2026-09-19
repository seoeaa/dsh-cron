/**
 * dsh-cron — job definition IO (host half, Node only).
 *
 * Definitions are the same YAML files the already-installed `dsh-routines`
 * plugin owns: `<projectDir>/.dsh/routines/*.yaml` and `~/.dsh/routines/*.yaml`,
 * with a project file overriding a global one of the same name. Both engines
 * must keep reading each other's files, so the field names, the defaults and
 * the "a broken file is reported, never thrown" behaviour are compatibility
 * surface, not preferences.
 *
 * Why validation lives here rather than in the tool layer: a definition on disk
 * is the durable artifact. Refusing a bad one at the boundary — on read as an
 * `InvalidJob` the panel can show, on write as a thrown field error the editor
 * can point at — is what keeps a malformed job from reaching the scheduler as a
 * silently-defaulted surprise.
 *
 * @module dsh-cron/store
 */

import type { Dirent, FSWatcher } from 'node:fs'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import type { CronJob, Delivery, InvalidJob, JobInput, OverlapPolicy, RoutineSource } from './types.ts'

/** The two directories a job definition may live in. */
export interface StoreDirs {
  /** `<projectDir>/.dsh/routines` — project-scoped definitions. */
  project: string
  /** Usually `~/.dsh/routines` — definitions shared by every project. */
  global: string
}

/** Job names the panel and the filesystem agree on: no dots, no slashes, no caps. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Longest accepted job name. */
const NAME_MAX_LENGTH = 64

/** Hard ceiling on `timeoutMin` (one day), so a typo cannot park an agent for a week. */
const TIMEOUT_MAX_MIN = 1440

/** Default profile a run boots. */
const DEFAULT_PROFILE = 'headless'

/** Default overlap policy. */
const DEFAULT_OVERLAP: OverlapPolicy = 'skip'

/** Default hard stop, in minutes. */
const DEFAULT_TIMEOUT_MIN = 45

/** Default zone when a definition names none and the caller names none. */
const DEFAULT_TIMEZONE = 'UTC'

/** Fields written to a definition file, in the order they are written. */
const DEFINITION_KEYS: readonly string[] = [
  'name',
  'schedule',
  'timezone',
  'prompt',
  'cwd',
  'profile',
  'overlap',
  'timeoutMin',
  'deliver',
]

/**
 * Fields a `CronJob` carries that `writeJob` recomputes instead of storing.
 *
 * Accepting them is what makes `writeJob(dirs, job)` work when a caller passes
 * back an object it read (the panel's "save" after an edit, a tool round-trip),
 * while anything genuinely unknown is still rejected as a typo.
 */
const DERIVED_KEYS: readonly string[] = [
  'source',
  'file',
  'paused',
  'running',
  'nextRunAt',
  'lastRunAt',
  'lastStatus',
  'lastError',
]

/** The one key `writeJob` reads but never writes. */
const SCOPE_KEY = 'scope'

/** YAML extensions either engine recognises. */
const YAML_EXTENSIONS = ['.yaml', '.yml'] as const

/** Debounce window for filesystem events: one save must not fire three reloads. */
const WATCH_DEBOUNCE_MS = 120

/** How often a directory that does not exist yet is re-checked. */
const WATCH_POLL_MS = 1000

/** The outcome of validating one raw definition. */
type Resolution = { ok: true; job: CronJob } | { ok: false; error: string }

/** One directory watched by {@link watchJobs}. */
interface DirWatch {
  /** Absolute (or caller-relative) directory path. */
  readonly dir: string
  /** The live watcher, when the directory exists. */
  watcher: FSWatcher | undefined
  /** The "directory does not exist yet" poll, when the watcher is not attached. */
  poll: NodeJS.Timeout | undefined
}

/** A fresh copy of the default delivery list (never a shared mutable array). */
function defaultDeliver(): Delivery[] {
  return [{ type: 'file' }]
}

/** `true` for a JSON/YAML object: not `null`, not an array, not a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `true` when the file name carries a YAML extension. */
function isYamlFile(name: string): boolean {
  return YAML_EXTENSIONS.some((extension) => name.endsWith(extension))
}

/** The job name to report for a definition file: its stem. */
function fileStem(file: string): string {
  const name = basename(file)
  for (const extension of YAML_EXTENSIONS) {
    if (name.endsWith(extension))
      return name.slice(0, -extension.length)
  }
  return name
}

/** The first line of an error message: our `InvalidJob.error` is one line. */
function firstLine(message: string): string {
  const [line] = message.split('\n')
  return (line ?? '').trim()
}

/** An `InvalidJob` for one path, with a single-line reason. */
function invalidJob(name: string, file: string, source: RoutineSource, error: string): InvalidJob {
  return { name, file, source, error: firstLine(error) }
}

/**
 * Whether `Intl` accepts a zone name.
 *
 * The only failure mode for a string zone is `RangeError`, thrown by
 * `Intl.DateTimeFormat` while resolving the zone; catching anything else and
 * still saying "invalid" keeps a surprising runtime failure from turning a bad
 * definition into a silently accepted one.
 */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  }
  catch {
    return false
  }
}

/** Narrow an unknown value to an {@link OverlapPolicy}. */
function toOverlapPolicy(value: unknown): OverlapPolicy | undefined {
  return value === 'skip' || value === 'queue' || value === 'cancel-previous' ? value : undefined
}

/**
 * Narrow an unknown value to a delivery list.
 *
 * `undefined` means "not a delivery list at all" (a rejection); an empty array
 * is a valid list that resolves to the implied file delivery.
 */
function toDeliveries(value: unknown): Delivery[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const deliveries: Delivery[] = []
  for (const entry of value) {
    if (!isPlainObject(entry))
      return undefined
    const type = entry.type
    if (type !== 'file' && type !== 'chatnode')
      return undefined
    deliveries.push({ type })
  }
  return deliveries
}

/**
 * Validate one raw definition mapping and fill in every default.
 *
 * `projectDir` is the directory a relative `cwd` resolves against and the value
 * an absent `cwd` falls back to; `defaultTimezone` is used only when the field
 * is absent — an explicitly invalid zone is always a rejection, because
 * silently substituting a zone would move every future fire time.
 */
function resolveJob(
  raw: Record<string, unknown>,
  source: RoutineSource,
  file: string,
  projectDir: string,
  defaultTimezone: string,
): Resolution {
  const name = raw.name
  if (typeof name !== 'string' || name.trim() === '')
    return { ok: false, error: 'field "name" is required' }
  if (!NAME_PATTERN.test(name) || name.length > NAME_MAX_LENGTH)
    return { ok: false, error: 'field "name" must match [a-z0-9][a-z0-9-]* and be at most 64 characters' }

  const schedule = raw.schedule
  if (typeof schedule !== 'string' || schedule.trim() === '')
    return { ok: false, error: 'field "schedule" is required' }

  const prompt = raw.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '')
    return { ok: false, error: 'field "prompt" is required' }

  let timezone = defaultTimezone
  if (raw.timezone !== undefined && raw.timezone !== null) {
    const value = raw.timezone
    if (typeof value !== 'string' || value.trim() === '')
      return { ok: false, error: 'field "timezone" is required' }
    if (!isValidTimeZone(value))
      return { ok: false, error: `field "timezone" is not a valid IANA zone (got ${JSON.stringify(value)})` }
    timezone = value
  }

  let profile = DEFAULT_PROFILE
  if (raw.profile !== undefined && raw.profile !== null) {
    const value = raw.profile
    if (typeof value !== 'string' || value.trim() === '')
      return { ok: false, error: 'field "profile" must be a non-empty string' }
    profile = value
  }

  let overlap = DEFAULT_OVERLAP
  if (raw.overlap !== undefined && raw.overlap !== null) {
    const value = toOverlapPolicy(raw.overlap)
    if (value === undefined)
      return { ok: false, error: 'field "overlap" must be one of skip, queue, cancel-previous' }
    overlap = value
  }

  let timeoutMin = DEFAULT_TIMEOUT_MIN
  if (raw.timeoutMin !== undefined && raw.timeoutMin !== null) {
    const value = raw.timeoutMin
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > TIMEOUT_MAX_MIN) {
      return {
        ok: false,
        error: `field "timeoutMin" must be a whole number of minutes between 1 and ${TIMEOUT_MAX_MIN}`,
      }
    }
    timeoutMin = value
  }

  let deliver = defaultDeliver()
  if (raw.deliver !== undefined && raw.deliver !== null) {
    const value = toDeliveries(raw.deliver)
    if (value === undefined)
      return { ok: false, error: 'field "deliver" must be a list of { type: "file" | "chatnode" }' }
    // An empty list still owes the run somewhere to land: the file digest.
    deliver = value.length > 0 ? value : defaultDeliver()
  }

  let cwd = projectDir
  if (raw.cwd !== undefined && raw.cwd !== null) {
    const value = raw.cwd
    if (typeof value !== 'string' || value.trim() === '')
      return { ok: false, error: 'field "cwd" must be a non-empty path string' }
    const expanded = expandHome(value)
    cwd = isAbsolute(expanded) ? expanded : resolve(projectDir, expanded)
  }

  return {
    ok: true,
    job: {
      name,
      schedule,
      timezone,
      prompt,
      cwd,
      profile,
      overlap,
      timeoutMin,
      deliver,
      source,
      file,
      // Pause and "in flight" are runtime facts owned by the service, not fields
      // of a definition; the scheduler fills them from state and its run table.
      paused: false,
      running: false,
    },
  }
}

/**
 * Write `body` to `path` through a sibling temp file and a rename.
 *
 * Both engines may write the same files, so a reader must never observe a
 * partial document: the rename publishes the whole file or nothing. The
 * `.tmp-<pid>` suffix mirrors what `dsh-routines` leaves behind (and keeps two
 * processes from sharing a temp path).
 */
function writeFileAtomically(path: string, body: string): void {
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

/** Parse and validate one definition file into a job, or report why not. */
function loadJobFileWith(
  file: string,
  source: RoutineSource,
  projectDir: string,
  defaultTimezone: string,
): CronJob | InvalidJob {
  const name = fileStem(file)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  }
  catch (error) {
    return invalidJob(name, file, source, `cannot read the file: ${errorMessage(error)}`)
  }
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  }
  catch (error) {
    // js-yaml reports a snippet plus a caret across several lines; the panel
    // wants one line, so only the headline survives.
    return invalidJob(name, file, source, `invalid YAML: ${errorMessage(error)}`)
  }
  if (!isPlainObject(parsed))
    return invalidJob(name, file, source, 'the file must hold a YAML mapping of job fields')
  const resolution = resolveJob(parsed, source, file, projectDir, defaultTimezone)
  return resolution.ok ? resolution.job : invalidJob(name, file, source, resolution.error)
}

/** The human half of a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The file names of a directory's YAML definitions, sorted for stable reads. */
function listYamlFiles(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    // A missing or unreadable directory simply holds no definitions.
    return []
  }
  return entries
    .filter((entry) => !entry.isDirectory() && isYamlFile(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Order two jobs by name, by code unit (stable across hosts and locales). */
function compareJobsByName(a: CronJob, b: CronJob): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** The harness home: `$DSH_HOME` when non-empty, else `~/.dsh`. */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/** Expand `~/x` against the OS home; leave every other path untouched. */
export function expandHome(path: string): string {
  if (path === '~')
    return homedir()
  if (path.startsWith('~/'))
    return join(homedir(), path.slice(2))
  return path
}

/**
 * The two definition directories for one project.
 *
 * `globalDir` defaults to `$DSH_HOME/routines` (usually `~/.dsh/routines`) and
 * may itself be written with a leading `~`, which is how a user configures a
 * path by hand.
 */
export function resolveDirs(projectDir: string, globalDir?: string): StoreDirs {
  const global = globalDir === undefined || globalDir.trim() === ''
    ? join(dshHome(), 'routines')
    : expandHome(globalDir)
  return { project: join(projectDir, '.dsh', 'routines'), global }
}

/**
 * Read every definition, project files overriding global ones by name.
 *
 * `defaults.projectDir` is the directory an absent `cwd` falls back to and a
 * relative `cwd` resolves against (the service passes the real project
 * directory); without it the store's own project directory is used, which keeps
 * `readJobs(dirs)` a complete call on its own. `defaults.timezone` fills in an
 * absent `timezone` field.
 *
 * The returned jobs are definitions only: `paused`/`running` are `false` and
 * the run-derived fields are unset, because those come from the state file and
 * the scheduler, not from a definition.
 */
export function readJobs(
  dirs: StoreDirs,
  defaults?: { timezone?: string; projectDir?: string },
): { jobs: CronJob[]; invalid: InvalidJob[] } {
  const timezone = defaults?.timezone ?? DEFAULT_TIMEZONE
  const projectDir = defaults?.projectDir ?? dirs.project
  const byName = new Map<string, CronJob>()
  const invalid: InvalidJob[] = []

  const scan = (dir: string, source: RoutineSource): void => {
    for (const name of listYamlFiles(dir)) {
      const file = join(dir, name)
      const result = loadJobFileWith(file, source, projectDir, timezone)
      if ('error' in result) {
        invalid.push(result)
        continue
      }
      // Global is scanned first, so a project file of the same name replaces it.
      const existing = byName.get(result.name)
      if (existing === undefined || source === 'project')
        byName.set(result.name, result)
    }
  }

  scan(dirs.global, 'global')
  scan(dirs.project, 'project')
  return { jobs: [...byName.values()].sort(compareJobsByName), invalid }
}

/**
 * Load one definition file.
 *
 * Never throws: an unreadable file, a YAML syntax error or a failed field check
 * all come back as an `InvalidJob` naming the file, which is what lets one bad
 * file sit in a directory full of good ones without hiding them.
 */
export function loadJobFile(file: string, source: RoutineSource, projectDir: string): CronJob | InvalidJob {
  return loadJobFileWith(file, source, projectDir, DEFAULT_TIMEZONE)
}

/** The path a definition of `name` occupies in one scope. */
export function jobFilePath(dirs: StoreDirs, scope: RoutineSource, name: string): string {
  return join(scope === 'global' ? dirs.global : dirs.project, `${name}.yaml`)
}

/**
 * The YAML document for one job: definition fields only, in a stable order.
 *
 * `cwd` is written only when the caller supplied one. Writing back the resolved
 * default would freeze the directory a run happened to be created from into the
 * file, and would silently outlive a project that moved.
 */
function jobDocument(job: CronJob, input: JobInput): Record<string, unknown> {
  const document: Record<string, unknown> = {
    name: job.name,
    schedule: job.schedule,
    timezone: job.timezone,
    prompt: job.prompt,
  }
  if (input.cwd !== undefined && input.cwd !== null)
    document.cwd = job.cwd
  document.profile = job.profile
  document.overlap = job.overlap
  document.timeoutMin = job.timeoutMin
  document.deliver = job.deliver.map((delivery) => ({ type: delivery.type }))
  return document
}

/** The definition fields of a caller-supplied job, for validation and writing. */
function definitionFields(job: JobInput): Record<string, unknown> {
  return {
    name: job.name,
    schedule: job.schedule,
    timezone: job.timezone,
    prompt: job.prompt,
    cwd: job.cwd,
    profile: job.profile,
    overlap: job.overlap,
    timeoutMin: job.timeoutMin,
    deliver: job.deliver,
  }
}

/**
 * Reject a caller-supplied field the definition format does not have.
 *
 * A typo like `schedul:` would otherwise be dropped and turn into a confusing
 * "field schedule is required" later; naming the field here points the editor
 * at the actual mistake. Derived `CronJob` fields are tolerated so a job that
 * was read can be written straight back.
 */
function assertKnownFields(job: JobInput): void {
  for (const key of Object.keys(job)) {
    if (key === SCOPE_KEY || DEFINITION_KEYS.includes(key) || DERIVED_KEYS.includes(key))
      continue
    throw new Error(`unknown field "${key}"`)
  }
}

/**
 * Validate and persist one definition, and return the job it now describes.
 *
 * Throws an `Error` naming the offending field — the tool and the settings page
 * both surface that message verbatim, so it is written to be read by a person.
 * The write is atomic, and `JobInput.scope` (`global` writes into
 * `$DSH_HOME/routines`) decides the directory.
 */
export function writeJob(dirs: StoreDirs, job: JobInput): CronJob {
  assertKnownFields(job)
  // An absent timezone is not an error here either: the definition format and
  // the loader both treat it as "use the default zone".
  const scope: RoutineSource = job.scope === 'global' ? 'global' : 'project'
  const file = jobFilePath(dirs, scope, typeof job.name === 'string' ? job.name : '')
  const resolution = resolveJob(definitionFields(job), scope, file, dirs.project, DEFAULT_TIMEZONE)
  if (!resolution.ok)
    throw new Error(resolution.error)
  const body = yaml.dump(jobDocument(resolution.job, job), { lineWidth: -1, noRefs: true })
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomically(file, body)
  return resolution.job
}

/**
 * Delete a definition by name, project scope first.
 *
 * Returns whether anything was deleted. A name outside the job-name grammar is
 * refused outright: it could otherwise resolve to a path outside the routines
 * directory, and "delete the file this name points at" is not a safe reading of
 * a bad name.
 */
export function removeJob(dirs: StoreDirs, name: string): boolean {
  if (!NAME_PATTERN.test(name) || name.length > NAME_MAX_LENGTH)
    return false
  for (const scope of ['project', 'global'] as const) {
    try {
      unlinkSync(jobFilePath(dirs, scope, name))
      return true
    }
    catch {
      // Not in this scope (or not removable); try the other one.
    }
  }
  return false
}

/** `true` when a watcher event concerns a definition file. */
function isDefinitionEvent(filename: string | Buffer | null): boolean {
  // `null` means the platform could not name the entry; assume it matters.
  if (filename === null)
    return true
  return isYamlFile(typeof filename === 'string' ? filename : filename.toString('utf8'))
}

/**
 * Watch both definition directories and debounce their events into one call.
 *
 * Why a watcher and not a timer: definitions are edited by hand, by a tool and
 * by the settings page, and the panel should reflect all three within a moment
 * of the save. Events are filtered to YAML files (the state file lives in the
 * same directory and is written far more often) and debounced, because one
 * atomic save surfaces as several events on most platforms.
 *
 * A directory that does not exist yet is polled rather than throwing — a fresh
 * project has no `.dsh/routines` until the first job is written. The poll uses
 * `unref`, so a store that is never disposed still cannot hold the host process
 * open, and `dispose()` clears watchers, polls and the pending debounce.
 */
export function watchJobs(dirs: StoreDirs, onChange: () => void): { dispose(): void } {
  const watches: DirWatch[] = []
  let disposed = false
  let debounce: NodeJS.Timeout | undefined

  /** Collapse a burst of events into one notification. */
  function fire(): void {
    if (disposed)
      return
    if (debounce !== undefined)
      clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      if (!disposed)
        onChange()
    }, WATCH_DEBOUNCE_MS)
  }

  /** Re-check a missing directory until it appears, then attach the watcher. */
  function startPolling(entry: DirWatch): void {
    if (disposed || entry.poll !== undefined)
      return
    const timer = setInterval(() => {
      if (disposed || !existsSync(entry.dir))
        return
      clearInterval(timer)
      entry.poll = undefined
      attach(entry)
      // The directory appeared, which in practice means definitions landed in
      // it: notify, so a job created before the store watched it is not missed.
      fire()
    }, WATCH_POLL_MS)
    timer.unref()
    entry.poll = timer
  }

  /** Attach one watcher, falling back to polling when the platform refuses. */
  function attach(entry: DirWatch): void {
    if (disposed)
      return
    let watcher: FSWatcher
    try {
      watcher = watch(entry.dir, (_event, filename) => {
        if (isDefinitionEvent(filename))
          fire()
      })
    }
    catch {
      // Directory gone, or no watchers left on this host.
      startPolling(entry)
      return
    }
    watcher.on('error', () => {
      // An unhandled `error` event would take the host down; drop the watcher
      // and let polling pick the directory back up when it returns.
      try {
        watcher.close()
      }
      catch {
        // Already closed.
      }
      if (entry.watcher === watcher)
        entry.watcher = undefined
      startPolling(entry)
    })
    entry.watcher = watcher
  }

  for (const dir of [dirs.project, dirs.global]) {
    // The same directory in both scopes is one directory to watch.
    if (watches.some((entry) => entry.dir === dir))
      continue
    watches.push({ dir, watcher: undefined, poll: undefined })
  }

  for (const entry of watches) {
    if (existsSync(entry.dir))
      attach(entry)
    else
      startPolling(entry)
  }

  return {
    dispose(): void {
      disposed = true
      if (debounce !== undefined) {
        clearTimeout(debounce)
        debounce = undefined
      }
      for (const entry of watches) {
        if (entry.poll !== undefined) {
          clearInterval(entry.poll)
          entry.poll = undefined
        }
        if (entry.watcher !== undefined) {
          try {
            entry.watcher.close()
          }
          catch {
            // Already closed.
          }
          entry.watcher = undefined
        }
      }
      watches.length = 0
    },
  }
}
