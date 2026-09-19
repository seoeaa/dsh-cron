/**
 * dsh-cron — the child-side run driver.
 *
 * One process is booted per run: `dsh --profile <profile> --patch <overlay> --`
 * with the overlay replacing the stock headless runner with this module. The
 * driver therefore executes *inside the run's own process* and owns the facts
 * of that run: it drives one fresh Agent, reads the session log it produced,
 * and writes the run record (status, digest, session id, denied approvals).
 *
 * Resolution constraint: this module is imported by absolute path from whatever
 * profile the run boots, so it depends only on Node builtins and this package's
 * own lib files. Every harness capability arrives through an injected service,
 * and the services are typed structurally here on purpose — the child profile is
 * not necessarily the profile this file was compiled against.
 *
 * With no run record configured it degrades to a plain one-shot run: drive the
 * task, print the final assistant text, exit.
 *
 * @module dsh-cron/run
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_DIGEST_MAX_CHARS,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_SUMMARY_TIMEOUT_MS,
  SUMMARY_SYSTEM,
  deepFreeze,
  deniedApprovalsOf,
  summarizeEvents,
  transcriptOf,
  truncate,
  type RunEvent,
} from './digest.ts'
import { readRun, writeRun } from './runs.ts'
import type { RunRecord } from './types.ts'

/** Stable cordis plugin name for the run driver. */
export const name = 'dsh-cron-run'

/** Core services a one-shot run needs before it can start. */
export const inject = ['loader', 'agents', 'agentDefaultModel', 'sessions', 'llm', 'headlessStartup']

/** Driver configuration, written into the generated run overlay. */
export interface RunConfig {
  /** The prompt this run executes. */
  task: string
  /** Job name, for the record. */
  routine?: string
  /** Run id shared with the record the scheduler pre-created. */
  runId?: string
  /** Characters of the last assistant message that make an acceptable digest. */
  digestMaxChars: number
  summaryMaxChars: number
  summaryMaxTokens: number
  summaryTimeoutMs: number
}

/** Validated driver schema. */
export const Config = z.object({
  task: z.string().required(),
  routine: z.string(),
  runId: z.string(),
  digestMaxChars: z.natural().default(DEFAULT_DIGEST_MAX_CHARS),
  summaryMaxChars: z.natural().default(DEFAULT_SUMMARY_MAX_CHARS),
  summaryMaxTokens: z.natural().default(DEFAULT_SUMMARY_MAX_TOKENS),
  summaryTimeoutMs: z.natural().default(DEFAULT_SUMMARY_TIMEOUT_MS),
})

/** The minimal Agent surface this driver uses. */
interface RunAgent {
  session: { id: string; seq: number; events: readonly RunEvent[] }
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

/** The process streams the driver writes to; tests substitute captures. */
export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Report an unexpected driver failure and ask the launcher for a failing exit. */
function fail(io: { stderr: { write(text: string): unknown }; exit(code: number): void }, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  io.stderr.write(`dsh-cron: ${message}\n`)
  io.exit(1)
}

/**
 * One-shot summarizer call over the run transcript.
 * @returns the summary, or `undefined` when the call failed or produced nothing.
 */
async function summarizeTranscript(
  ctx: Context,
  transcript: string,
  selection: { provider: string; model: string },
  config: RunConfig,
  sessionId: string,
): Promise<string | undefined> {
  const llm = ctx.get('llm') as
    | { stream(options: unknown): AsyncIterable<{ type: string; text?: string }> }
    | undefined
  if (llm === undefined) return undefined
  const signal = AbortSignal.timeout(config.summaryTimeoutMs)
  const options = deepFreeze({
    provider: selection.provider,
    model: selection.model,
    messages: [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: transcript }],
      source: { kind: 'plugin' as const, plugin: 'dsh-cron' },
    }],
    system: SUMMARY_SYSTEM,
    maxTokens: config.summaryMaxTokens,
    sessionId,
    signal,
  })
  let text = ''
  try {
    for await (const chunk of llm.stream(options)) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch {
    return undefined
  }
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Drive one run: create the Agent, execute the task, then write the record.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated driver configuration from the run overlay.
 * @param io - streams and the launcher's exit request.
 */
export async function run(
  ctx: Context,
  config: RunConfig,
  io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown }; exit(code: number): void },
): Promise<void> {
  await (ctx.get('loader') as { await?: () => Promise<void> } | undefined)?.await?.()
  const agents = ctx.get('agents') as
    | { create(spec: unknown): Promise<{ agent: RunAgent }> }
    | undefined
  const defaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider: string; model: string } }
    | undefined
  const sessions = ctx.get('sessions') as
    | { flush(session: unknown): Promise<void> }
    | undefined
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('dsh-cron-run: missing core services (agents, agentDefaultModel, sessions)')
  }

  const cwd = process.cwd()
  const runId = config.runId ?? `run-${Date.now()}`
  const existing = readRun(cwd, runId)
  const startedAt = existing?.startedAt ?? Date.now()
  const selection = defaultModel.currentSelection()

  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd },
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const outcome = summarizeEvents(agent.session.events, firstSeq)
  const finishedAt = Date.now()
  const completed = outcome.reason?.kind === 'completed'
  const digestMaxChars = config.digestMaxChars

  let digest: string
  let summarized = false
  if (outcome.text !== '' && outcome.text.length <= digestMaxChars) {
    digest = outcome.text
  } else if (outcome.text !== '') {
    const transcript = transcriptOf(agent.session.events, firstSeq, config.summaryMaxChars)
    const summary = await summarizeTranscript(ctx, transcript, selection, config, agent.session.id)
    if (summary === undefined) {
      digest = `${truncate(outcome.text, digestMaxChars)}\n\n(truncated: the digest call failed, so this is the head of the last assistant message)`
    } else {
      digest = summary
      summarized = true
    }
  } else {
    digest = '(no assistant output)'
  }

  const record: RunRecord = {
    runId,
    routine: existing?.routine ?? config.routine ?? '(unknown)',
    profile: existing?.profile ?? '',
    cwd,
    status: completed ? 'completed' : 'failed',
    trigger: existing?.trigger ?? 'manual',
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    exitCode: completed ? 0 : 1,
    sessionId: agent.session.id,
    digest,
    denied: deniedApprovalsOf(agent.session.events),
    ...(completed ? {} : { error: outcome.reason?.error?.message ?? 'run ended without completion' }),
  }
  writeRun(cwd, record)

  io.stdout.write(`${outcome.text}${summarized ? '\n\n<!-- dsh-cron: summarized -->' : ''}\n`)
  io.exit(completed ? 0 : 1)
}

/**
 * Mount the run driver.
 * @param ctx - plugin context carrying the core services and the launcher exit.
 * @param config - validated driver configuration.
 */
export function apply(ctx: Context, config: RunConfig): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) {
    throw new Error('dsh-cron-run: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
