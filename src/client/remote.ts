/**
 * The client-side Remote face of the `dshCron` namespace: the hand-written
 * `TypertRemoteContribution` mounted through `ctx.remote.$mount`, plus the
 * declaration merging that types `ctx.remote.dshCron`. The descriptor list is
 * shared with the host `./typert` manifest (`../wire.ts`), so the two faces
 * can never drift.
 *
 * @module dsh-cron/client/remote
 */

import type { RemoteResult, TypertRemoteContribution, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import { CRON_INVOCATIONS } from '../wire.ts'
import type { CronSnapshot, MutationResult, RunRecord, SchedulePreview } from '../types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    /** Read the whole panel snapshot (jobs, invalid files, engine, targets, clock). */
    'dshCron/status': () => Promise<RemoteResult<CronSnapshot>>
    /** Apply one job mutation and receive the refreshed snapshot back. */
    'dshCron/mutate': (requestJson: string) => Promise<RemoteResult<MutationResult>>
    /** Read one job's recent run records, newest first. `limit` crosses as a JSON string. */
    'dshCron/history': (name: string, limit?: string) => Promise<RemoteResult<RunRecord[]>>
    /** Validate one schedule expression and preview its next fire times. */
    'dshCron/preview': (schedule: string, timezone?: string) => Promise<RemoteResult<SchedulePreview>>
  }
  interface TypertRemoteNamespaceMap {
    dshCron: TypertRemoteNamespace<'dshCron'>
  }
}

/** The client Remote contribution for the `dshCron` namespace. */
export const DSH_CRON_REMOTE = Object.freeze({
  package: 'dsh-cron',
  descriptors: CRON_INVOCATIONS,
} satisfies TypertRemoteContribution)
