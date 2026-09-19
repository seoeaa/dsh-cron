/**
 * dsh-cron — reading services that may not be part of this plugin's lifetime.
 *
 * Cordis distinguishes two kinds of context property: a *provided* value
 * (`ctx.provide('name', value)`) is readable by anyone, while a *Service* is
 * readable only by a consumer that declares it in `inject`. This plugin wants
 * several neighbours it must not require — the job registry, the skill
 * registry, another scheduler, a conversation node — because a composition
 * without them still has to work (definitions, panel, sweep) and simply loses
 * the optional behaviour.
 *
 * So these reads are deliberate probes: absent, not-yet-mounted, or
 * not-injected all mean the same thing here — "this plugin is not around", and
 * the caller degrades instead of failing the mount.
 *
 * @module dsh-cron/optional
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Read one context property that may be absent or not injectable.
 * @param ctx - plugin context.
 * @param key - context property name.
 * @returns the value, or `undefined` when it cannot be read.
 */
export function optionalService<T>(ctx: Context, key: string): T | undefined {
  try {
    return ctx.get(key as never) as T | undefined
  } catch {
    // A Service the plugin does not inject is unreadable in cordis; that is a
    // "not available here" answer, not an error worth failing the mount for.
    return undefined
  }
}
