# dsh-cron

Russian version: [README.ru.md](README.ru.md)

`dsh-cron` adds scheduled agents to DeepSeek Harness. A job is one prompt plus a
schedule; each run happens in its own `dsh` process, unattended, and leaves a
record and a digest behind. A person sees and edits the whole set on a settings
page in the Web app, and a model creates, inspects, pauses and deletes jobs with
ordinary tools. Definitions are plain YAML files, so anything this plugin writes
stays editable by hand and by the scheduler plugin that already owns those files.

## Why this exists

The harness ships `@deepseek-ai/dsh-schedule`, whose reminders are session-local:
they arrive as follow-up messages inside the conversation that created them, and
delivery needs a live root agent. A separate scheduler plugin already exists as
well (`@dsh-routines/bundle`): it runs prompts on a cron from YAML files under
`.dsh/routines/`, and it is driven from a terminal — `dsh routines list`,
`dsh routines logs`, `dsh routines pause` — with no settings page in the Web app
and no model-facing tools. What was missing is the half that connects either one
to people and to models: nothing let a person *see and edit* the schedule where
they already are, and nothing gave a model a first-class tool to *create* one.
`dsh-cron` is that half. It reads and writes the same definition, state and
run-record layout `dsh-routines` already uses (see
[Compatibility and coexistence](#compatibility-and-coexistence)), so it is an
addition, not a replacement.

## Install

```console
dsh plugin --profile <profile> add github:seoeaa/dsh-cron
dsh --profile <profile>
```

- `<profile>` is the profile to install into (`web`, `headless`, …). `dsh plugin`
  forwards its arguments to pnpm inside the profile directory and then adds any
  installed package that declares a `dsh.bundle` patch to `dsh.profile.bundles`,
  so this one command both installs the package and mounts it. This package's
  `prepare` script builds both halves, so the install needs its devDependencies.
- `<owner>` is the GitHub account that hosts this repository; the `github:` form is
  the one that needs no registry publication.
- **The profile must be running for schedules to fire.** The sweep that launches
  jobs lives in the plugin's host half, inside that process, so jobs do not fire
  while the profile is stopped. When it starts again, the first sweep sees every
  occurrence that has passed since the last recorded launch and catches up one
  occurrence per job per sweep: the earliest one runs, and while that run is in
  flight the remaining ones are skipped or run according to the overlap policy
  until the anchor reaches the present.
- The settings page appears under **Settings → Scheduled agents** (section id
  `cron`). It shows and edits exactly the jobs the tools and the sweep see —
  there is one store and one state file.

Check that the bundle composed:

```console
dsh --profile <profile> --dump-config | grep -A6 'id: cron-store'
```

## What a job is

One YAML file per job. Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Job identity, `[a-z0-9][a-z0-9-]*`, at most 64 characters. Also the definition file stem and the run-record prefix. |
| `schedule` | yes | 5-field cron, a `@macro`, or an interval (`every 30m`). |
| `timezone` | no | IANA zone used for schedule math. Defaults to the plugin's `defaultTimezone` (`UTC`), never to the host zone. |
| `prompt` | yes | The full prompt one run executes, in a fresh session with no memory of any conversation. |
| `cwd` | no | Working directory of the run; also where its record and digest land. Defaults to the project directory. `~/…` is expanded. |
| `profile` | no | DSH profile the run boots. Default `headless`. |
| `overlap` | no | `skip` (default), `queue`, or `cancel-previous` — what to do when the previous run is still going. |
| `timeoutMin` | no | Hard stop in minutes, 1–1440. Default `45`. |
| `deliver` | no | Where the finished digest goes: `file` and/or `chatnode`. Default `file`, which is always written. |

Directories:

- project scope: `<projectDir>/.dsh/routines/<name>.yaml`
- global scope: `$DSH_HOME/routines/<name>.yaml`, i.e. `~/.dsh/routines/<name>.yaml`
  unless `DSH_HOME` is set

`projectDir` is the directory the profile was started in unless the config row
sets it. A project definition overrides a global definition with the same `name`.
A file that does not parse or validate is reported in the panel and skipped; it
never hides the other jobs and never stops the sweep.

A complete example:

```yaml
name: nightly-tests
schedule: "0 2 * * *"
timezone: Europe/Moscow
prompt: |
  Run the full test suite in this directory. Do not fix anything: report what
  failed, and for each failure paste the first failing assertion. Write the
  report in Russian, under 15 lines.
cwd: /srv/app
profile: headless
overlap: skip
timeoutMin: 45
deliver:
  - type: file
```

The same job can be created from a conversation (`cron_create`) or in the panel
(`New job`); both write this file.

## Schedules

Accepted forms for `schedule`:

| Form | Examples |
| --- | --- |
| 5-field cron: `minute hour day-of-month month day-of-week` | `0 2 * * *`, `*/15 * * * *`, `30 8 * * 1-5` |
| Macros | `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually` |
| Intervals | `every 30m`, `every 4h`, `every 90s`, `every 2h30m` |

Within a field:

- lists `1,2,3`; ranges `9-17`; steps `*/15`, `9-17/2`; combinations of those.
- three-letter names, case-insensitive: months `jan`…`dec`, weekdays `sun`…`sat`.
  `7` in day-of-week means Sunday and folds to `0`.
- `?` is accepted as `*`.
- six-field (seconds-bearing) expressions are **rejected** with an explicit
  error: there is no sub-minute cron here. Use `every 30s` if you need seconds.

Day matching follows the Vixie rule:

- day-of-month restricted, day-of-week `*` → only day-of-month decides;
- day-of-week restricted, day-of-month `*` → only day-of-week decides;
- **both** restricted → a day matches when **either** field matches (`0 0 1 * 1`
  fires on the 1st of the month *and* on every Monday).

Time:

- the zone is always explicit. The definition's `timezone`, or the plugin's
  `defaultTimezone` when the definition omits it — the host machine's zone is
  never used implicitly.
- an unknown zone name is a definition error, not a silent substitution to
  something else.
- daylight-saving transitions are resolved against real instants: a wall-clock
  time inside a spring-forward gap does not fire, and an ambiguous fall-back time
  fires at its first occurrence.
- if nothing matches within about 1600 days (for example `0 0 30 2 *`), the job
  has no next run and the panel shows `—`.

Check an expression before saving it: `cron_preview` in a conversation, or the
editor's live preview in the panel. Both show a short English description and the
next fire times.

## The Web panel

Settings → Scheduled agents. The page renders one host snapshot; it holds no
state of its own beyond the last loaded snapshot.

- **Toolbar** — plugin name and version, `Refresh`, `New job`. Refresh is on
  demand: the host does not push updates to the browser.
- **Engine banner** — either "This plugin schedules runs." or "Scheduling is
  owned by `<service>`." with the reason and the note that the page then only
  edits definitions. This is the answer to "who is scheduling?".
- **Invalid definition files** — each file that failed to parse, with one line of
  reason. These files are skipped until fixed.
- **Where digests go** — the file digest is always written next to the job's
  `cwd`; other reachable targets (the conversation node) are listed with their
  availability.
- **Jobs table** — one row per job:
  - `Name`, with `paused` and `running` badges;
  - `Schedule` — the human description plus the raw expression;
  - `Timezone`, `Source` (`project`/`global`), `Overlap`, `Profile`;
  - `Next run` — relative ("in 3h"), tooltip shows the absolute time;
  - `Last run` — status dot plus status (`completed`, `failed`, `timeout`,
    `skipped`, …) and how long ago, tooltip adds the absolute time and the last
    error;
  - `Working dir` — truncated, tooltip shows the full path;
  - `Actions` — `Run now`, `Pause`/`Resume`, `Edit`, `History`, `Copy prompt`,
    `Delete`. Delete asks for confirmation inside the row and says what happens:
    the definition file is removed, run history stays on disk.
- **Editor** — `New job` or `Edit`. Fields: name (validated against the same rule
  the host enforces), schedule (a template picker plus the raw expression, with a
  live description and the next three fire times computed locally as you type),
  timezone (with common zones suggested; must be a valid IANA zone), prompt,
  working directory (empty means the scope directory), profile, overlap, timeout
  in minutes, which delivery targets to use, and the scope that decides which
  directory the file is written to. Save is disabled while any field is invalid;
  a host-side rejection is shown inside the dialog.
- **History** — per job, newest first, grouped by local day (`Today`,
  `Yesterday`, then the date). Each run shows status, start time, relative time,
  duration, session id, the digest (collapsed behind a toggle when it is long),
  the tool calls that were auto-denied, the delivery results, and the failure
  text. History is read-only: it is the record the run wrote.

Full per-control detail, including which file or service each action touches:
[docs/panel.md](docs/panel.md).

## The tools

| Tool | What it does | Notable parameters |
| --- | --- | --- |
| `cron_list` | Lists jobs with schedule, zone, next/last run, paused/running state, and definition files that failed to parse. Call it before creating, editing or deleting so the name is free. | — |
| `cron_get` | Shows one job in full, including its prompt and definition path. | `name` |
| `cron_preview` | Validates a schedule without saving: description, normalized five-field form, next three fire times. | `schedule`, `timezone?` |
| `cron_create` | Creates a job, or overwrites one by name. | `name`, `schedule`, `prompt`, `timezone?`, `cwd?`, `profile?`, `overlap?`, `timeoutMin?`, `deliver?`, `scope?` |
| `cron_update` | Changes only the fields you pass; everything else keeps its value. Can move a definition between scopes. | `name` plus any of the `cron_create` fields |
| `cron_delete` | Removes a definition. Run history stays on disk. | `name` |
| `cron_pause` | Stops a job from firing; definition and history are kept. | `name` |
| `cron_resume` | Lets a paused job fire again. | `name` |
| `cron_run` | Runs a job immediately and waits for it. A real unattended run; use it to verify a job, never in a loop. | `name` |
| `cron_logs` | Recent runs of one job: status, start, duration, digest, session id, failures. | `name`, `limit?` (default 10) |
| `cron_targets` | Lists where a finished digest can be delivered right now. | — |

`deliver` accepts `file` and `chatnode`; the file digest is always written next
to the job's working directory, whatever the list says.

When the model should reach for the tools — the plugin also ships a runtime skill
(`cron`) that states this, so it is available whenever this plugin is mounted:

- Schedule something only when the work must happen **later, or again**. If the
  request can be satisfied now, in this conversation, do it now and create no
  job. Never create a job "to be safe".
- Before creating anything, be able to answer: what exactly runs (a
  self-contained prompt — the run has no memory of the conversation and nobody to
  ask), when (a concrete expression plus the IANA zone the user means), where
  (the working directory), and how much (timeout, and the overlap policy —
  `skip` is usually what the user means).
- Confirm the time with the user, `cron_preview` the expression, then
  `cron_create`, then `cron_run` once when the user wants proof.
- Report the job name, when it next fires, and what its digest will say.

## Unattended safety

A run is a process, not an in-process turn, and it is built to fail safely when
nobody is watching.

- **Its own process.** The parent runs
  `dsh --profile <profile> --patch <overlay> -- <prompt>` with the job's `cwd`.
  A wedged run cannot take the host down, and its crash is an exit code the
  parent records.
- **Approval policy forced to `never`.** The generated overlay sets the approval
  policy to `never` and installs the matching `workspace-write-deny` permission
  preset, so anything that would ask for permission is denied immediately. The
  denied tool calls are listed in the run record (`denied`) and shown in the
  panel's history and by `cron_logs`/`cron_run` — that list is how you learn a
  job needs a wider policy.
- **No nested scheduling.** The overlay turns off the scheduler rows by id (this
  plugin's and `routines-scheduler`) and the panel row, and replaces the stock
  headless runner with `dsh-cron/run`. A run is not meant to schedule runs of its
  own, from any plugin.
- **Hard timeout.** `timeoutMin` (default 45, maximum 1440). On expiry the child
  gets `SIGTERM` and then `SIGKILL` if it is still alive 10 seconds later; the
  record's status becomes `timeout` with an explanatory error.
- **Overlap policy.** `skip` (default) writes a `skipped` record and moves the
  anchor; `queue` leaves the job due so it fires on the first sweep after the
  current run ends; `cancel-previous` stops the running child (reason
  `superseded by the next scheduled run`), and the replacement then starts on a
  following sweep, once the stopped process has exited — a job can hold only one
  run at a time, so it is not replaced within the same sweep. Only one run per job
  name can be in flight at a time.
- **A full session log per run.** Each run gets a fresh session, and its id is
  recorded (`sessionId`), so the run can be replayed later.
- **A record and a digest.** `<cwd>/.dsh/routines/runs/<runId>.json` is the
  authoritative record; a human `<runId>.md` digest is written beside it. Both
  are written atomically.
- **Digest construction.** The digest is the last assistant message when it is
  short enough (2000 characters by default); otherwise a one-shot summarizer call
  compresses the run transcript, and if that call fails the head of the message
  is used with an explicit truncation marker.

## Compatibility and coexistence

`dsh-cron` shares its artifacts with the `dsh-routines` scheduler plugin
deliberately, so an existing installation keeps working:

- **Definitions** — the same two directories, the same field names, the same
  defaults, and project-over-global by `name`. A file written by one engine is
  read by the other.
- **State** — `<projectDir>/.dsh/routines/state.json`, with the keys
  `dsh-routines` uses (`paused: string[]`, `lastRunAt: Record<string, number>`)
  plus one additive key of ours, `lastStatus` (last status and error per job, for
  the table). Unknown keys are ignored on read. This plugin writes the state file
  from the keys it knows, so a third engine's unrelated keys in that file would
  not survive a pause/resume issued from here.
- **Run records** — `<cwd>/.dsh/routines/runs/<runId>.json` plus `<runId>.md`.
  Records this plugin cannot parse are skipped when read and never deleted by
  pruning.
- **Writes** — definitions and state are written through a temp file and a
  rename, so a reader sees the old file or the new one, never a half-written one.
- **Hand edits** — both definition directories are watched (debounced), so a YAML
  edit shows up in the panel and in the tools without a restart.

Scheduling ownership, when more than one scheduler is installed:

| `engine` | Behaviour |
| --- | --- |
| `auto` (default) | If another scheduler is mounted (the cordis service `routinesScheduler`), this plugin schedules nothing, keeps its tools, its store and its page, and says so in the panel banner. Otherwise it schedules. |
| `own` | This plugin schedules regardless of what else is mounted. This is the switch you flip after standing the other scheduler down; with both active, both fire. |
| `off` | This plugin never schedules: definitions, tools, history and the page keep working, and the panel banner reports that scheduling is disabled here. |

## Configuration

Every field has a default, so the plugin is useful with an empty config row. Set
them in the bundle row in the profile's `cordis.patch.yml` (restate every key when
you override the row).

| Field | Default | What it changes |
| --- | --- | --- |
| `projectDir` | `process.cwd()` | Directory whose `.dsh/routines/` holds project-scoped definitions and the state file. Also where a run's report is printed from and the default for an absent `cwd`. |
| `globalDir` | `$DSH_HOME/routines` (`~/.dsh/routines`) | Directory of global definitions. `~/…` is expanded. |
| `engine` | `auto` | Who schedules: `auto`, `own`, `off`. See the table above. |
| `tickSeconds` | `20` | Seconds between two due-time sweeps (5–3600). Smaller means finer detection of due times, at the cost of more wakeups. |
| `dshBin` | `dsh` (`$DSH_BIN` overrides) | Binary used for run subprocesses. If it is not on the run's `PATH`, the run fails with a spawn error in its record. A path to a `.js`/`.mjs`/`.cjs` file is executed with the current Node. |
| `defaultProfile` | `headless` | Profile a run boots unless its definition names one. Note: the store applies `headless` itself, so this field is currently documentation rather than a live knob. |
| `defaultTimezone` | `UTC` | Zone used for a definition that names none, and by `cron_preview` when the caller passes no zone. |
| `defaultTimeoutMin` | `45` | Timeout for a definition that names none. Note: the store applies 45 itself, so this field is currently not read. |
| `allowRunNow` | `true` | Whether the panel's `Run now` and the `cron_run` tool may start a run out of band. `false` makes runs schedule-only. |
| `maxHistoryPerJob` | `50` | Intended cap on the run records kept per job. Note: nothing prunes records yet, so this field currently has no effect. |
| `watch` | `true` | Watch both definition directories for hand edits and hot-reload the store. |
| `digestMaxChars` | `2000` | A last assistant message at or below this length *is* the digest; a longer one is summarized. |
| `summaryMaxChars` | `24000` | Byte cap on the transcript handed to the summarizer call. |
| `summaryMaxTokens` | `400` | Output-token cap for that summarizer call. |
| `summaryTimeoutMs` | `60000` | End-to-end deadline for the summarizer call. |
| `runModule` | this package's compiled `lib/run.js` | Absolute path of the module a run subprocess mounts as its driver. Resolved from the installed copy; override only for development. |

### The `profile` field must be one-shot-capable

A run boots the profile named in the job (`profile:`, default `headless`) and
then replaces its one-shot runner with this plugin's driver (see
[How a run works](#how-a-run-works)). That only works when the profile actually
has a headless runner to replace, so a job pointing at a profile without one —
the interactive `web` profile, for example — fails at startup, before it can
write a run record.

The rule of thumb: leave `profile` out (`headless` applies), or name a profile
you built for unattended work. If a job needs another profile's plugin set,
install the `headless` bundle into that profile. A failed run now carries the
child's last output line in its record, so this is visible in the history view
rather than silent.

## How a run works

1. **Sweep.** Every `tickSeconds` the scheduler asks which jobs have a fire time
   at or before now, evaluating each schedule from the job's last recorded launch
   (a job that never ran is anchored one tick back, so a new definition does not
   replay history). One sweep runs immediately when the plugin mounts, which is how
   occurrences missed while the profile was down are caught up: one occurrence per
   job per sweep, the earliest first.
2. **Anchor.** The scheduled instant is written into `state.json` (`lastRunAt`,
   plus `lastStatus: running`) *before* the child process exists. A crash
   mid-run therefore cannot re-fire the same occurrence.
3. **Overlay.** A per-run patch file (`.<runId>.patch.yml`, in the job's runs
   directory) is generated: approval `never`, the scheduler and panel rows
   disabled, and `dsh-cron/run` mounted as the runner.
4. **Child.** `dsh --profile <profile> --patch <overlay> -- <prompt>` starts in
   the job's `cwd`. A `running` record is written first, so the panel and the
   tools see the run the moment it starts, not when it ends.
5. **Fresh session.** The driver creates a new session, sends the prompt once,
   waits for the agent to go idle, and flushes the session log.
6. **Record.** Status, exit code, duration, session id, digest and the denied
   approvals are written to `<runId>.json` and `<runId>.md`. The parent reconciles
   that record with the process exit (`completed`, `timeout`, or `failed`) and
   appends the delivery results.
7. **Delivery.** The file digest is already on disk. A `chatnode` delivery goes
   through `ctx.chatnode` when a conversation node is mounted; when none is, the
   attempt is recorded as a failed delivery rather than failing the run.
8. **Status.** The completion updates `state.json`, so the panel's Next/Last
   columns, `cron_list` and `cron_logs` agree. When a jobs registry is mounted,
   the run is also registered there as a `cron` background job, with a cancel
   path and its digest as the job output.

## Development

```console
pnpm install
pnpm run typecheck   # host half and client half
pnpm run build       # lib/index.js (host) and lib/client.js (browser)
pnpm test            # vitest
```

- Host half: `tsc -p tsconfig.json` emits ESM JavaScript plus declarations into
  `lib/`.
- Browser half: `tsdown` bundles `src/client/index.ts` into `lib/client.js`, a
  closure-factory bundle (`window.__ModuleLoader__.load(...)`) that resolves
  React and the harness client packages from the shell's module table and inlines
  everything else. Styles ship as a scoped string from `src/client/styles.ts`,
  installed into one `<style data-dsh-cron>` element.
- `package.json` exports `.` → `lib/index.js`, `./typert` → `lib/typert.host.js`,
  `./client` → `lib/client.js`.

Architecture notes for a maintainer: [docs/architecture.md](docs/architecture.md).
The internal contract: [docs/CONTRACT.md](docs/CONTRACT.md).

## Limitations

- **Every run is a whole agent run.** A job costs a new `dsh` process, a new
  agent session and a new model conversation per fire, with process and model
  startup on top. A 15-minute job is 96 runs a day.
- **The panel refreshes on demand.** There is no push channel: the page updates
  when it loads, when you press `Refresh`, and after each action you take.
- **Digests land in a file always.** Delivering to a conversation node works only
  when something provides `ctx.chatnode`; otherwise the attempt is recorded as
  failed. Nothing else delivers (no email, no notifications).
- **The model sees nothing about a run unless it asks.** Run output is never
  injected into a conversation; a model has to call `cron_logs` (or `cron_run`).
- **`Run now` and `cron_run` are real runs** and cost what a scheduled run costs.
  Turn them off with `allowRunNow: false` when a profile must only follow its
  schedule.
- **Run records are never pruned yet.** They accumulate under each job's `cwd`;
  `maxHistoryPerJob` is declared but not wired to a caller.
- **Definition scope is not exclusive.** Saving a job into the project scope under
  a name that already exists in the global scope shadows the global file instead
  of replacing it; `Delete` removes the project copy first, then the global one.
