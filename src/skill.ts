/**
 * dsh-cron — the embedded `cron` skill.
 *
 * Tools alone tell a model *what* it can call; they do not tell it *when* the
 * call is the right move. That gap is where scheduled work usually goes wrong:
 * a job created for something that only needed doing once, a schedule nobody
 * confirmed, a target nobody picked. This skill is the missing instruction, and
 * it ships inside the plugin so it cannot fall out of step with the tools it
 * describes.
 *
 * Registration is a no-op when no skill registry is mounted (`ctx.skills`), so
 * the plugin still works in a composition that does not include skills.
 *
 * @module dsh-cron/skill
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { optionalService } from './optional.ts'

/** Name the skill is addressed by, in discovery and in `/` commands. */
export const SKILL_NAME = 'cron'

/** Routing description shown by skill discovery consumers. */
export const SKILL_DESCRIPTION =
  'Schedule unattended agent work: create, inspect, pause, run and delete cron jobs whose runs happen on a schedule without you being present.'

/** Extra routing guidance (the "when to reach for this" line). */
export const SKILL_WHEN_TO_USE =
  'Use when the user wants something done later, repeatedly, or on a schedule (daily/weekly/hourly, "tomorrow at 9", "every 30 minutes"), or when they ask about existing scheduled jobs and their results. Do NOT use it for work that should happen now, in this conversation, once.'

/**
 * The skill body.
 *
 * Written for the model, not for a human browsing docs: the order is
 * decide → confirm → preview → create → verify, because that is the order in
 * which the mistakes happen.
 */
export const SKILL_CONTENT = `# Cron — scheduled unattended work

## Decide first

Schedule something only when **the work must happen later, or again**. If the
request can be satisfied right now in this conversation, do it now and do not
create a job. Never create a job "to be safe".

Before creating anything, be able to answer:

1. **What exactly runs?** The prompt must be self-contained — the run happens
   unattended in a fresh session, with no memory of this conversation, no
   access to what you just learned, and no one to answer a question.
2. **When?** A concrete 5-field cron expression, a macro (\`@daily\`), or an
   interval (\`every 30m\`), plus the IANA timezone the user means.
3. **Where?** The working directory, because relative paths and the digest
   location both follow from it.
4. **How much?** The timeout in minutes, and what to do if the previous run is
   still going (\`skip\` is the safe default).

If any of these is unclear, ask. A vague job fires forever and its reports are
noise.

## The tools

| Tool | Use it for |
| --- | --- |
| \`cron_list\` | before creating/editing — names must be unique; also shows invalid files |
| \`cron_preview\` | validate a schedule and see the next fire times before saving |
| \`cron_create\` | write a new definition (or overwrite one by name) |
| \`cron_update\` | change only the fields you pass |
| \`cron_pause\` / \`cron_resume\` | stop/restart firing without losing the definition or history |
| \`cron_run\` | run it once now to verify it works (a real unattended run — use sparingly) |
| \`cron_logs\` | what happened in recent runs: status, duration, digest, failures |
| \`cron_get\` | read one definition in full, including its prompt |
| \`cron_delete\` | remove a definition (history stays on disk) |
| \`cron_targets\` | where a finished run's digest can be delivered |

## Unattended rules the runs obey

- Permission prompts are **auto-denied** rather than waited on; the record lists
  what was denied, so tell the user when a job will need a wider policy.
- Each run has a hard timeout and writes a record plus a human digest next to
  the working directory.
- Runs never interact with the user. If the work needs a decision, the job
  must leave a report and let a human decide afterwards.

## Workflow

1. \`cron_list\` — pick a name that says what the job does, and check it is free.
2. \`cron_preview\` — confirm the expression and the timezone against the next
   fire times; show the user the description in their own words.
3. \`cron_create\` — a self-contained prompt, an explicit timezone, a sensible
   overlap policy and timeout.
4. \`cron_run\` once when the user wants proof it works (never in a loop).
5. Report the job name, when it will next fire, and what the digest will say.

## Common mistakes

- Creating a job for one-off work; creating it before the time was confirmed.
- A prompt that says "the file we discussed" — the run has no such context.
- Leaving the timezone implicit and getting a job that fires at the wrong hour.
- Choosing \`queue\` on a job whose runs can outlast their interval; \`skip\` is
  usually what the user means.
- Editing a job by deleting and recreating it, which loses the run anchors.
`

/**
 * Register the skill when a skill registry is mounted.
 * @param ctx - plugin context, possibly carrying `ctx.skills`.
 * @param onMissing - called with the reason when registration is unavailable.
 */
export function installCronSkill(ctx: Context, onMissing?: (reason: string) => void): void {
  const skills = optionalService<{ register(skill: SkillRegistration): () => void }>(ctx, 'skills')
  if (skills === undefined) {
    onMissing?.('no skill registry is mounted (ctx.skills); the tools still work')
    return
  }
  skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'runtime',
    provider: 'dsh-cron',
    content: SKILL_CONTENT,
  } satisfies SkillRegistration)
}
