# dsh-cron — architecture

Notes for whoever maintains this plugin next. They describe how the host half is
put together, why the unusual decisions are deliberate, and which parts are
compatibility surface rather than preference. User-facing behaviour lives in
[../README.md](../README.md); the settings page is documented in
[panel.md](panel.md); the interface contract the code was written against is
[CONTRACT.md](CONTRACT.md).

## 1. Where the plugin sits in the graph

`package.json` declares `dsh.bundle.patch: ./cordis.patch.yml` (what the profile's
bundle list mounts) and `dsh.client` (what the Web shell loads). The bundle patch
declares **one** row:

```yaml
- insert:
    - id: cron-store
      name: dsh-cron
      config: { engine: auto, tickSeconds: 20, defaultProfile: headless, … }
```

`src/index.ts` is that row's plugin: `inject = ['timer']` (the sweep needs
`ctx.interval` / `ctx.timeout`), `apply()` builds the `cron` service, installs the
tools and the skill, and starts the sweep. The Remote face the settings page
reads is not a second row: the harness's typert loader discovers the package's
`./typert` export (`src/typert.host.ts`), whose descriptors name the `cron`
service.

The host half is deliberately tolerant about optional neighbours. Each of these
can be absent, and each absence is a warning rather than a failure:

| Neighbour | Absent means |
| --- | --- |
| `ctx.tools` | no model tools; the panel and the sweep still work (`src/index.ts`) |
| `ctx.skills` | the `cron` skill is not registered; the tools still work (`src/skill.ts`) |
| `ctx.jobs` | scheduled runs are not registered as harness background jobs (`src/scheduler.ts`) |
| `ctx.chatnode` | `chatnode` delivery is recorded as failed; the file digest is unaffected (`src/runner.ts`, `src/service.ts`) |
| `ctx.logger` | warnings are dropped silently |

The browser half is `src/client/index.ts`, built into `lib/client.js` (see §10).
It installs the locale dictionaries and the scoped stylesheet, mounts the
`dshCron` Remote contribution, and registers the page into the
`settings.section` slot with id `cron` and order `30`.

## 2. Module map

| Module | Half | Owns |
| --- | --- | --- |
| `src/config.ts` | host | The validated configuration schema, every default, and `DEFAULT_RUN_MODULE` |
| `src/types.ts` | both | The shared vocabulary: `CronJob`, `RunRecord`, `CronSnapshot`, `SchedulePreview`, `EngineState`, `DeliveryTarget`, `JobMutation`, `MutationResult` |
| `src/cron.ts` | both | Schedule grammar, next-run search, human descriptions; pure, no Node, no dependencies |
| `src/store.ts` | host | Definition files: read both directories, validate, write atomically, watch, delete |
| `src/state.ts` | host | Durable state (`paused`, `lastRunAt`, additive `lastStatus`), shape-tolerant read, atomic write |
| `src/runs.ts` | host | Run records and `.md` digests: read, list, write, prune |
| `src/digest.ts` | host (child) | Digest construction from the session log: last assistant text, turn outcome, denied approvals, one-shot summarizer prompt |
| `src/runner.ts` | host | Launching a run: pre-created record, generated `--patch` overlay, spawn, kill, reconcile, deliver |
| `src/run.ts` | host (child) | The driver mounted *inside* the run process: one agent, one prompt, write the record, exit |
| `src/scheduler.ts` | host | The due-time sweep, the overlap decision matrix, timeout arming, harness job registration |
| `src/service.ts` | host | `CronService` (`ctx.cron`): the single facade over the four modules above, plus the four Remote methods |
| `src/tools.ts` | host | The eleven model-facing tools |
| `src/skill.ts` | host | The runtime `cron` skill body and its registration |
| `src/wire.ts` | both | The frozen Remote descriptors and `encodeWire`/`decodeWire` |
| `src/typert.host.ts` | host | The host Typert manifest (same descriptor objects) |
| `src/index.ts` | host | Plugin assembly and the optional-neighbour warnings |
| `src/client/index.ts` | browser | Boot: dictionaries, stylesheet, `$mount` the Remote contribution, register the settings section |
| `src/client/CronSection.tsx` | browser | The page: engine banner, invalid files, targets, jobs table, dialogs |
| `src/client/JobEditor.tsx` | browser | The create/edit dialog, including local schedule feedback |
| `src/client/HistoryList.tsx` | browser | The run-history dialog |
| `src/client/present.ts` | browser | Pure view decisions: status tone, duration, relative time, day grouping, name validation |
| `src/client/locales.ts` | browser | `en` and `ru` dictionaries for the `settings.dshCron` namespace |
| `src/client/styles.ts` | browser | The scoped stylesheet string and its `<style data-dsh-cron>` installer |
| `src/client/remote.ts` | browser | The client Typert contribution and the `ctx.remote.dshCron` type merge |

Two modules are imported by **both** halves and must stay free of Node imports:
`src/types.ts` (one snapshot shape) and `src/cron.ts` (one schedule grammar, so
the editor's live preview and the host's sweep cannot disagree). That is enforced
by `tsconfig.client.json`, which compiles `src/client/**`, `src/wire.ts` and
`src/types.ts` with `types: []` and DOM libs only; `src/cron.ts` is reachable from
the client program through `src/client/JobEditor.tsx`, so a `node:*` import there
would fail the client typecheck.

Everything else on the host side is Node-only by construction (`node:fs`,
`node:child_process`, `node:crypto`, `node:os`, `node:path`).

`digest.ts` is the one module the CONTRACT's table does not name: `runs.ts` owns
record and digest *IO*, `digest.ts` owns digest *construction*. The split exists
because `run.ts` needs the construction helpers inside the child process and must
not drag in `node:fs`-heavy record IO for them. `src/client/present.ts`,
`locales.ts`, `styles.ts`, `CronSection.tsx`, `JobEditor.tsx` and `HistoryList.tsx`
are likewise the concrete shape behind the contract's `src/client/*`.

## 3. Two faces, one wire

`CronService` is the only owner of definitions, state and runs. The tools call
its typed methods; the panel calls four methods that answer JSON strings:

| Remote method | Service method | Payload |
| --- | --- | --- |
| `dshCron/status` | `status()` | `CronSnapshot` |
| `dshCron/mutate` | `mutate(requestJson)` | `JobMutation` in, `MutationResult` (with a refreshed snapshot) out |
| `dshCron/history` | `history(name, limit?)` | `RunRecord[]` |
| `dshCron/preview` | `preview(schedule, timezone?)` | `SchedulePreview` |

Why JSON strings and hand-written descriptors: `src/wire.ts` freezes four
`InvocationDescriptor` objects with `source: 'json'` / `codec: { mode: 'src-json' }`
parameters, and both faces import that same module — `src/typert.host.ts` for the
host manifest, `src/client/remote.ts` for the client contribution. There is no
generated code and no schema to keep in sync, and both halves use the same
`encodeWire`/`decodeWire` pair.

Two boundary rules keep a wire problem from becoming a blank page:

- `encodeWire` never throws: an unserializable value degrades to the JSON literal
  `null`.
- every Remote method answers *data*, never a throw. `mutate()` catches parse
  failures and handler errors and returns `MutationResult { ok: false, error }`
  with a snapshot; `preview()` returns `{ ok: false, error }` for an invalid
  expression. The client unwraps `RemoteResult` and falls back to the raw value
  when the string does not decode.

The panel renders `CronSnapshot` and nothing else, and every mutation answers with
the refreshed snapshot, so a successful action needs no second round trip. That is
what makes host/client drift a type error rather than a runtime surprise.

## 4. The sweep and the durable anchor

`JobScheduler.start()` arms `ctx.interval(tick, tickSeconds * 1000)` **and runs one
tick immediately**, which is how an occurrence that came due while the profile was
down is caught instead of being missed until the next interval.

`due(now)` walks `service.list()` and, for each job:

- skips paused jobs;
- anchors at `state.lastRunAt[name]`, or at `now - tickSeconds` when the job has
  never run (so writing a new definition does not replay its history);
- computes `nextRunAfter(job.schedule, job.timezone, anchor)` and reports the job
  when `next <= now`. A schedule that stopped parsing after a hand edit is skipped
  (`continue`), because one bad expression must not stop the sweep;
- reports the scheduled instant, not the wall clock, as `scheduledFor`.

`tick(now)` then applies the overlap policy per due job:

| Situation | Action |
| --- | --- |
| not running | launch |
| running, `overlap: skip` | `markLaunched(scheduledFor, 'skipped')` plus a `skipped` run record |
| running, `overlap: queue` | return without touching the anchor, so the job stays due and fires on the first tick after the current run releases its name |
| running, `overlap: cancel-previous` | `service.cancel(name, 'superseded by the next scheduled run')`, then launch |

The last row cannot complete in that tick: `cancel()` only signals the child, and
the in-flight name is released when the child's exit resolves, so the
`launchScheduled()` of the same tick throws `job "<name>" is already running`, the
tick logs `could not start "<name>"`, and the replacement starts on a later tick.
`cancel-previous` therefore behaves as "stop the current run and replace it as
soon as the process is gone", with one warning line per superseded occurrence.

`launch()` does four things in this order: `launchScheduled()` (which throws if the
name is already in flight — the in-flight table is the single answer to "is this
job busy"), `markLaunched(job.name, scheduledFor, 'running')`, registration on
`ctx.jobs` as `kind: 'cron'` with a cancel callback and the digest as the job
output, and `ctx.timeout(job.timeoutMin * 60_000)` that kills the run with reason
`timeout`. On completion the timer is cleared, `recordOutcome()` writes the
terminal status, and subscribers are notified.

### Why the anchor is written before the run

`state.lastRunAt` is the anchor the whole missed-run policy advances from, and it
holds the **scheduled** instant. Writing it before the child process exists means:

- a crash, a kill, or a host restart mid-run cannot re-fire the same occurrence,
  because the next tick already sees an anchor past it;
- "missed runs" need no catch-up queue: the sweep simply sees a passed occurrence
  and processes it. Catch-up advances one occurrence per job per tick — the
  earliest first, the rest skipped or run according to the overlap policy until
  the anchor reaches the present;
- `recordOutcome()` deliberately does **not** touch `lastRunAt`: overwriting the
  scheduled instant with the completion time would let one long run silently
  swallow every occurrence it overlapped.

`queue` relies on the same property from the other side: by leaving the anchor
alone it keeps the job due until the running child releases its name.

A manual run (`runNow()`, i.e. the panel's `Run now` or `cron_run`) does advance
the anchor to `Date.now()`, so an occurrence that was already due is consumed by
the manual run rather than firing again on the next tick.

Because `tick(now)` takes its clock as an argument and `due()` is public, the
whole matrix above is unit-tested without waiting for a timer
(`tests/scheduler.test.ts`).

## 5. Why a run is a subprocess

`RunLauncher.launch()` spawns
`dsh --profile <job.profile> --patch <overlay> -- <job.prompt>` with `cwd` set to
the job's working directory and the parent environment inherited (a `.js`/`.mjs`/
`.cjs` `dshBin` is executed with `process.execPath`). The reasons, in the order
they matter:

1. **A prompt must be impossible.** The overlay forces the approval policy to
   `never`, so an unattended run cannot wait for a human. The permission table is
   given the matching `workspace-write-deny` preset so the combination still
   validates.
2. **Crash isolation.** A wedged or crashing run is an exit code, not a dead host.
3. **A hard kill.** The parent can stop the whole run with `SIGTERM`, then
   `SIGKILL` after a 10-second grace (`KILL_GRACE_MS`), on timeout, on
   `cancel-previous`, or on plugin disposal.
4. **Its own session log.** The run's session is fresh, persisted by the harness,
   and its id is recorded, so the run can be replayed later.
5. **Its own tree.** The overlay can disable rows (every scheduler, the panel) and
   swap the runner without touching the host composition.

The sequence inside `launch()` is deliberate:

1. write the `running` record *first*, so the panel and the tools see the run the
   moment it starts rather than when it ends;
2. write the overlay to `<runsDir>/.<runId>.patch.yml` (dot-prefixed so a listing
   of run records stays clean), then spawn;
3. register the handle in the in-flight map before returning it;
4. in `finalize()`, wait for the exit, delete the overlay, read the record the
   child wrote, and reconcile it with the process exit: `completed` only when the
   child's own record says so, `timeout` when the kill reason was `timeout`,
   otherwise `failed` with a human error string;
5. attempt deliveries, write the final record, drop the handle.

The overlay itself (`RunLauncher.overlay()`) contains: `approval.policy: never`;
the `permission` preset; `disabled: true` for the row ids `cron-scheduler`,
`routines-scheduler` and `cron-remote`; `headless-runner` disabled; and an inserted
row `dsh-cron-run-driver` with `name: <runModule>` and
`task: !!js ctx.headlessStartup.task`, which is how the prompt, the run id and the
digest limits reach the driver.

The driver (`src/run.ts`) executes **inside** that process and owns the run's
facts. Two constraints shape it:

- it is imported by absolute path from whatever profile the run boots
  (`DEFAULT_RUN_MODULE` is resolved from this module's own location via
  `import.meta.url`, so a registry, git or `file:` install always points at its own
  compiled copy), so it may depend only on Node builtins and this package's own
  `lib/` files;
- every harness capability arrives through an injected service
  (`inject = ['loader', 'agents', 'agentDefaultModel', 'sessions', 'llm',
  'headlessStartup']`), typed structurally on purpose because the run's profile is
  not necessarily the one this file was compiled against. `ctx.appExit` is
  required to end the process with a status.

## 6. Why the store is read fresh on every mutation

Two programs write the same files: this plugin and the `dsh-routines` scheduler.
Everything in `CronService` follows from that.

- **State is never cached across a mutation.** `state()` calls `loadState()`
  every time, and `mutateState()` is read-modify-write. Anything else could
  silently revert a pause that the other engine wrote a second ago.
- **Definitions are re-read after every write and on every watched change.**
  `reload()` replaces `jobs`/`invalid` wholesale; `save()`/`remove()` call it, and
  so does the watcher. The in-memory arrays are a *cache of the last read*, never
  a source of truth, and nothing is memoized behind a promise.
- **Runtime facts are computed, not stored.** `list()`/`get()` decorate each
  definition with the pause flag, the in-flight flag, the next fire time (anchored
  at the last launch) and the last status. `paused` and `running` are therefore
  never definition fields, which is exactly why a hand-written YAML file and the
  panel agree.
- **Writes are atomic.** Definitions and state go through
  `<path>.tmp-<pid>` + rename, so a reader sees the whole old file or the whole new
  one. `state.json` is written as two-space JSON with a trailing newline, matching
  what `dsh-routines` writes, so a shared file does not flip-flop between two diff
  shapes. Run records use the same temp-and-rename, and the `.md` digest is written
  inside a `try` because a derived file must never fail a finished run.
- **Both directories are watched.** `watchJobs()` filters events to `.yaml`/`.yml`
  (the state file lives in the same directory and is written far more often),
  debounces 120 ms (`WATCH_DEBOUNCE_MS`) because one atomic save surfaces as
  several events, polls a directory that does not exist yet every second
  (`WATCH_POLL_MS`, `unref`'d so a store that is never disposed cannot hold the
  process open), and falls back to polling when the platform refuses a watcher. A
  watcher `error` event would otherwise take the host down, so it is handled.
- **Reads are tolerant at the boundary.** A malformed or unreadable definition
  becomes an `InvalidJob` named after the file stem and is reported in the
  snapshot, in `cron_list` and in the panel; it never throws out of `readJobs()`.
  `loadState()` degrades to an empty state on absent, unparsable or non-object
  content, and drops individual malformed `lastStatus` entries field by field so
  one bad job cannot hide the rest.

## 7. Compatibility guarantees (do not break these)

These are the surfaces `dsh-routines` (and any user's files) depend on.

- **Definitions** — `<projectDir>/.dsh/routines/*.yaml` and
  `~/.dsh/routines/*.yaml` (`$DSH_HOME/routines` when `DSH_HOME` is set), project
  overriding global by `name`; fields `name, schedule, timezone, prompt, cwd?,
  profile, overlap, timeoutMin, deliver`; defaults `timezone = <config>`,
  `profile = headless`, `overlap = skip`, `timeoutMin = 45`,
  `deliver = [{ type: file }]`, `cwd = <projectDir>`.
- **Names** — `[a-z0-9][a-z0-9-]*`, at most 64 characters; also the file stem.
  `removeJob()` refuses a name outside that grammar rather than resolving it to a
  path.
- **Fields** — unknown keys are rejected on write (`unknown field "..."`, so a typo
  is named instead of silently dropped) and ignored on read. `CronJob` fields that
  a write recomputes (`source`, `file`, `paused`, `running`, `nextRunAt`,
  `lastRunAt`, `lastStatus`, `lastError`) are accepted so a job that was read can
  be written straight back. `cwd` is written only when the caller supplied one:
  writing back the resolved default would freeze a directory into the file.
- **State** — `<projectDir>/.dsh/routines/state.json`, keys `paused: string[]` and
  `lastRunAt: Record<string, number>` (what `dsh-routines` writes) plus this
  plugin's additive `lastStatus: Record<string, {status, error?, at}>`. Reading is
  shape-tolerant field by field. Writing emits the three known keys only, so an
  unrelated key a third engine put in that file would not survive a pause/resume
  issued from this plugin.
- **Run records** — `<cwd>/.dsh/routines/runs/<runId>.json` (fields per
  `RunRecord` in `src/types.ts`) plus `<runId>.md`. `runId` must match
  `RUN_ID_PATTERN`, so a record path can never address a file outside the runs
  directory. A record missing `runId`, `routine`, a known `status` or a finite
  `startedAt` is not a record this plugin trusts and is skipped on read; nothing is
  invented (a missing `durationMs` stays missing). Pruning keeps an unparsable file
  on purpose: an unreadable record is evidence, and destroying evidence you cannot
  read is worse than showing it.
- **Orchestration** — the sweep is the only thing that yields to another owner.
  `resolveEngine()` maps `engine` to an `EngineState`: `off` → `companion` with
  "scheduling is disabled (engine: off); definitions are editable here"; `own` →
  `own`; `auto` → `own` unless the cordis service `routinesScheduler` is mounted,
  in which case `companion` naming `routinesScheduler` and pointing at
  `engine: own`. In companion mode the store, the tools, the history and the page
  all keep working — a second scheduler never double-fires a job by accident.

For reference, the sibling bundle (`@dsh-routines/bundle`) mounts the rows
`routines-store`, `routines-scheduler` (injects the `routines` service) and
`routines-cli` (injects `routines, routinesScheduler`); its state file is
`<...>/.dsh/routines/state.json` with `paused` and `lastRunAt`. Those ids and keys
are what the probe and the run overlay use.

## 8. Failure handling

- **Remote failures are data.** A panel action that fails answers
  `MutationResult { ok: false, error, snapshot }`; a malformed request body answers
  "the request could not be parsed"; an unknown action answers "unknown action".
  The rule: a Remote throw reaches the user as a blank page, so it never happens.
- **Deliveries are recorded, not thrown.** A missing conversation node or a failing
  `chatnode.send()` becomes `{ type: 'chatnode', ok: false, error }` on the record;
  the run is still a run.
- **The digest is best-effort.** The `.md` file is written inside a guard, and when
  the summarizer call fails the digest falls back to the head of the last assistant
  message plus an explicit truncation marker.
- **A missing summarizer is not an error.** No `ctx.llm`, an aborted call or an
  empty answer all fall back the same way.
- **Timeout is a status, not a crash.** The kill reason `timeout` produces
  `status: 'timeout'` with "run exceeded its N-minute timeout and was stopped".
- **Disposal stops traffic.** `ctx.effect` disposes the watcher and kills every
  in-flight run with reason `plugin unloaded`.
- **Warnings are cheap.** `index.ts` reports a missing tool registry or skill
  registry once, at mount, through `ctx.logger`.

## 9. Build, artifacts and module resolution

- **Host:** `tsc -p tsconfig.json` (`build:host`) emits ESM plus declarations into
  `lib/`. Source imports use `.ts` extensions
  (`rewriteRelativeImportExtensions`), so emitted specifiers are `.js`.
- **Browser:** `tsdown` (`build:client`) bundles `src/client/index.ts` into
  `lib/client.js`, a closure-factory bundle wrapped in
  `window.__ModuleLoader__.load({ id: 'dsh-cron', factory })`. Platform modules
  (`react`, `react-dom`, `@deepseek-ai/cordis`, the client UI/slots/locale/remotes
  packages) are listed under `deps.neverBundle` and resolved through the shell's
  frozen module table; everything else is inlined, because that table cannot answer
  a `require()` for it. There is no CSS pipeline: styles ship as a string.
- **Typecheck** covers both programs: `tsc -p tsconfig.json --noEmit` and
  `tsc -p tsconfig.client.json`.
- **Exports:** `.` → `lib/index.js`, `./typert` → `lib/typert.host.js`,
  `./client` → `lib/client.js`. `files` ships `lib`, `src`, `docs`,
  `cordis.patch.yml`, the changelog, both READMEs and the licence. `lib/` is
  gitignored and produced by `prepare`/`build`.
- **Run module resolution:** `DEFAULT_RUN_MODULE` is
  `fileURLToPath(new URL('./run.js', import.meta.url))` — the compiled driver of
  the *installed* copy, whatever channel delivered it.

## 10. Test surface

`tests/*.test.ts` (vitest): `cron.test.ts` (grammar, macros, intervals, Vixie
rule, timezone and DST math), `store.test.ts` (validation, defaults, atomic writes,
watcher-free reads), `state.test.ts` (tolerance and round-tripping), `runs.test.ts`
(parse/skip, digest beside record, ordering), `scheduler.test.ts` (the decision
matrix through `tick(now)`), `runner.test.ts` (launch/reconcile with an injected
spawner), `service.test.ts` (the facade and the Remote payloads) and
`present.test.ts` (the client's pure view helpers).

Habits that make this testable, worth keeping:

- keep `cron.ts`, `digest.ts` and `client/present.ts` pure;
- pass the clock in (`JobScheduler.tick(now)`), never read `Date.now()` in a
  decision;
- inject the process boundary: `RunLauncher`'s third constructor argument is the
  spawner, and `run.ts` exposes `internals` so tests can substitute the streams.

## 11. Open questions and known gaps

Honest list, current at this revision:

- **The run overlay's `cron-scheduler` disable matches no row.** The bundle
  declares a single row, `cron-store`, while `cordis.patch.yml`'s own header still
  describes a separate scheduler row that the overlay could disable. When a job's
  `profile` is one that also composes this bundle (for example the same `web`
  profile the panel runs in), the run gets a `cron-store` row too; if the loader
  ignores a `disabled` entry for an unknown id, that run's own `CronService` starts
  a sweep with `engine: auto` in a profile where no other scheduler is mounted.
  Decide between splitting the scheduler into its own row (id `cron-scheduler`, as
  the header describes) and disabling `cron-store` in the overlay.
- **`cron-remote` is also disabled by the overlay**, and that row no longer exists
  (the typert face is discovered from the `./typert` export), so that line is a
  no-op today.
- **Three config fields are declared but unread:** `defaultProfile` and
  `defaultTimeoutMin` (the store applies `headless` and 45 itself) and
  `maxHistoryPerJob`. `pruneRuns()` in `src/runs.ts` is implemented, tested and has
  no caller yet.
- **The child's output tail is captured and dropped.** `spawnRun` keeps the last
  8 KB of stdout/stderr but nothing reads it, so a run that dies before writing its
  record reports only "run did not complete (exit code N)". Surfacing that tail in
  the record's `error` would make startup failures diagnosable from the panel.
- **`CronService.onChange`/`notify` has no subscribers yet.** The panel is a Remote
  client and re-fetches explicitly, so the plumbing exists for a future push
  channel rather than for today's page.
- **Unused vocabulary.** `RunStatus` includes `killed` and `DeliveryTarget.kind`
  includes `telegram`, but this plugin writes neither; they exist for records
  another engine writes into the same files and for delivery kinds not implemented
  here.
- **`cancel-previous` never replaces a run within the same tick.** `cancel()` sets
  the kill reason and signals the child; the in-flight map entry is only dropped in
  `finalize()` when the exit resolves, so the `launchScheduled()` that follows in
  the same `activate()` throws `job "<name>" is already running`, and the tick logs
  "could not start …". The superseding run therefore starts one or more ticks
  later. The scheduler test asserts the two calls without a real in-flight table,
  so it passes while the composed behaviour differs. Decide whether the launcher
  should release the name synchronously on cancel (and let `finalize()` be
  idempotent) or whether the tick should defer the replacement explicitly.
- **No cancel control in the panel.** The service exposes `cancel()`, and the run
  registered on `ctx.jobs` carries a cancel callback, but the settings page offers
  no way to stop a run in flight.
- **Scope is not exclusive.** Saving a project-scoped definition under a name that
  also exists globally shadows the global file; `removeJob()` deletes the project
  copy first, then the global one. This matches the compatibility rule, and the
  panel simply reports which scope a job came from.
