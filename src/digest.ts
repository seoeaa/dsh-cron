/**
 * dsh-cron — digest construction for one run.
 *
 * The run driver executes inside a one-shot `dsh` subprocess, where the only
 * guaranteed resolvable modules are Node builtins and this package's own lib
 * files. These helpers stay pure for that reason: they read the session event
 * stream the harness already produced and turn it into the three facts a run
 * record needs — the last assistant text, the turn outcome, and the permission
 * requests that were auto-denied because nobody was watching.
 *
 * @module dsh-cron/digest
 */

import type { DeniedApproval } from './types.ts'

/** A last assistant message at or below this many characters is the digest. */
export const DEFAULT_DIGEST_MAX_CHARS = 2_000
/** Byte cap on the session-log text handed to the summarizer. */
export const DEFAULT_SUMMARY_MAX_CHARS = 24_000
/** Output-token cap for the one-shot summarizer call. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 400
/** End-to-end deadline for the summarizer call. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 60_000

/** Minimal shape of one durable session event, as a run driver sees it. */
export interface RunEvent {
  seq: number
  type: string
  data: unknown
}

/** Outcome of reading one run out of a session log. */
export interface RunOutcome {
  /** The last assistant text of the run, or `''` when the model said nothing. */
  text: string
  /** Why the turn ended, when the log carries a `turn/end`. */
  reason?: { kind?: string; error?: { message?: string } }
}

/** Join the text blocks of one message content array. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const candidate = block as { type?: unknown; text?: unknown }
      if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
    }
  }
  return text
}

/**
 * Read the last assistant text and the turn outcome since `firstSeq`.
 *
 * Only events at or after the run's first sequence count, which is what makes
 * a run's digest independent of anything the session did before it: the run
 * creates a fresh session, but a resumed one must still report only its own turn.
 */
export function summarizeEvents(events: readonly RunEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: RunOutcome['reason']
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: unknown } } | undefined
      const joined = textOf(data?.message?.content)
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      reason = (event.data as { reason?: RunOutcome['reason'] } | undefined)?.reason
    }
  }
  return reason === undefined ? { text } : { text, reason }
}

/** The bounded user/assistant transcript of a run, for the summarizer call. */
export function transcriptOf(
  events: readonly RunEvent[],
  firstSeq: number,
  maxChars: number,
): string {
  const lines: string[] = []
  let total = 0
  for (const event of events) {
    if (event.seq < firstSeq) continue
    let text = ''
    let role: string
    if (event.type === 'user/message') {
      text = textOf((event.data as { content?: unknown } | undefined)?.content)
      role = 'USER'
    } else if (event.type === 'assistant/message') {
      text = textOf((event.data as { message?: { content?: unknown } } | undefined)?.message?.content)
      role = 'ASSISTANT'
    } else {
      continue
    }
    if (text === '') continue
    const line = `${role}: ${text}`
    if (total + line.length > maxChars) {
      lines.push(line.slice(0, Math.max(0, maxChars - total)))
      break
    }
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
}

/**
 * Collect the permission requests that were auto-denied during the run.
 *
 * A run is unattended, so the accepted outcome for a permission request is
 * "denied"; anything that was not explicitly allowed-once is reported, because
 * that is exactly the set of things the operator may need to widen later.
 */
export function deniedApprovalsOf(events: readonly RunEvent[]): DeniedApproval[] {
  const asked = new Map<string, DeniedApproval>()
  const decided = new Map<string, unknown>()
  for (const event of events) {
    if (event.type === 'approval/asked') {
      const data = event.data as { id?: unknown; toolName?: unknown; reason?: unknown } | undefined
      if (typeof data?.id !== 'string') continue
      const entry: DeniedApproval = {
        toolName: typeof data.toolName === 'string' ? data.toolName : 'unknown',
      }
      if (typeof data.reason === 'string') entry.reason = data.reason
      asked.set(data.id, entry)
    } else if (event.type === 'approval/decided') {
      const data = event.data as { id?: unknown; outcome?: unknown } | undefined
      if (typeof data?.id === 'string') decided.set(data.id, data.outcome)
    }
  }
  const denied: DeniedApproval[] = []
  for (const [id, entry] of asked) {
    if (decided.get(id) !== 'allowed-once') denied.push(entry)
  }
  return denied
}

/** Truncate text to `max` characters with an explicit marker. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Recursively freeze a plain value, so injected messages cannot be mutated. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) deepFreeze(record[key])
    Object.freeze(value)
  }
  return value
}

/** The summarizer system prompt, stable across runs so digests compare. */
export const SUMMARY_SYSTEM = [
  'You summarize one unattended agent run for a busy operator who will read it on a phone.',
  'Rules: at most 10 lines; say what was done and what still needs attention;',
  'keep concrete details (paths, names, numbers); no greetings, no filler, no markdown headings.',
].join(' ')
