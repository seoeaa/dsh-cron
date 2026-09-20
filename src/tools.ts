/**
 * dsh-cron — the model-facing tools.
 *
 * The point of these tools is that a model can schedule work without knowing
 * anything about this plugin's file layout: it previews a schedule, creates a
 * job by name, and can pause, run, inspect and delete it afterwards. Every tool
 * answers with canonical JSON (never prose the model would have to parse) and
 * every human sentence lives in `render`.
 *
 * The tool set mirrors the panel's actions on purpose: a job created in a
 * conversation is editable in the Web page, and the other way round — one store,
 * one state file, one meaning for "paused".
 *
 * @module dsh-cron/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'
import type { CronService } from './service.ts'
import type { CronJob, Delivery, RunRecord } from './types.ts'

/** Tool names, exported so docs and tests cannot drift from the registry. */
export const TOOL_NAMES = {
  list: 'cron_list',
  get: 'cron_get',
  preview: 'cron_preview',
  create: 'cron_create',
  update: 'cron_update',
  remove: 'cron_delete',
  pause: 'cron_pause',
  resume: 'cron_resume',
  run: 'cron_run',
  logs: 'cron_logs',
  targets: 'cron_targets',
} as const

/** Job view -> canonical JSON, dropping absent fields instead of nulling them. */
function jobView(job: CronJob, options: { prompt?: boolean } = {}): JobView {
  return {
    name: job.name,
    schedule: job.schedule,
    timezone: job.timezone,
    ...(options.prompt === true ? { prompt: job.prompt } : {}),
    cwd: job.cwd,
    profile: job.profile,
    overlap: job.overlap,
    timeoutMin: job.timeoutMin,
    deliver: job.deliver.map((entry) => entry.type),
    source: job.source,
    file: job.file,
    paused: job.paused,
    running: job.running,
    ...(job.nextRunAt !== undefined ? { nextRunAt: job.nextRunAt } : {}),
    ...(job.lastRunAt !== undefined ? { lastRunAt: job.lastRunAt } : {}),
    ...(job.lastStatus !== undefined ? { lastStatus: job.lastStatus } : {}),
    ...(job.lastError !== undefined ? { lastError: job.lastError } : {}),
  }
}

/** Run record -> canonical JSON. */
function runView(record: RunRecord): RunView {
  return {
    runId: record.runId,
    status: record.status,
    trigger: record.trigger,
    startedAt: new Date(record.startedAt).toISOString(),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.digest !== undefined ? { digest: record.digest } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.denied !== undefined ? { denied: record.denied.map((entry) => entry.toolName) } : {}),
  }
}

/** The output schema of one job view. */
const JOB_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    schedule: { type: 'string', required: true },
    timezone: { type: 'string', required: true },
    prompt: { type: 'string', description: 'the prompt one run executes' },
    cwd: { type: 'string', required: true },
    profile: { type: 'string', required: true },
    overlap: { type: 'string', required: true, enum: ['skip', 'queue', 'cancel-previous'] },
    timeoutMin: { type: 'integer', required: true },
    deliver: { type: 'array', required: true, items: { type: 'string', enum: ['file', 'chatnode'] } },
    source: { type: 'string', required: true, enum: ['project', 'global'] },
    file: { type: 'string', required: true },
    paused: { type: 'boolean', required: true },
    running: { type: 'boolean', required: true },
    nextRunAt: { type: 'string', description: 'ISO instant of the next fire time; absent when paused or unresolvable' },
    lastRunAt: { type: 'string', description: 'ISO instant of the last launch' },
    lastStatus: { type: 'string', enum: ['running', 'completed', 'failed', 'killed', 'timeout', 'skipped'] },
    lastError: { type: 'string' },
  },
} as const

/** The output schema of one run view. */
const RUN_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['running', 'completed', 'failed', 'killed', 'timeout', 'skipped'] },
    trigger: { type: 'string', required: true, enum: ['schedule', 'manual'] },
    startedAt: { type: 'string', required: true, description: 'ISO instant' },
    durationMs: { type: 'integer' },
    sessionId: { type: 'string', description: 'session log of the run, replayable later' },
    digest: { type: 'string' },
    error: { type: 'string' },
    denied: { type: 'array', items: { type: 'string' }, description: 'tool calls auto-denied in the unattended run' },
  },
} as const

/**
 * The canonical value types, derived from the schemas the model is shown.
 *
 * Deriving them means a schema edit cannot leave the documented shape and the
 * value the tool actually returns out of step.
 */
export type JobView = InferValue<typeof JOB_VIEW_SCHEMA>
export type RunView = InferValue<typeof RUN_VIEW_SCHEMA>

/** The `deliver` parameter, shared by create and update. */
const DELIVER_PARAM = {
  type: 'array',
  items: { type: 'string', enum: ['file', 'chatnode'] },
  description: 'channels a finished digest goes to; the file digest is always written next to the job cwd',
} as const

/** Tool input -> stored delivery list, ignoring values the schema rejected. */
function deliveryOf(values: readonly string[] | undefined): Delivery[] | undefined {
  if (values === undefined) return undefined
  return values
    .filter((value): value is Delivery['type'] => value === 'file' || value === 'chatnode')
    .map((type) => ({ type }))
}

/** One readable line describing a job's live state. */
function jobLine(job: JobView): string {
  const state = job.paused
    ? 'paused'
    : job.running
      ? 'running now'
      : job.nextRunAt !== undefined
        ? `next ${job.nextRunAt}`
        : 'no next run resolvable'
  const last = job.lastStatus !== undefined ? `, last ${job.lastStatus}` : ''
  return `- ${job.name} (${job.schedule} ${job.timezone}, ${job.overlap}, ${String(job.timeoutMin)}min, ${job.source}): ${state}${last}`
}

/** One readable line per run record. */
function runLine(record: RunView, index: number): string {
  const duration = record.durationMs !== undefined ? ` ${String(Math.round(record.durationMs / 1000))}s` : ''
  const detail = (record.error ?? record.digest ?? '').split('\n')[0] ?? ''
  return `${String(index + 1)}. [${record.status}] ${record.startedAt}${duration}${detail === '' ? '' : ` — ${detail}`}`
}

/**
 * Install every cron tool.
 * @param ctx - plugin context carrying the tools registry.
 * @param service - the `cron` service the tools delegate to.
 */
export function installCronTools(ctx: Context, service: CronService): void {
  ctx.tools.register(defineTool({
    name: TOOL_NAMES.list,
    description: [
      'List the scheduled cron jobs of this machine: name, schedule, timezone, next and last run,',
      'paused/running state, plus any definition file that failed to parse.',
      'Call it before creating, editing or deleting a job so the name you pick is free and current.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobs: { type: 'array', required: true, items: JOB_VIEW_SCHEMA },
          invalid: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                file: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          scheduling: { type: 'string', required: true, description: 'which engine fires these jobs' },
        },
      },
      render: (_args, value) => {
        const lines = value.jobs.length === 0
          ? ['No cron jobs are defined yet.']
          : [`${String(value.jobs.length)} cron job(s):`, ...value.jobs.map(jobLine)]
        if (value.invalid.length > 0) {
          lines.push('', `${String(value.invalid.length)} definition file(s) could not be parsed:`)
          for (const entry of value.invalid) lines.push(`- ${entry.file}: ${entry.error}`)
        }
        lines.push('', `Scheduling: ${value.scheduling}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const engine = service.engine()
      return {
        jobs: service.list().map((job) => jobView(job)),
        invalid: service.invalidFiles().map((entry) => ({ name: entry.name, file: entry.file, error: entry.error })),
        scheduling: engine.mode === 'own'
          ? 'dsh-cron'
          : `${engine.owner ?? 'another plugin'} (${engine.reason ?? 'not owned here'})`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.get,
    description: [
      'Show one cron job in full, including the prompt it runs and where its definition file lives.',
      'Fails when no job has that name — call the list tool first.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'job name' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { job: { ...JOB_VIEW_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.job.name} — ${value.job.schedule} (${value.job.timezone})`,
          `cwd: ${value.job.cwd}`,
          `profile: ${value.job.profile}, overlap: ${value.job.overlap}, timeout: ${String(value.job.timeoutMin)}min`,
          `deliver: ${value.job.deliver.join(', ')}`,
          `definition: ${value.job.file} (${value.job.source})`,
          jobLine(value.job).replace(/^- /, 'state: '),
          '',
          'prompt:',
          value.job.prompt ?? '(not stored)',
        ].join('\n'),
      }],
    },
    async execute(args) {
      const job = service.get(args.name)
      if (job === undefined) throw new Error(`no cron job named "${args.name}"`)
      return { job: jobView(job, { prompt: true }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.preview,
    description: [
      'Check a schedule before saving it: a human description, the normalized five-field cron form,',
      'and the next three fire times in the given timezone. Call it instead of guessing whether an',
      'expression means what the user asked for.',
    ].join(' '),
    parameters: {
      schedule: { type: 'string', required: true, description: '5-field cron, @daily/@hourly/…, or "every 30m"' },
      timezone: { type: 'string', description: 'IANA zone such as Europe/Moscow; defaults to the plugin timezone' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          description: { type: 'string', required: true },
          normalized: { type: 'string' },
          nextRuns: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.description}${value.normalized === undefined ? '' : ` (${value.normalized})`}\nNext: ${value.nextRuns.join(', ')}`
          : `Invalid schedule: ${value.error ?? 'unknown error'}`,
      }],
    },
    async execute(args) {
      const preview = service.schedulePreview(args.schedule, args.timezone)
      return {
        ok: preview.ok,
        description: preview.description,
        nextRuns: preview.nextRuns,
        ...(preview.normalized !== undefined ? { normalized: preview.normalized } : {}),
        ...(preview.error !== undefined ? { error: preview.error } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.create,
    description: [
      'Create (or overwrite by name) a scheduled cron job. Each run executes the prompt unattended in',
      'its own directory, with no permission prompts (anything that would ask is denied and reported),',
      'and writes a digest next to the job cwd. Preview the schedule first, and write a prompt that',
      'stands on its own: the run has no memory of this conversation and nobody to ask.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'lowercase letters/digits/dashes, e.g. nightly-tests' },
      schedule: { type: 'string', required: true, description: '5-field cron, @daily/@hourly/…, or "every 30m"' },
      prompt: { type: 'string', required: true, description: 'the full prompt one run executes' },
      timezone: { type: 'string', description: 'IANA zone; defaults to the plugin timezone, never the host zone silently' },
      cwd: { type: 'string', description: 'working directory of the run; defaults to the project directory' },
      profile: { type: 'string', description: 'DSH profile the run boots; defaults to headless' },
      overlap: { type: 'string', enum: ['skip', 'queue', 'cancel-previous'], description: 'what to do when the previous run is still going' },
      timeoutMin: { type: 'integer', description: 'hard stop in minutes' },
      deliver: DELIVER_PARAM,
      scope: { type: 'string', enum: ['project', 'global'], description: 'where the definition file is written' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { job: { ...JOB_VIEW_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved cron job "${value.job.name}" (${value.job.schedule} ${value.job.timezone}) as ${value.job.file}`
          + (value.job.nextRunAt === undefined ? '' : `\nNext run: ${value.job.nextRunAt}`),
      }],
    },
    async execute(args) {
      const stored = service.save({
        name: args.name,
        schedule: args.schedule,
        prompt: args.prompt,
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.profile !== undefined ? { profile: args.profile } : {}),
        ...(args.overlap !== undefined ? { overlap: args.overlap } : {}),
        ...(args.timeoutMin !== undefined ? { timeoutMin: args.timeoutMin } : {}),
        ...(deliveryOf(args.deliver) !== undefined ? { deliver: deliveryOf(args.deliver) as Delivery[] } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
      })
      return { job: jobView(service.get(stored.name) ?? stored) }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.update,
    description: [
      'Change one existing cron job. Only the fields you pass are replaced; every other field keeps its',
      'current value. Pass `scope` to move a definition between the project and the global directory.',
      'Fails when no job has that name.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'job to change' },
      schedule: { type: 'string' },
      prompt: { type: 'string' },
      timezone: { type: 'string' },
      cwd: { type: 'string' },
      profile: { type: 'string' },
      overlap: { type: 'string', enum: ['skip', 'queue', 'cancel-previous'] },
      timeoutMin: { type: 'integer' },
      deliver: DELIVER_PARAM,
      scope: { type: 'string', enum: ['project', 'global'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { job: { ...JOB_VIEW_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated cron job "${value.job.name}" (${value.job.schedule} ${value.job.timezone})`,
      }],
    },
    async execute(args) {
      const existing = service.get(args.name)
      if (existing === undefined) {
        throw new Error(`no cron job named "${args.name}" — call ${TOOL_NAMES.list} first`)
      }
      const stored = service.save({
        name: existing.name,
        schedule: args.schedule ?? existing.schedule,
        prompt: args.prompt ?? existing.prompt,
        timezone: args.timezone ?? existing.timezone,
        cwd: args.cwd ?? existing.cwd,
        profile: args.profile ?? existing.profile,
        overlap: args.overlap ?? existing.overlap,
        timeoutMin: args.timeoutMin ?? existing.timeoutMin,
        deliver: deliveryOf(args.deliver) ?? existing.deliver,
        scope: args.scope ?? existing.source,
      })
      return { job: jobView(service.get(stored.name) ?? stored) }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.remove,
    description: [
      'Delete one cron job definition. Its run records and digests stay on disk under the job cwd,',
      'while its durable marks (pause state, run anchors, last status) are cleared, so a later job that',
      'takes the same name starts clean rather than inheriting them.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'job to delete' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deleted ? `Deleted cron job "${value.name}".` : `No job named "${value.name}".`,
      }],
    },
    async execute(args) {
      return { deleted: service.remove(args.name), name: args.name }
    },
  }))

  installPauseTool(ctx, service, TOOL_NAMES.pause, true,
    'Pause one cron job: it keeps its definition and history but stops firing.')
  installPauseTool(ctx, service, TOOL_NAMES.resume, false,
    'Resume a paused cron job so it fires on its schedule again.')

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.run,
    description: [
      'Run one cron job immediately, out of band, and wait for it to finish. Use it to verify a job you',
      'just created; each call is a real unattended run that costs model tokens, so never call it in a loop.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'job to run now' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { record: { ...RUN_VIEW_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Run ${value.record.runId}: ${value.record.status} (${String(Math.round((value.record.durationMs ?? 0) / 1000))}s)`,
          ...(value.record.sessionId !== undefined ? [`session: ${value.record.sessionId}`] : []),
          ...(value.record.denied !== undefined && value.record.denied.length > 0
            ? [`denied: ${value.record.denied.join(', ')}`]
            : []),
          '',
          value.record.digest ?? value.record.error ?? '(no output)',
        ].join('\n'),
      }],
    },
    async execute(args) {
      return { record: runView(await service.runNow(args.name)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.logs,
    description: 'Show recent runs of one cron job: status, start time, duration, digest, session id and failures.',
    parameters: {
      name: { type: 'string', required: true, description: 'job name' },
      limit: { type: 'integer', description: 'how many runs to show (default 10)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { runs: { type: 'array', required: true, items: RUN_VIEW_SCHEMA } },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.runs.length === 0
          ? `No runs recorded for "${args.name}" yet.`
          : [`Recent runs of "${args.name}":`, ...value.runs.map(runLine)].join('\n'),
      }],
    },
    async execute(args) {
      return { runs: service.records(args.name, args.limit ?? 10).map((record) => runView(record)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.targets,
    description: 'List where a finished run\'s digest can be delivered right now; the file digest is always available.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                available: { type: 'boolean', required: true },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.targets
          .map((target) => `${target.available ? '✓' : '✗'} ${target.id} — ${target.label}${target.note === undefined ? '' : ` (${target.note})`}`)
          .join('\n'),
      }],
    },
    async execute() {
      return {
        targets: service.targets().map((target) => ({
          id: target.id,
          label: target.label,
          available: target.available,
          ...(target.note !== undefined ? { note: target.note } : {}),
        })),
      }
    },
  }))
}

/** Pause and resume differ by one boolean, so they share one registration. */
function installPauseTool(
  ctx: Context,
  service: CronService,
  name: string,
  paused: boolean,
  description: string,
): void {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters: {
      name: { type: 'string', required: true, description: 'job name' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          updated: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          paused: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated
          ? `"${value.name}" is now ${value.paused ? 'paused' : 'active'}.`
          : `No job named "${value.name}".`,
      }],
    },
    async execute(args) {
      return { updated: service.setPaused(args.name, paused), name: args.name, paused }
    },
  }))
}
