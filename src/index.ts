/**
 * dsh-cron — plugin assembly.
 *
 * One bundle, five rows (see `cordis.patch.yml`): this host half owns the job
 * store, the durable state, the sweep and the run launcher; the tools and the
 * runtime skill are what the model sees; the Remote face is what the Web page
 * reads. Everything hangs off one `cron` service, so the panel, the tools and
 * the sweep can never disagree about what a job's state is.
 *
 * The host half is deliberately tolerant about optional neighbours: a
 * composition without a skill registry, without a jobs registry, or without the
 * Web app still gets a working scheduler and a working tool set, and says so
 * through the surfaces that do exist.
 *
 * @module dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import { CronService } from './service.ts'
import { installCronTools } from './tools.ts'
import { installCronSkill } from './skill.ts'
import type { Config } from './config.ts'

export { CronService, VERSION } from './service.ts'
export { Config, DEFAULT_RUN_MODULE } from './config.ts'
export { TOOL_NAMES } from './tools.ts'
export { SKILL_NAME } from './skill.ts'
export { TYPERT } from './typert.host.ts'
export type { Config as CronConfig } from './config.ts'

/** Stable plugin name: the package name, the graph row id and the bundle id. */
export const name = 'dsh-cron'

/**
 * Services required before the plugin can be useful.
 *
 * `timer` owns the sweep and `tools` owns the model-facing surface; both are
 * core, so a composition missing either is not one this plugin can serve.
 * Everything else it touches (the job registry, the skill registry, another
 * scheduler, a conversation node) is read as an optional neighbour instead —
 * see `./optional.ts`.
 */
export const inject = ['timer', 'tools']

/**
 * Mount the plugin.
 * @param ctx - plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new CronService(ctx, config)
  installCronTools(ctx, service)
  installCronSkill(ctx, (reason) => { logWarning(ctx, reason) })

  service.start()
  if (service.engine().mode !== 'own') {
    logWarning(ctx, `scheduling is not owned here: ${service.engine().reason ?? 'another engine is active'}`)
  }
}

/** Report a non-fatal degradation through the context logger when one exists. */
function logWarning(ctx: Context, message: string): void {
  const logger = ctx.logger as { warn?(text: string): void } | undefined
  logger?.warn?.(`dsh-cron: ${message}`)
}
