/**
 * `dsh-cron`, browser half: installs the locale dictionaries and the scoped
 * stylesheet, mounts the `dshCron` Remote contribution, then registers the
 * scheduled-agents page into the `settings.section` slot (id `cron`). All
 * data arrives through the `remote.dshCron` namespace — the page issues no
 * other RPC and holds no state of its own beyond the last loaded snapshot.
 *
 * @module dsh-cron/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the 'remote' service merge onto the client Context (the
// shell graph owns the runtime value; this package reads the merged contract).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the 'locale' service merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the 'settings.section' SlotMap declaration into this
// program so the page registration typechecks against the real declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { CronSection, type CronSectionInjected } from './CronSection.tsx'
import { en, ru, type DshCronLocaleKey } from './locales.ts'
import { DSH_CRON_REMOTE } from './remote.ts'
import { installCronStyles } from './styles.ts'
import { decodeWire } from '../wire.ts'
import type { CronSnapshot, MutationResult, RunRecord, SchedulePreview } from '../types.ts'

export type { CronSectionInjected, CronSectionProps } from './CronSection.tsx'
export type { JobEditorProps } from './JobEditor.tsx'
export type { HistoryListProps } from './HistoryList.tsx'
export type { DshCronLocaleKey } from './locales.ts'
export {
  dayLabelKey, formatAbsoluteTime, formatDayDate, formatDuration, groupRunsByDay,
  JOB_NAME_MAX_LENGTH, JOB_NAME_PATTERN, overlapLabelKey, relativeTime,
  runStatusLabelKey, runStatusTone, sourceLabelKey, truncatePath, validateJobName,
} from './present.ts'
export type { RelativeTime, RunDayGroup, RunStatusLabelKey, Tone } from './present.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Scheduled-agents settings page copy. */
    'settings.dshCron': DshCronLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.dshCron'

/** Plugin name: matches the package name, the graph row id, and the bundle id. */
export const name = 'dsh-cron'

/** Services the page reads; `remote.dshCron` appears once this plugin mounts its contribution. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Minimal structural contract of the client slots registry this page
 * registers into. Declared locally because the service's owner package moved
 * across harness lines; the runtime contract is structural, so only the two
 * call sites this client uses are named here.
 */
interface DshCronSlots {
  inject(slot: string, callback: () => unknown): void
  register(options: {
    name: 'settings.section'
    id: 'cron'
    order: number
    label: () => string
    locale: string
    inject: () => CronSectionInjected
  }, component: unknown): () => void
}

/**
 * Browser plugin body: dictionaries, the scoped stylesheet, the Remote
 * contribution mount, and the settings page registration.
 *
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // `ru` is not one of the built-in registry locales (`en | zh`), so both
  // dictionaries register through the per-locale face; English stays the
  // registry fallback and Russian resolves under the user's local `ru` pack.
  ctx.effect(() => {
    const disposeEn = ctx.locale.register(NS, 'en', en)
    const disposeRu = ctx.locale.register(NS, 'ru', ru)
    return () => {
      disposeEn()
      disposeRu()
    }
  }, 'dsh-cron: dictionaries')
  ctx.effect(() => installCronStyles(), 'dsh-cron: stylesheet')

  // $mount registers the 'remote.dshCron' namespace service and owns its
  // removal for this fiber's lifetime.
  await ctx.remote.$mount(DSH_CRON_REMOTE)

  ctx.inject(['remote.dshCron'], (scope) => {
    const slots = scope.get('slots') as unknown as DshCronSlots
    const t = scope.locale.bind(NS)
    const unwrap = <T>(result: RemoteResult<T>, method: string): T => {
      if (!result.ok) {
        throw new Error(`dshCron.${method} failed: ${result.error.code}: ${result.error.message}`)
      }
      // Result codecs are strict JSON-string schemas on the wire; tolerate a
      // peer that already decoded the value (or sent an unexpected shape).
      return decodeWire<T>(result.value) ?? result.value
    }
    const status: CronSectionInjected['status'] = async () =>
      unwrap<CronSnapshot>(await scope.remote.dshCron.status(), 'status')
    const mutate: CronSectionInjected['mutate'] = async (requestJson) =>
      unwrap<MutationResult>(await scope.remote.dshCron.mutate(requestJson), 'mutate')
    const history: CronSectionInjected['history'] = async (jobName, limit) =>
      unwrap<RunRecord[]>(
        await scope.remote.dshCron.history(jobName, limit === undefined ? undefined : String(limit)),
        'history',
      )
    const preview: CronSectionInjected['preview'] = async (schedule, timezone) =>
      unwrap<SchedulePreview>(await scope.remote.dshCron.preview(schedule, timezone), 'preview')

    slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'cron',
      order: 30,
      label: () => t('nav'),
      locale: NS,
      inject: (): CronSectionInjected => ({ status, mutate, history, preview }),
    }, CronSection))
  })
}
