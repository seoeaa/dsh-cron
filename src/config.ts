/**
 * dsh-cron — plugin configuration.
 *
 * Every field has a default that makes the plugin useful with an empty config
 * row, because the panel and the tools must work on a profile that only added
 * the bundle. `engine` is the one field with real consequences: it decides
 * whether this plugin schedules jobs or only edits their definitions, which is
 * how two schedulers can never double-fire the same job by accident.
 *
 * @module dsh-cron/config
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { dshHome } from './store.ts'

/**
 * The compiled run driver of this package.
 *
 * Resolved from this module's own location, so a run overlay always points at
 * the driver that belongs to the installed copy — whether the bundle came from
 * a registry, a git checkout or a `file:` link.
 */
export const DEFAULT_RUN_MODULE = fileURLToPath(new URL('./run.js', import.meta.url))

/** Who owns scheduling when more than one engine is installed. */
export type EngineMode = 'auto' | 'own' | 'off'

/** Plugin configuration with defaults applied by the loader. */
export interface Config {
  /** Project directory whose `.dsh/routines/` holds project-scoped jobs. */
  projectDir: string
  /** Directory holding global jobs (`~/.dsh/routines` by default). */
  globalDir: string
  /**
   * `auto` schedules here only while no other scheduler is mounted, `own`
   * always schedules, `off` never schedules (edit-only mode).
   */
  engine: EngineMode
  /** Seconds between two due-time sweeps. */
  tickSeconds: number
  /** Binary used for run subprocesses; `DSH_BIN` overrides it. */
  dshBin: string
  /** Profile a run boots unless the job names another one. */
  defaultProfile: string
  /** Timezone applied to a definition that does not name one. */
  defaultTimezone: string
  /** Timeout applied to a definition that does not name one. */
  defaultTimeoutMin: number
  /** Whether the panel and the `cron_run` tool may start a run out of band. */
  allowRunNow: boolean
  /** Run records kept per job in the panel; older files are pruned. */
  maxHistoryPerJob: number
  /** Rebuild the schedule watchers when definitions change on disk. */
  watch: boolean
  /** A last assistant message at or below this many characters is the digest. */
  digestMaxChars: number
  /** Byte cap on the transcript handed to the run's summarizer. */
  summaryMaxChars: number
  /** Output-token cap for the summarizer call. */
  summaryMaxTokens: number
  /** End-to-end deadline for the summarizer call. */
  summaryTimeoutMs: number
  /** Absolute path of the module a run subprocess mounts as its driver. */
  runModule: string
}

/** Validated plugin schema; every default is applied by the loader. */
export const Config = z.object({
  projectDir: z.string().default(process.cwd()),
  globalDir: z.string().default(join(dshHome(), 'routines')),
  engine: z.union([z.const('auto'), z.const('own'), z.const('off')]).default('auto'),
  tickSeconds: z.natural().min(5).max(3600).default(20),
  dshBin: z.string().default(process.env.DSH_BIN ?? 'dsh'),
  defaultProfile: z.string().default('headless'),
  defaultTimezone: z.string().default('UTC'),
  defaultTimeoutMin: z.natural().min(1).max(1440).default(45),
  allowRunNow: z.boolean().default(true),
  maxHistoryPerJob: z.natural().min(1).max(1000).default(50),
  watch: z.boolean().default(true),
  digestMaxChars: z.natural().default(2000),
  summaryMaxChars: z.natural().default(24000),
  summaryMaxTokens: z.natural().default(400),
  summaryTimeoutMs: z.natural().default(60000),
  runModule: z.string().default(DEFAULT_RUN_MODULE),
})
