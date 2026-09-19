# dsh-cron — internal contract

`dsh-cron` is a DeepSeek Harness plugin bundle: a host half (scheduler, job
store, model tools, Remote face) and a browser half (a Settings page that shows
and edits the same jobs). This file is the interface contract the halves and the
workstreams code against. It is the source of truth for module boundaries.

## What the plugin owns

| Concern | Owner module |
| --- | --- |
| Cron math, human descriptions | `src/cron.ts` (browser-safe, pure) |
| Job definition files (YAML) | `src/store.ts` (Node only) |
| Durable pause/last-run state | `src/state.ts` (Node only) |
| Run records + digests | `src/runs.ts` (Node only) |
| Spawning one unattended run | `src/runner.ts` (Node only) + `src/run.ts` (child driver) |
| Due-time decisions, overlap, jobs | `src/scheduler.ts` (Node only) |
| Facade for tools + Remote | `src/service.ts` (`ctx.cron`) |
| Model-facing tools | `src/tools.ts` |
| Runtime skill | `src/skill.ts` |
| Remote namespace `dshCron` | `src/wire.ts` + `src/typert.host.ts` + `src/client/remote.ts` |
| Settings page | `src/client/*` |
| Plugin assembly | `src/index.ts` + `cordis.patch.yml` |

## Compatibility contract (do not break)

`dsh-routines` (already installed in the user's `web` profile) writes the same
artifacts. Definitions, state and run records must stay mutually readable:

- Definitions: `<projectDir>/.dsh/routines/*.yaml` and `~/.dsh/routines/*.yaml`
  (project overrides global on `name`), with fields
  `name, schedule, timezone, prompt, cwd?, profile, overlap, timeoutMin, deliver`.
- State: `<projectDir>/.dsh/routines/state.json`, keys `paused: string[]`,
  `lastRunAt: Record<string, number>`. Extra keys are allowed (they ignore
  unknown keys; we ignore theirs).
- Run records: `<cwd>/.dsh/routines/runs/<runId>.json` (schema: `RunRecord` in
  `src/types.ts`), plus a human `<runId>.md` digest next to it.
- Orchestration: when another scheduler service is mounted (`routinesScheduler`),
  our scheduler stands down by default (`engine: auto`) and the panel says so.

## Module interfaces

### `src/cron.ts` — browser-safe, no Node imports, no dependencies

```ts
export class ScheduleError extends Error {}
export interface ParsedSchedule {
  minute: Set<number>; hour: Set<number>; dayOfMonth: Set<number>; month: Set<number>; dayOfWeek: Set<number>;
  /** true when the field was `*` (used by the DOM/DOW Vixie rule). */
  domRestricted: boolean; dowRestricted: boolean;
  source: string; normalized: string;
}
export function parseSchedule(expr: string): ParsedSchedule
export function normalizeSchedule(expr: string): string
export function nextRunAfter(expr: string, timezone: string, after: Date): Date | undefined
export function nextRuns(expr: string, timezone: string, after: Date, count: number): Date[]
export function describeSchedule(expr: string): string
export function parseEvery(expr: string): number | undefined // 'every 30m' → 30
```

Required behaviour:
- Accept `*`, lists (`1,2`), ranges (`9-17`), steps (`*/15`, `9-17/2`), `?` as
  `*`, three-letter day/month names (case-insensitive), and macros
  `@hourly|@daily|@midnight|@weekly|@monthly|@yearly|@annually`.
- Accept `every 30m`, `every 4h`, `every 2h30m`, `every 90s` as an interval.
- Reject seconds-bearing (6-field) expressions with a clear error.
- Vixie rule: when BOTH day-of-month and day-of-week are restricted, a day
  matches when either matches.
- Timezone math with `Intl.DateTimeFormat` only (no dependencies). Must resolve
  a wall-clock time to an instant and handle DST transitions without guessing
  the host zone. Must be fast: a next-run search is bounded (≤ ~1600 days) and
  must not call `Intl` per minute.
- `describeSchedule` returns a short English phrase: `every day at 09:00`,
  `every 15 minutes`, `weekdays at 08:30`, `every Sunday at 00:00`,
  `every 4 hours`, `on the 1st of every month at 03:00`, …

### `src/store.ts` — Node only

```ts
export interface StoreDirs { project: string; global: string }
export function dshHome(): string
export function expandHome(path: string): string
export function resolveDirs(projectDir: string, globalDir?: string): StoreDirs
export function readJobs(dirs: StoreDirs): { jobs: CronJob[]; invalid: InvalidJob[] }
export function loadJobFile(file: string, source: RoutineSource, projectDir: string): CronJob | InvalidJob
export function jobFilePath(dirs: StoreDirs, scope: RoutineSource, name: string): string
export function writeJob(dirs: StoreDirs, job: JobInput & { scope?: RoutineSource }): CronJob
export function removeJob(dirs: StoreDirs, name: string): boolean
export function watchJobs(dirs: StoreDirs, onChange: () => void): { dispose(): void }
```

- YAML through `js-yaml` (`load`/`dump`), atomic writes (temp + rename).
- A malformed file becomes an `InvalidJob` (name from the file stem when the
  document is unreadable); it never throws out of `readJobs`.
- Name rule `[a-z0-9][a-z0-9-]*`, ≤ 64 chars; unknown fields are rejected on
  write, ignored on read.
- Defaults at load: `timezone` (config value), `profile: headless`,
  `overlap: skip`, `timeoutMin: 45`, `deliver: [{type:'file'}]`, `cwd` = project
  dir. `paused` is NOT a file field — it comes from `state.json`.
- `writeJob` rejects a name that already exists in the other scope? No: it
  writes into the requested scope and reports the file it wrote.

### `src/state.ts` — Node only

```ts
export interface JobStatusRecord { status: RunStatus; error?: string; at: number }
export interface SchedulerState {
  paused: string[]
  lastRunAt: Record<string, number>
  lastStatus: Record<string, JobStatusRecord>
}
export function statePathFor(projectDir: string): string
export function loadState(projectDir: string): SchedulerState
export function saveState(projectDir: string, state: SchedulerState): void
export const EMPTY_STATE: SchedulerState
```

Corrupt or absent file: return `EMPTY_STATE`. Writes are atomic.

### `src/runs.ts` — Node only

```ts
export function runsDirFor(cwd: string): string
export function recordPathFor(cwd: string, runId: string): string
export function readRun(cwd: string, runId: string): RunRecord | undefined
export function listRuns(cwd: string, limit?: number): RunRecord[]  // newest first
export function writeRun(cwd: string, record: RunRecord): void      // atomic + <runId>.md digest
export function pruneRuns(cwd: string, keep: number): void
```

Unparsable records are skipped, never thrown. Missing `durationMs` is not
invented.

## Remote contract

Namespace `dshCron`, cordis service `cron`, all payloads JSON strings
(`src/wire.ts` owns the descriptors; both faces freeze the same objects):

| Method | Parameters | Result |
| --- | --- | --- |
| `status` | — | `CronSnapshot` |
| `mutate` | `requestJson: JobMutation` | `MutationResult` |
| `history` | `name: string`, `limit?: number` | `RunRecord[]` |
| `preview` | `schedule: string`, `timezone?: string` | `SchedulePreview` |

## Client contract

- Plugins mount through `ctx.slots.inject('settings.section', …)` and register
  `{ name: 'settings.section', id: 'cron', order, label, locale, inject }`.
- The page renders `CronSnapshot` only: no RPC outside `dshCron.*`.
- Styles ship as a scoped string installed into one `<style data-dsh-cron>`
  element; selectors are scoped under `[data-dsh-cron]` and use theme tokens
  (`var(--dsw-...)`) so both colour schemes work.
- Copy goes through the plugin locale namespace; `en` and `ru` dictionaries
  minimum (the harness locale registry accepts `en | zh`; `ru` is served by the
  user's local Russian locale plugin, so keys must exist as plain fallbacks too).

## Verification

- `npm run typecheck` — host and client programs both clean.
- `npm run build` — `lib/index.js` (host) + `lib/client.js` (closure factory).
- `npm test` — unit tests for `cron`, `store`, `state`, `runs`, `scheduler`
  decisions, and the tools' pure parts.
