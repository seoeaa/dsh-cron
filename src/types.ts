/**
 * dsh-cron — the shared vocabulary of one scheduled job.
 *
 * Browser-safe by construction: this module is inlined into the Web client
 * bundle, so it imports nothing from Node and nothing from the harness. The
 * host half, the tools, the Remote face and the settings page all speak these
 * types, which is what keeps one snapshot shape from drifting into two.
 *
 * The YAML definition on disk uses the same field names (`schedule`,
 * `timezone`, `prompt`, `cwd`, `profile`, `overlap`, `timeoutMin`, `deliver`),
 * because that is the format `dsh-routines` already writes and users already
 * have on disk. Compatibility is the point: definitions, the pause state and
 * the run records stay readable by either engine.
 *
 * @module dsh-cron/types
 */

/** How a job behaves when its previous run is still going at the next due time. */
export type OverlapPolicy = 'skip' | 'queue' | 'cancel-previous'

/** Where a finished run's digest is delivered. `file` is always implied. */
export type DeliveryKind = 'file' | 'chatnode'

/** One delivery target declared by a job definition. */
export interface Delivery {
  type: DeliveryKind
}

/** Whether a definition came from the project tree or the global home. */
export type RoutineSource = 'project' | 'global'

/** Terminal or live status of one run. `skipped` records an overlap skip. */
export type RunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'timeout'
  | 'skipped'

/** What asked for the run. */
export type RunTrigger = 'schedule' | 'manual'

/** One permission request auto-denied while a run was unattended. */
export interface DeniedApproval {
  toolName: string
  reason?: string
}

/** One delivery attempt recorded on a finished run. */
export interface DeliveryResult {
  type: DeliveryKind
  ok: boolean
  error?: string
}

/**
 * The full audit record of one run, persisted as JSON next to the job's cwd
 * (`<cwd>/.dsh/routines/runs/<runId>.json`). The child run process writes the
 * run facts; the scheduler fills anything missing and appends `deliveries`.
 */
export interface RunRecord {
  runId: string
  routine: string
  profile: string
  cwd: string
  status: RunStatus
  trigger: RunTrigger
  startedAt: number
  finishedAt?: number
  durationMs?: number
  /** Subprocess exit code, when the run reached a process exit. */
  exitCode?: number
  /** The run's one-shot session id, replay-able later. */
  sessionId?: string
  /** The digest: the last assistant message, or a summary of the session. */
  digest?: string
  /** Permission requests auto-denied by the unattended policy. */
  denied?: DeniedApproval[]
  /** Delivery attempts for this run. */
  deliveries?: DeliveryResult[]
  /** Human-readable failure reason for non-completed runs. */
  error?: string
}

/** A definition file that failed to parse or validate. */
export interface InvalidJob {
  /** Name inferred from the file, when one could be read at all. */
  name: string
  /** Absolute path of the offending YAML file. */
  file: string
  source: RoutineSource
  error: string
}

/** One scheduled job as the panel and the tools see it. */
export interface CronJob {
  /** `[a-z0-9][a-z0-9-]*`, at most 64 characters. */
  name: string
  /** `0 2 * * *`, `@daily`, `@hourly`, or `every 30m`. */
  schedule: string
  /** IANA zone used for schedule math. Never the host zone by default. */
  timezone: string
  /** The prompt one run executes. */
  prompt: string
  /** Absolute working directory of the run; also where its digest lands. */
  cwd: string
  /** DSH profile the run boots. */
  profile: string
  overlap: OverlapPolicy
  /** Hard stop in minutes. */
  timeoutMin: number
  deliver: Delivery[]
  source: RoutineSource
  /** Absolute path of the YAML file that defines this job. */
  file: string
  /** Whether the job is paused. */
  paused: boolean
  /** Next fire time as an ISO instant, when the schedule can be resolved. */
  nextRunAt?: string
  /** Last observed start as an ISO instant. */
  lastRunAt?: string
  /** Last observed terminal status. */
  lastStatus?: RunStatus
  /** Last observed failure text. */
  lastError?: string
  /** Whether a run of this job is in flight right now. */
  running: boolean
}

/** Which engine currently owns scheduling, and why. */
export interface EngineState {
  /** `own` schedules here; `companion` leaves scheduling to another plugin. */
  mode: 'own' | 'companion'
  /** Cordis service key of the engine that owns scheduling, when not ours. */
  owner?: string
  /** Human-readable explanation for the panel banner. */
  reason?: string
}

/** One reachable delivery target, discovered from the mounted services. */
export interface DeliveryTarget {
  kind: DeliveryKind | 'telegram'
  /** Stable id used inside a job definition. */
  id: string
  /** Human label for the editor. */
  label: string
  /** Whether the capability is mounted right now. */
  available: boolean
  /** Why it is unavailable, or how it behaves. */
  note?: string
}

/** Everything the panel needs for one render pass. */
export interface CronSnapshot {
  jobs: CronJob[]
  invalid: InvalidJob[]
  engine: EngineState
  /** Directories watched for definitions. */
  dirs: { project: string; global: string }
  /** Names of jobs with a run in flight. */
  running: string[]
  /** Names paused via the durable state file. */
  paused: string[]
  /** Reachable delivery targets. */
  targets: DeliveryTarget[]
  /** Host clock at snapshot time (ISO), so the panel can show drift. */
  now: string
  /** Plugin id, for diagnostics in the panel. */
  plugin: string
  /** Plugin version. */
  version: string
}

/** A resolved schedule preview returned by the validator. */
export interface SchedulePreview {
  ok: boolean
  /** Human-readable description of the expression. */
  description: string
  /** Error text when `ok` is false. */
  error?: string
  /** The next few fire times as ISO instants. */
  nextRuns: string[]
  /** The schedule normalized to five fields, when it could be understood. */
  normalized?: string
}

/** What to do with one job definition, sent from the panel. */
export type JobMutation =
  | { action: 'save'; job: JobInput }
  | { action: 'remove'; name: string }
  | { action: 'pause'; name: string }
  | { action: 'resume'; name: string }
  | { action: 'run'; name: string }

/** The user-supplied half of a job definition. */
export interface JobInput {
  name: string
  schedule: string
  /** IANA zone; the plugin's configured default applies when omitted. */
  timezone?: string
  prompt: string
  cwd?: string
  profile?: string
  overlap?: OverlapPolicy
  timeoutMin?: number
  deliver?: Delivery[]
  /** Where to write a project-scoped definition; `global` writes to `~/.dsh`. */
  scope?: RoutineSource
}

/** The outcome of one mutation, as the panel receives it. */
export interface MutationResult {
  ok: boolean
  /** Human-readable summary of what happened. */
  message: string
  /** Field-level failures, keyed by a short reason. */
  error?: string
  /** The refreshed snapshot, so the panel needs no second round trip. */
  snapshot?: CronSnapshot
}
