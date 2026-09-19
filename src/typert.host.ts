/**
 * dsh-cron — the hand-written Typert HOST manifest.
 *
 * Exported as `./typert`, the path the harness's typert loader reads when this
 * package mounts. The manifest carries the same frozen invocation descriptors
 * as the client contribution (`src/client/remote.ts`), because both faces must
 * agree on the wire; `src/wire.ts` is the one place those objects are built.
 *
 * @module dsh-cron/typert
 */

import { CRON_INVOCATIONS } from './wire.ts'

/** Host Typert manifest (validated by the harness's typert loader). */
export const TYPERT = Object.freeze({
  package: 'dsh-cron',
  face: 'host',
  schemas: Object.freeze([]),
  invocations: CRON_INVOCATIONS,
  model: Object.freeze({
    services: Object.freeze([]),
    events: Object.freeze([]),
    objects: Object.freeze([]),
  }),
})
