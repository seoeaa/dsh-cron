/**
 * dsh-cron — the Remote wire contract shared by the two halves.
 *
 * The settings page talks to the host through one Typert namespace, `dshCron`.
 * Payloads cross as JSON strings, so every codec is one strict string schema:
 * the loader requires zod-backed strict codecs (it rejects anything else), and
 * the shapes on both ends stay derivable from `src/types.ts` without a second
 * schema language to keep in sync.
 *
 * Both halves import THIS module — the host manifest (`src/typert.host.ts`) and
 * the client contribution (`src/client/remote.ts`) freeze the same descriptor
 * objects, and `encodeWire`/`decodeWire` are the only encoders either side uses.
 *
 * @module dsh-cron/wire
 */

import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** The Remote namespace this plugin registers. */
export const CRON_NAMESPACE = 'dshCron'

/** The cordis service that owns the Remote methods. */
export const CRON_SERVICE = 'cron'

/** Descriptor source position retained for diagnostics. */
const SOURCE = Object.freeze({ file: 'src/wire.ts', line: 1, column: 1 })

/** One strict JSON-string codec, labelled with the type it carries. */
function jsonStringCodec(typeSymbol: string) {
  return Object.freeze({
    mode: 'strict' as const,
    typeSymbol,
    schema: z.string(),
  })
}

/** One required JSON-string parameter. */
function stringParam(name: string, typeSymbol: string): InvocationDescriptor['parameters'][number] {
  return Object.freeze({
    name,
    wire: name,
    source: 'json',
    codec: jsonStringCodec(typeSymbol),
  } satisfies InvocationDescriptor['parameters'][number])
}

/** One optional JSON-string parameter. */
function optionalStringParam(name: string, typeSymbol: string): InvocationDescriptor['parameters'][number] {
  return Object.freeze({
    ...stringParam(name, typeSymbol),
    acceptsUndefined: true,
  } satisfies InvocationDescriptor['parameters'][number])
}

/**
 * `dshCron/status`: the whole panel snapshot (jobs, invalid files, engine
 * ownership, targets, clock) as one JSON string. No parameters — the panel
 * always renders the same complete view.
 */
export const CRON_STATUS_DESCRIPTOR = Object.freeze({
  id: 'dsh-cron#dshCron/status',
  service: CRON_SERVICE,
  namespace: CRON_NAMESPACE,
  method: 'status',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([]),
  result: jsonStringCodec('dsh-cron/types#CronSnapshotJson'),
  sourceLocation: SOURCE,
} satisfies InvocationDescriptor)

/**
 * `dshCron/mutate`: one editor or table action (save, remove, pause, resume,
 * run) as a JSON string, answered with the outcome plus the refreshed snapshot.
 */
export const CRON_MUTATE_DESCRIPTOR = Object.freeze({
  id: 'dsh-cron#dshCron/mutate',
  service: CRON_SERVICE,
  namespace: CRON_NAMESPACE,
  method: 'mutate',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([stringParam('requestJson', 'dsh-cron/types#JobMutationJson')]),
  result: jsonStringCodec('dsh-cron/types#MutationResultJson'),
  sourceLocation: SOURCE,
} satisfies InvocationDescriptor)

/**
 * `dshCron/history`: recent run records of one job as a JSON string.
 */
export const CRON_HISTORY_DESCRIPTOR = Object.freeze({
  id: 'dsh-cron#dshCron/history',
  service: CRON_SERVICE,
  namespace: CRON_NAMESPACE,
  method: 'history',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([
    stringParam('name', 'dsh-cron/types#JobName'),
    optionalStringParam('limit', 'dsh-cron/types#HistoryLimit'),
  ]),
  result: jsonStringCodec('dsh-cron/types#RunRecordArrayJson'),
  sourceLocation: SOURCE,
} satisfies InvocationDescriptor)

/**
 * `dshCron/preview`: the editor's live schedule feedback (description plus the
 * next fire times) for one expression and zone, as a JSON string.
 */
export const CRON_PREVIEW_DESCRIPTOR = Object.freeze({
  id: 'dsh-cron#dshCron/preview',
  service: CRON_SERVICE,
  namespace: CRON_NAMESPACE,
  method: 'preview',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([
    stringParam('schedule', 'dsh-cron/types#ScheduleExpression'),
    optionalStringParam('timezone', 'dsh-cron/types#TimeZone'),
  ]),
  result: jsonStringCodec('dsh-cron/types#SchedulePreviewJson'),
  sourceLocation: SOURCE,
} satisfies InvocationDescriptor)

/**
 * The canonical invocation list both Typert faces register — the host manifest
 * and the client contribution freeze these exact objects, so the two wire
 * codecs can never drift apart.
 */
export const CRON_INVOCATIONS = Object.freeze([
  CRON_STATUS_DESCRIPTOR,
  CRON_MUTATE_DESCRIPTOR,
  CRON_HISTORY_DESCRIPTOR,
  CRON_PREVIEW_DESCRIPTOR,
])

/**
 * Encode one Remote payload.
 *
 * Undefined and non-serializable values degrade to the JSON literal `null`
 * rather than throwing on the boundary: a Remote call must never fail because
 * the panel asked for something empty.
 */
export function encodeWire(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null'
  } catch {
    return 'null'
  }
}

/**
 * Decode one Remote payload, tolerating a malformed or absent body.
 * @param text - the JSON string the peer sent.
 * @returns the parsed value, or `undefined` when it cannot be parsed.
 */
export function decodeWire<T>(text: unknown): T | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
