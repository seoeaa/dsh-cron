# dsh-cron — the Web settings page

Control-by-control documentation of the `dsh-cron` settings section: what the
user sees, which Remote method a control calls, which host method that reaches,
and which file or service changes as a result. Written for a maintainer, and for
anyone who needs to reason about a write the panel performed.

- Section: `settings.section`, id `cron`, order `30`, label from the locale key
  `nav` ("Scheduled agents" / "Задачи по расписанию").
- Locale namespace: `settings.dshCron`, registered for `en` and `ru`; both
  dictionaries share one key set (`DshCronLocaleKey` is derived from the English
  one).
- Source: `src/client/index.ts` (registration), `src/client/CronSection.tsx` (the
  page), `src/client/JobEditor.tsx` (editor), `src/client/HistoryList.tsx`
  (history), `src/client/present.ts` (pure formatting), `src/client/styles.ts`
  (the scoped stylesheet).

## 1. Data flow

The page renders exactly one object, `CronSnapshot`, and issues no RPC other than
the four methods of the `dshCron` namespace.

| When | Call | What happens |
| --- | --- | --- |
| Page mount, and every `Refresh` / `Retry` press | `dshCron/status` | `CronService.snapshot()` reads both definition directories, the state file, the in-flight table and the delivery targets, and returns one `CronSnapshot` (the page renders the jobs, the invalid files and the clock; the editor is what reads `targets`) |
| Any mutating control | `dshCron/mutate` with the encoded `JobMutation` | `CronService.mutate()` applies it and answers `{ ok, message, error?, snapshot }` |
| `History` on a row | `dshCron/history` with `(name, 100)` | `CronService.records(name, 100)` → `listRuns(job.cwd, 100)` |
| — | `dshCron/preview` | Wired into the page's injected face, but the editor computes schedule feedback locally (see §5); nothing in the client calls it today |

Consequences a maintainer should keep:

- **A mutation never needs a second round trip.** The response carries the
  refreshed snapshot, and the page replaces its state with it.
- **There is no push channel.** The host does not notify the browser; the table
  changes when the page loads, when `Refresh` is pressed, and after an action the
  user took. `CronService.onChange()` exists on the host but the client does not
  subscribe.
- **A failed refresh keeps the last good snapshot** and shows the failure line;
  only a failed *first* load replaces the page with an error block and `Retry`.
- **The page's clock is `snapshot.now`**, the host's clock at snapshot time, so
  "in 3h" is relative to the host, not to the browser.

## 2. Controls, and what they touch

### Toolbar

| Control | Behaviour | Remote | Host | Touches |
| --- | --- | --- | --- | --- |
| `Refresh` | Re-fetches `status`; the table stays mounted and shows an "updating" flag while it loads, then the button is disabled until it settles. | `dshCron/status` | `snapshot()` | reads only |
| `New job` | Opens the editor in create mode. | — | — | — |
| Plugin name and version | Rendered from `snapshot.plugin` / `snapshot.version`. | — | — | — |

### Engine ownership (not rendered)

`CronService.resolveEngine()` decides once at mount whether this plugin fires
runs (`{ mode: 'own' }`) or leaves that to another scheduler
(`{ mode: 'companion', owner, reason }`). The page does **not** render that
decision: the panel shows and edits definitions, and the same facts reach the
model through the `cron_list` tool, which reports the owning engine in words.
Changing ownership means editing the config row (`engine`) and restarting the
profile — the sweep starts once, in `apply()`.

### Invalid definition files

Rendered from `snapshot.invalid` (`InvalidJob[]`), which `readJobs()` filled while
reading the two directories. Each entry shows the file path and a one-line reason
(`invalid YAML: …`, `field "name" is required`, `field "timezone" is not a valid
IANA zone (got …)`, …). These jobs are skipped by the sweep, the tools and the
table until the file is fixed; the page never repairs or deletes one.

### Jobs table

One row per job, one column per `CronJob` field:

| Column | Field | Notes |
| --- | --- | --- |
| `Name` | `name` | Plus a `paused` badge and a `running` badge when `paused` or `running` is true |
| `Schedule` | `schedule` | Human description from `describeSchedule()`, plus the raw expression in monospace; on a parse error the raw expression is shown alone |
| `Timezone` | `timezone` | Raw zone name |
| `Next run` | `nextRunAt` | Relative to `snapshot.now`; tooltip shows the absolute local time; `—` when there is no next run (paused, or nothing matches) |
| `Last run` | `lastRunAt`, `lastStatus`, `lastError` | Status dot (tone from `runStatusTone`), status label, relative time; tooltip adds the absolute time and the last error; `—` when the job never ran |
| `Source` | `source` | `project` or `global` |
| `Overlap` | `overlap` | `skip`, `queue` or `cancel previous` |
| `Working dir` | `cwd` | Truncated to 48 characters with both ends kept; tooltip shows the full path |
| `Profile` | `profile` | Raw profile name |
| `Actions` | — | See below |

Empty state: "No jobs yet." plus the hint to press `New job`.

### Row actions

| Action | Remote mutation | Host path | Files / services touched | What the state change means |
| --- | --- | --- | --- | --- |
| `Run now` | `{ action: 'run', name }` | `CronService.runNow()` → `launchScheduled(job, 'manual')` → `RunLauncher.launch()` | writes `<cwd>/.dsh/routines/runs/<runId>.json` (status `running`), writes the generated overlay `<cwd>/.dsh/routines/runs/.<runId>.patch.yml`, spawns `dsh --profile … --patch … -- <prompt>`, then updates `state.json` (`lastRunAt` = now, `lastStatus` = running); the child later rewrites the record and adds `<runId>.md` | A real unattended run starts now. It also advances the durable anchor to the moment you clicked, so an occurrence that was already due is consumed instead of firing again. Disabled with `allowRunNow: false` — the button is still rendered, and the action then fails with the host's message |
| `Pause` | `{ action: 'pause', name }` | `setPaused(name, true)` → `mutateState()` | `<projectDir>/.dsh/routines/state.json`, key `paused` (a sorted array of names) | The job keeps its definition, its history and its anchor, but the sweep skips it. Disabled while the job is running |
| `Resume` | `{ action: 'resume', name }` | `setPaused(name, false)` | same file, name removed from `paused` | The job fires on its schedule again; the next fire time is computed from the last anchor |
| `Edit` | opens the editor, then `{ action: 'save', job }` (§5) | `CronService.save()` → `writeJob()` | rewrites the definition YAML in the chosen scope, atomically | Defined fields change; `paused`, `running`, the anchor and the run history are untouched |
| `History` | `dshCron/history (name, 100)` | `CronService.records()` → `listRuns()` | reads `<cwd>/.dsh/routines/runs/*.json` | Read-only |
| `Copy prompt` | — | `writeClipboard(job.prompt)` | the browser clipboard only | Never disabled, never touches the host |
| `Delete` | two steps: the button reveals an inline confirmation row, then `{ action: 'remove', name }` | `CronService.remove()` → `removeJob()` | `unlink` of the definition file: project scope first, then global scope | The definition is gone; **run records and their digests stay on disk** under the job's `cwd`, and the panel says so in the confirmation. A `paused` entry for that name may remain in `state.json` and is harmless |

While a mutation for a row is in flight, that row's action buttons are disabled;
`aria-busy` is set on the page while it is loading or refreshing. Every mutation
shows a toast: "Done." on success, "The operation failed. `<message>`" on failure.

### Editor

`New job` opens it empty; `Edit` opens it filled from the job. Save posts one
`save` mutation with a `JobInput`; the host returns the refreshed snapshot and the
dialog closes on success. A rejection (`result.error ?? result.message`) is shown
inside the dialog, and the dialog stays open.

| Field | `JobInput` / YAML key | Validation before save |
| --- | --- | --- |
| `Name` | `name` | `[a-z0-9][a-z0-9-]*`, at most 64 characters (`validateJobName`) |
| `Schedule` template | — | Picker only; choosing a preset writes its expression. Presets: every 15 minutes `*/15 * * * *`, hourly `0 * * * *`, daily at 09:00 `0 9 * * *`, weekdays at 08:30 `30 8 * * 1-5`, weekly `0 0 * * 0`, monthly `0 0 1 * *`, plus "custom expression" |
| `Schedule` | `schedule` | Non-empty and parseable; the raw expression is kept, so an interval (`every 30m`) or a macro survives a save |
| Live preview | — | Local `describeSchedule()` + `nextRuns(expr, tz, now, 3)` from `src/cron.ts`; an invalid expression shows the parser's error text instead of a preview |
| `Timezone` | `timezone` | Non-empty; the host additionally rejects a name `Intl` does not know. A datalist suggests `UTC`, `Europe/Moscow`, `Europe/London`, `Europe/Berlin`, `Asia/Dubai`, `Asia/Shanghai`, `Asia/Tokyo`, `America/New_York` |
| `Prompt` | `prompt` | Non-empty |
| `Working directory` | `cwd` | Optional; empty means "the scope directory" and the host then writes no `cwd` key at all, so the default is resolved at load time. The placeholder shows `snapshot.dirs.project` |
| `Profile` | `profile` | Optional; empty is sent as absent, and the host falls back to `headless` |
| `Overlap` | `overlap` | `skip` (default), `queue`, `cancel-previous` |
| `Timeout (minutes)` | `timeoutMin` | A positive number; the host enforces 1–1440 |
| `Deliver digest to` | `deliver` | Checkboxes for `file` (always available) and the conversation node (disabled while `ctx.chatnode` is absent, with the reason inline) |
| `Scope` | `scope` | `project` writes `<projectDir>/.dsh/routines/<name>.yaml`, `global` writes `$DSH_HOME/routines/<name>.yaml`. Editing an existing job initializes it from that job's current scope, so an untouched `Scope` is a no-op |

What Save does on the host, in order: `assertKnownFields()` (an unknown key is
refused by name), validation with defaults filled in, then one atomic write
(`<path>.tmp-<pid>` + rename). `cwd` is written only if the field was filled.
Nothing else changes: the pause flag, the anchor and the history are not part of
the file, and saving under a name that exists in the *other* scope creates a
project file that shadows the global one rather than replacing it.

### History dialog

Opened per row, closed by the button, `Escape`, or the mask (the `Modal`
primitive owns all three). One `dshCron/history` call with `limit = 100`, then:

| Element | Source |
| --- | --- |
| Day groups | `groupRunsByDay(records)`: local calendar day of `startedAt`, newest first, labelled `Today` / `Yesterday` / `21 Jul 2026` |
| Status | `record.status` → label and `StateDot` tone |
| Started | `formatAbsoluteTime(startedAt)` plus a relative phrase against `snapshot.now` |
| Duration | `formatDuration(durationMs)`; nothing shown when the record has no duration |
| Session | `record.sessionId` in monospace — the run's session log, replayable later |
| Digest | `record.digest`; collapsed behind `Show more` / `Show less` when it exceeds 400 characters |
| Denied approvals | `record.denied` — one line per tool call the unattended policy denied, with its reason |
| Delivery | `record.deliveries` — per target: delivered, or failed with the error |
| Failure | `record.error`, shown for every status except `completed` and `running` |

Loading, an empty history, and a failed load each have their own line; the dialog
never retries on its own.

## 3. What the page does not do

- It never writes `state.json`, a run record or a digest directly — every write
  goes through `CronService`, which the tools and the sweep use as well.
- It does not create or edit the `chatnode` delivery target, only selects it.
- It cannot cancel a run in flight (`Run now` disables the row's buttons while the
  run is going, but there is no stop control; cancellation exists on the host as
  `CronService.cancel()` and through the harness job registry).
- It does not push or poll: no websocket, no timer, no auto-refresh.
- It does not show the plugins' own runtime warnings; those go to the host logger.
- It calls `dshCron/preview` never (the editor's feedback is computed locally from
  the same `src/cron.ts` the host uses).

## 4. States the page can be in

| State | Trigger | Page |
| --- | --- | --- |
| Loading | first `status` in flight | "Loading…" |
| Load error | `status` rejected | Error block with the message and `Retry` |
| Ready | `snapshot.jobs` and `snapshot.invalid` rendered, toolbar enabled | the table |
| Updating | a mutation or `Refresh` is in flight | the table stays mounted with an "updating" flag |
| Refreshing | a `status` call while a snapshot exists | Table stays mounted, "Updating…" line and a disabled `Refresh` |
| Refresh failed | refresh rejected | The last good snapshot plus an "update failed" line with the error |
| Busy row | a mutation for that row in flight | That row's actions disabled, the toggled button showing "Updating…" |
| Confirming delete | `Delete` pressed | An inline confirmation row with `Delete` and `Cancel` |
