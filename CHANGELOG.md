# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-09-20

### Fixed

- Deleting a job now clears its durable marks (`paused`, `lastRunAt`,
  `lastStatus`) from `state.json`. A job deleted while paused used to come back
  paused when a new job took the same name, which read as the plugin ignoring a
  fresh definition. Run records and digests still stay on disk — only the
  bookkeeping about firing is dropped, and only when it existed.

## [0.1.1] - 2026-09-20


### Changed

- The settings page no longer renders the engine banner ("Scheduling is owned by
  …", "This plugin schedules runs.") or the "Where digests go" block. Both were
  explanation, not control, and they crowded the page: who fires runs is now
  reported where it is actually asked for — the `cron_list` tool — and the
  editor's delivery checkboxes still show target availability inline.
  (`snapshot.engine` and `snapshot.targets` are unchanged on the wire.)

## [0.1.0] - 2026-09-20


First release: scheduled agents for DeepSeek Harness, with a Web settings page
and model-facing tools over one shared job store.

### Added

- Plugin bundle that mounts as one graph row (`cron-store` in
  `cordis.patch.yml`, name `dsh-cron`): the job store and sweep, the model-facing
  tools and the runtime skill in the host half; the `./typert` export carries the
  `dshCron` Remote face the settings page reads, with no second row to mount.
- Job definitions as YAML files in `<projectDir>/.dsh/routines/*.yaml` and
  `~/.dsh/routines/*.yaml`, project overriding global by `name`, with the fields
  `name`, `schedule`, `timezone`, `prompt`, `cwd`, `profile`, `overlap`,
  `timeoutMin` and `deliver` (`src/store.ts`).
- Schedule grammar shared by both halves and free of dependencies: 5-field cron,
  `@hourly`/`@daily`/`@midnight`/`@weekly`/`@monthly`/`@yearly`/`@annually`,
  intervals (`every 30m`, `every 4h`, `every 90s`, `every 2h30m`), lists, ranges,
  steps, three-letter month and weekday names, `?` as `*`, the Vixie
  day-of-month/day-of-week either-matches rule, and timezone math over
  `Intl.DateTimeFormat` with DST handling and no host-zone fallback
  (`src/cron.ts`).
- Due-time sweep with a durable launch anchor written before each run, per-job
  overlap policies (`skip`, `queue`, `cancel-previous`), timeout enforcement,
  background-job registration, and one catch-up sweep at mount
  (`src/scheduler.ts`, `src/state.ts`).
- Unattended runs as their own `dsh` subprocess with a generated `--patch`
  overlay: approval policy forced to `never`, matching `workspace-write-deny`
  permission preset, the scheduler and panel rows disabled by id, and the stock
  headless runner replaced by `dsh-cron/run` (`src/runner.ts`, `src/run.ts`).
- Run records with status, exit code, duration, session id, digest, denied
  approvals and delivery results, written to
  `<cwd>/.dsh/routines/runs/<runId>.json` with a human `<runId>.md` digest beside
  it, plus atomic writes everywhere and a prune helper that never deletes an
  unreadable record (not yet wired to a caller) (`src/runs.ts`).
- Digest construction from the session log: the last assistant message when it
  fits `digestMaxChars`, otherwise a one-shot summarizer call over a bounded
  transcript, with an explicit truncation marker when that call fails
  (`src/digest.ts`).
- Eleven model-facing tools: `cron_list`, `cron_get`, `cron_preview`,
  `cron_create`, `cron_update`, `cron_delete`, `cron_pause`, `cron_resume`,
  `cron_run`, `cron_logs`, `cron_targets` (`src/tools.ts`).
- Runtime `cron` skill describing when scheduling is the right move, the
  decide/confirm/preview/create/verify workflow, the unattended rules and the
  common mistakes (`src/skill.ts`).
- Settings page (`Settings → Scheduled agents`, section id `cron`): engine
  banner, invalid-definition diagnostics, delivery targets, the jobs table with
  run/pause/resume/edit/history/copy-prompt/delete actions, the create/edit
  dialog with live schedule feedback and local validation, and the run-history
  dialog grouped by day (`src/client/*`).
- `dshCron` Remote namespace with four methods — `status`, `mutate`, `history`,
  `preview` — carried as JSON strings over one hand-written descriptor list
  shared by both faces (`src/wire.ts`, `src/typert.host.ts`,
  `src/client/remote.ts`).
- English and Russian copy for the settings page under the `settings.dshCron`
  locale namespace (`src/client/locales.ts`).
- Compatibility with the `dsh-routines` scheduler plugin: the same definition,
  state and run-record layout, shape-tolerant state reading, and scheduling
  ownership that stands down by default when another scheduler is mounted
  (`engine: auto | own | off`).
- Documentation: `README.md`, `README.ru.md`, `docs/architecture.md` and
  `docs/panel.md`.
- Test suite (vitest) covering cron math, the store, state IO, run records, the
  scheduler's decision matrix, the run launcher, the `cron` service facade and the
  client view helpers.
