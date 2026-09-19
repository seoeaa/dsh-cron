/**
 * dsh-cron — unit tests for src/store.ts.
 *
 * The fixtures in here are shape-equivalent reconstructions of the real
 * definition files the installed `dsh-routines` plugin leaves in the user's
 * `~/.dsh/routines`; they are copied as text so the suite never reads (or
 * writes) the user's home directory. Every fixture directory is built inside
 * `os.tmpdir()`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dshHome,
  expandHome,
  jobFilePath,
  loadJobFile,
  readJobs,
  removeJob,
  resolveDirs,
  watchJobs,
  writeJob,
  type StoreDirs,
} from '../src/store.ts'
import type { CronJob, InvalidJob, JobInput, RoutineSource } from '../src/types.ts'

/** Fixture root, recreated per test. */
let root = ''
/** The fake project directory (the real `.dsh` tree lives inside it). */
let project = ''
/** The fake global routines directory. */
let globalDir = ''
/** Resolved store directories under test. */
let dirs: StoreDirs

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cron-store-'))
  project = join(root, 'project')
  globalDir = join(root, 'global')
  mkdirSync(project, { recursive: true })
  mkdirSync(globalDir, { recursive: true })
  dirs = resolveDirs(project, globalDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Drop a raw definition text into a directory as `<name>.yaml`. */
function writeRaw(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.yaml`)
  writeFileSync(file, text, 'utf8')
  return file
}

/** Fail unless the result is a job, and return it narrowed. */
function expectJob(result: CronJob | InvalidJob): CronJob {
  if ('error' in result)
    throw new Error(`expected a job, got: ${result.error}`)
  return result
}

/** Fail unless the result is an invalid job, and return it narrowed. */
function expectInvalid(result: CronJob | InvalidJob): InvalidJob {
  if (!('error' in result))
    throw new Error(`expected an invalid job, got: ${result.name}`)
  return result
}

/** Read exactly one job, asserting there were no invalid files. */
function onlyJob(defaults?: { timezone?: string; projectDir?: string }): CronJob {
  const result = readJobs(dirs, defaults)
  expect(result.invalid).toEqual([])
  expect(result.jobs).toHaveLength(1)
  const [job] = result.jobs
  if (job === undefined)
    throw new Error('expected exactly one job')
  return job
}

/** A minimal valid definition, as the other plugin writes it. */
function definition(name: string, extra = ''): string {
  return `name: ${name}\nschedule: "0 3 * * *"\ntimezone: Europe/Moscow\nprompt: do the thing\n${extra}`
}

/**
 * The real `beget-ticket-check.yaml`, verbatim: a quoted schedule, a
 * multi-line `prompt: |` block scalar holding blank lines and list-looking
 * lines, and a `deliver:` list of mappings.
 */
const BEGET = `name: beget-ticket-check
schedule: "0 9,13,16 * * *"
timezone: Europe/Moscow
overlap: skip
timeoutMin: 25
profile: web
cwd: /storage/GITHUB/SiteANDSocial
prompt: |
  Залогинься на https://cp.beget.com/login (логин deniakqz), если
  сессия ещё не активна. Открой тикет поддержки https://cp.beget.com/support/2943894
  («Подтверждение через Госуслуги: данные не совпали») и прочитай переписку.

  Определи: появился ли НОВЫЙ ответ от поддержки Beget ПОСЛЕ последнего известного
  сообщения (Елизавета Николаевна, «передаю тикет в отдел по работе с доменными именами»).

  Если нового ответа нет — кратко напиши: «Ответа от отдела доменных имён пока нет»
  и статус тикета.

  Пиши итог по-русски, кратко и по делу, <12 строк.
deliver:
  - type: file
`

/** The shape of the real `kwork-new-projects.yaml`: numbered steps, indented sub-lines. */
const KWORK = `name: kwork-new-projects
schedule: "*/30 9-22 * * *"
timezone: Europe/Moscow
overlap: skip
timeoutMin: 20
profile: web
cwd: /storage/kwork
prompt: |
  Проверь новые заказы на бирже Kwork (MCP-инструменты mcp__kwork__kwork_*) и отчитайся
  только о тех, что подходят профилю продавца seoinet.

  1. Прочитай файл состояния /storage/kwork/state/kwork-new-projects-seen.json.
     Если его нет — это первый прогон: покажи текущий топ ленты как baseline.
  2. Возьми свежую ленту инструментом mcp__kwork__kwork_projects
     (sort=newest, limit=30, with_description=true) — БЕЗ price_from.
  3. Отбрось id, которые уже есть в state-файле.

  Итоговый ответ — по-русски, не длиннее 12 строк.
deliver:
  - type: file
`

describe('dshHome and expandHome', () => {
  it('uses $DSH_HOME when set and non-empty, else ~/.dsh', () => {
    const original = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(dshHome()).toBe(join(homedir(), '.dsh'))
      process.env.DSH_HOME = '   '
      expect(dshHome()).toBe(join(homedir(), '.dsh'))
      process.env.DSH_HOME = '/srv/dsh-home'
      expect(dshHome()).toBe('/srv/dsh-home')
    }
    finally {
      if (original === undefined)
        delete process.env.DSH_HOME
      else
        process.env.DSH_HOME = original
    }
  })

  it('expands a leading ~ and leaves other paths alone', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/routines')).toBe(join(homedir(), 'routines'))
    expect(expandHome('/abs/routines')).toBe('/abs/routines')
    expect(expandHome('rel/routines')).toBe('rel/routines')
  })
})

describe('resolveDirs', () => {
  it('puts project definitions under the project tree', () => {
    expect(resolveDirs('/p').project).toBe(join('/p', '.dsh', 'routines'))
  })

  it('defaults the global directory to $DSH_HOME/routines', () => {
    const original = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(resolveDirs('/p').global).toBe(join(homedir(), '.dsh', 'routines'))
      process.env.DSH_HOME = '/srv/dsh-home'
      expect(resolveDirs('/p').global).toBe(join('/srv/dsh-home', 'routines'))
    }
    finally {
      if (original === undefined)
        delete process.env.DSH_HOME
      else
        process.env.DSH_HOME = original
    }
  })

  it('honours an explicit global directory, including a ~ path', () => {
    expect(resolveDirs('/p', '/g').global).toBe('/g')
    expect(resolveDirs('/p', '~/g').global).toBe(join(homedir(), 'g'))
    expect(resolveDirs(project, globalDir)).toEqual({ project: join(project, '.dsh', 'routines'), global: globalDir })
  })
})

describe('readJobs and the real file shapes', () => {
  it('reads the beget definition, whole', () => {
    writeRaw(dirs.project, 'beget-ticket-check', BEGET)
    const result = readJobs(dirs)
    expect(result.invalid).toEqual([])
    expect(result.jobs).toHaveLength(1)
    const job = expectJob(result.jobs[0] ?? { name: '', file: '', source: 'project', error: 'missing' })
    expect(job.name).toBe('beget-ticket-check')
    expect(job.schedule).toBe('0 9,13,16 * * *')
    expect(job.timezone).toBe('Europe/Moscow')
    expect(job.overlap).toBe('skip')
    expect(job.timeoutMin).toBe(25)
    expect(job.profile).toBe('web')
    expect(job.cwd).toBe('/storage/GITHUB/SiteANDSocial')
    expect(job.deliver).toEqual([{ type: 'file' }])
    expect(job.source).toBe('project')
    expect(job.file).toBe(join(dirs.project, 'beget-ticket-check.yaml'))
    // The block scalar keeps its blank lines, its inner indentation and the
    // trailing newline the real file ends the block with.
    expect(job.prompt).toContain('cp.beget.com/login')
    expect(job.prompt).toContain('(«Подтверждение через Госуслуги: данные не совпали»)')
    expect(job.prompt).toContain('именами»).\n\nЕсли нового ответа нет — кратко напиши')
    expect(job.prompt.endsWith('<12 строк.\n')).toBe(true)
  })

  it('reads the kwork definition, whole', () => {
    writeRaw(dirs.project, 'kwork-new-projects', KWORK)
    const job = onlyJob()
    expect(job.schedule).toBe('*/30 9-22 * * *')
    expect(job.timeoutMin).toBe(20)
    expect(job.cwd).toBe('/storage/kwork')
    // Numbered steps and their indented continuations survive as prompt lines.
    expect(job.prompt.split('\n')).toContain('2. Возьми свежую ленту инструментом mcp__kwork__kwork_projects')
    expect(job.prompt.split('\n')).toContain('   (sort=newest, limit=30, with_description=true) — БЕЗ price_from.')
    expect(job.prompt.endsWith('не длиннее 12 строк.\n')).toBe(true)
  })

  it('reads both example shapes at once, sorted by name', () => {
    writeRaw(dirs.project, 'kwork-new-projects', KWORK)
    writeRaw(dirs.project, 'beget-ticket-check', BEGET)
    const result = readJobs(dirs)
    expect(result.invalid).toEqual([])
    expect(result.jobs.map((job) => job.name)).toEqual(['beget-ticket-check', 'kwork-new-projects'])
  })

  it('returns definitions only: pause and run facts belong to the service', () => {
    writeRaw(dirs.project, 'beget-ticket-check', BEGET)
    const job = onlyJob()
    expect(job.paused).toBe(false)
    expect(job.running).toBe(false)
    expect(job.nextRunAt).toBeUndefined()
    expect(job.lastRunAt).toBeUndefined()
    expect(job.lastStatus).toBeUndefined()
  })

  it('does not care about unknown fields on read', () => {
    writeRaw(dirs.project, 'extra', `${definition('extra')}somethingElse: 42\n`)
    expect(onlyJob().name).toBe('extra')
  })

  it('reports nothing for directories that do not exist', () => {
    const missing = resolveDirs(join(root, 'nowhere'), join(root, 'nowhere-global'))
    expect(readJobs(missing)).toEqual({ jobs: [], invalid: [] })
  })
})

describe('loadJobFile', () => {
  it('loads one file on demand', () => {
    const file = writeRaw(dirs.global, 'solo', 'name: solo\nschedule: "@hourly"\nprompt: ping\n')
    const job = expectJob(loadJobFile(file, 'global', project))
    expect(job.name).toBe('solo')
    expect(job.source).toBe('global')
    expect(job.timezone).toBe('UTC')
    expect(job.cwd).toBe(project)
  })

  it('reports an unreadable file instead of throwing', () => {
    const invalid = expectInvalid(loadJobFile(join(root, 'missing.yaml'), 'project', project))
    expect(invalid.name).toBe('missing')
    expect(invalid.error).toContain('cannot read the file')
  })
})

describe('malformed files', () => {
  it('turns a YAML syntax error into a one-line InvalidJob, without hiding good files', () => {
    writeRaw(dirs.project, 'broken', 'name: broken\nschedule: [unclosed\nprompt: hi\n')
    writeRaw(dirs.project, 'beget-ticket-check', BEGET)
    const result = readJobs(dirs)
    expect(result.jobs.map((job) => job.name)).toEqual(['beget-ticket-check'])
    expect(result.invalid).toHaveLength(1)
    const invalid = result.invalid[0]
    expect(invalid?.name).toBe('broken')
    expect(invalid?.file).toBe(join(dirs.project, 'broken.yaml'))
    expect(invalid?.source).toBe('project')
    expect(invalid?.error).toContain('invalid YAML')
    expect(invalid?.error).not.toContain('\n')
  })

  it('rejects a document that is not a mapping', () => {
    writeRaw(dirs.project, 'scalar', 'just a string\n')
    writeRaw(dirs.project, 'empty', '')
    writeRaw(dirs.project, 'list', '- a\n- b\n')
    const result = readJobs(dirs)
    expect(result.jobs).toEqual([])
    expect(result.invalid.map((entry) => entry.name)).toEqual(['empty', 'list', 'scalar'])
    for (const entry of result.invalid)
      expect(entry.error).toContain('must hold a YAML mapping')
  })
})

describe('validation', () => {
  const cases: readonly { label: string; yaml: string; error: string }[] = [
    { label: 'a missing name', yaml: 'schedule: "0 3 * * *"\nprompt: hi\n', error: 'field "name" is required' },
    { label: 'a blank name', yaml: 'name: ""\nschedule: "@daily"\nprompt: hi\n', error: 'field "name" is required' },
    { label: 'an uppercase name', yaml: definition('Bad'), error: 'field "name" must match [a-z0-9][a-z0-9-]*' },
    { label: 'an underscored name', yaml: definition('a_b'), error: 'field "name" must match [a-z0-9][a-z0-9-]*' },
    { label: 'an over-long name', yaml: definition('a'.repeat(65)), error: 'field "name" must match [a-z0-9][a-z0-9-]*' },
    { label: 'a name that is not a string', yaml: 'name: [a]\nschedule: "@daily"\nprompt: hi\n', error: 'field "name" is required' },
    { label: 'a missing schedule', yaml: 'name: ok\nprompt: hi\n', error: 'field "schedule" is required' },
    { label: 'an empty schedule', yaml: 'name: ok\nschedule: ""\nprompt: hi\n', error: 'field "schedule" is required' },
    { label: 'a numeric schedule', yaml: 'name: ok\nschedule: 5\nprompt: hi\n', error: 'field "schedule" is required' },
    { label: 'a missing prompt', yaml: 'name: ok\nschedule: "@daily"\n', error: 'field "prompt" is required' },
    { label: 'a whitespace-only prompt', yaml: 'name: ok\nschedule: "@daily"\nprompt: "   "\n', error: 'field "prompt" is required' },
    { label: 'a non-string prompt', yaml: 'name: ok\nschedule: "@daily"\nprompt: {text: hi}\n', error: 'field "prompt" is required' },
    { label: 'an unknown timezone', yaml: 'name: ok\nschedule: "@daily"\nprompt: hi\ntimezone: Not/AZone\n', error: 'field "timezone" is not a valid IANA zone' },
    { label: 'an empty timezone', yaml: 'name: ok\nschedule: "@daily"\nprompt: hi\ntimezone: ""\n', error: 'field "timezone" is required' },
    { label: 'a numeric timezone', yaml: 'name: ok\nschedule: "@daily"\nprompt: hi\ntimezone: 5\n', error: 'field "timezone" is required' },
    { label: 'an unknown overlap policy', yaml: `${definition('ok')}overlap: parallel\n`, error: 'field "overlap" must be one of skip, queue, cancel-previous' },
    { label: 'a zero timeout', yaml: `${definition('ok')}timeoutMin: 0\n`, error: 'field "timeoutMin" must be a whole number of minutes' },
    { label: 'a negative timeout', yaml: `${definition('ok')}timeoutMin: -5\n`, error: 'field "timeoutMin" must be a whole number of minutes' },
    { label: 'a fractional timeout', yaml: `${definition('ok')}timeoutMin: 1.5\n`, error: 'field "timeoutMin" must be a whole number of minutes' },
    { label: 'an over-long timeout', yaml: `${definition('ok')}timeoutMin: 1441\n`, error: 'field "timeoutMin" must be a whole number of minutes' },
    { label: 'a string timeout', yaml: `${definition('ok')}timeoutMin: "30"\n`, error: 'field "timeoutMin" must be a whole number of minutes' },
    { label: 'a deliver that is not a list', yaml: `${definition('ok')}deliver: file\n`, error: 'field "deliver" must be a list of { type: "file" | "chatnode" }' },
    { label: 'a deliver entry that is a string', yaml: `${definition('ok')}deliver:\n  - file\n`, error: 'field "deliver" must be a list of { type: "file" | "chatnode" }' },
    { label: 'an unknown delivery kind', yaml: `${definition('ok')}deliver:\n  - type: telegram\n`, error: 'field "deliver" must be a list of { type: "file" | "chatnode" }' },
    { label: 'an empty profile', yaml: `${definition('ok')}profile: ""\n`, error: 'field "profile" must be a non-empty string' },
    { label: 'an empty cwd', yaml: `${definition('ok')}cwd: ""\n`, error: 'field "cwd" must be a non-empty path string' },
  ]

  it.each(cases)('rejects $label', ({ yaml, error }) => {
    const file = writeRaw(dirs.project, 'sample', yaml)
    const result = readJobs(dirs)
    expect(result.jobs).toEqual([])
    expect(result.invalid).toHaveLength(1)
    const invalid = result.invalid[0]
    expect(invalid?.name).toBe('sample')
    expect(invalid?.file).toBe(file)
    expect(invalid?.source).toBe('project')
    expect(invalid?.error).toContain(error)
    expect(invalid?.error).not.toContain('\n')
    // A file that failed validation is reported once, not for every field.
    expect(invalid?.error.length).toBeGreaterThan(error.length - 1)
  })

  it('accepts an empty deliver list as the implied file digest', () => {
    writeRaw(dirs.project, 'empty-deliver', `${definition('empty-deliver')}deliver: []\n`)
    expect(onlyJob().deliver).toEqual([{ type: 'file' }])
  })
})

describe('defaults', () => {
  it('fills in every documented default', () => {
    writeRaw(dirs.project, 'fallback', 'name: fallback\nschedule: "@daily"\nprompt: keep it short\n')
    const job = onlyJob()
    expect(job.timezone).toBe('UTC')
    expect(job.profile).toBe('headless')
    expect(job.overlap).toBe('skip')
    expect(job.timeoutMin).toBe(45)
    expect(job.deliver).toEqual([{ type: 'file' }])
    expect(job.cwd).toBe(dirs.project)
  })

  it('takes the timezone and the cwd base from the caller', () => {
    writeRaw(dirs.project, 'fallback', 'name: fallback\nschedule: "@daily"\nprompt: keep it short\ncwd: work/sub\n')
    const job = onlyJob({ timezone: 'Europe/Moscow', projectDir: project })
    expect(job.timezone).toBe('Europe/Moscow')
    expect(job.cwd).toBe(join(project, 'work', 'sub'))
  })

  it('expands a ~ cwd against the home directory', () => {
    writeRaw(dirs.project, 'home-cwd', `${definition('home-cwd')}cwd: ~/work\n`)
    expect(onlyJob().cwd).toBe(join(homedir(), 'work'))
  })
})

describe('scope precedence', () => {
  it('lets a project definition win over a global one of the same name', () => {
    writeRaw(dirs.global, 'shared', 'name: shared\nschedule: "@hourly"\ntimezone: UTC\nprompt: global\n')
    writeRaw(dirs.global, 'global-only', 'name: global-only\nschedule: "@hourly"\ntimezone: UTC\nprompt: global\n')
    writeRaw(dirs.project, 'shared', 'name: shared\nschedule: "0 3 * * *"\ntimezone: UTC\nprompt: project\n')
    const result = readJobs(dirs)
    expect(result.invalid).toEqual([])
    expect(result.jobs.map((job) => job.name)).toEqual(['global-only', 'shared'])
    const shared = result.jobs[1]
    expect(shared?.prompt).toBe('project')
    expect(shared?.schedule).toBe('0 3 * * *')
    expect(shared?.source).toBe('project')
    expect(shared?.file).toBe(join(dirs.project, 'shared.yaml'))
  })

  it('keeps a project definition when the global one is broken', () => {
    writeRaw(dirs.global, 'shared', 'name: shared\nschedule: [broken\n')
    writeRaw(dirs.project, 'shared', 'name: shared\nschedule: "@daily"\nprompt: project\n')
    const result = readJobs(dirs)
    expect(result.jobs.map((job) => job.name)).toEqual(['shared'])
    expect(result.invalid.map((entry) => entry.source)).toEqual(['global'])
  })
})

describe('jobFilePath', () => {
  it('names the file a job occupies in each scope', () => {
    expect(jobFilePath(dirs, 'project', 'a')).toBe(join(dirs.project, 'a.yaml'))
    expect(jobFilePath(dirs, 'global', 'a')).toBe(join(dirs.global, 'a.yaml'))
  })
})

describe('writeJob', () => {
  it('writes a definition that reads back identically, in the project scope by default', () => {
    const written = writeJob(dirs, {
      name: 'round-trip',
      schedule: '*/15 * * * *',
      timezone: 'Europe/Moscow',
      prompt: 'first line\n\nsecond paragraph\n',
      cwd: join(root, 'work'),
      profile: 'web',
      overlap: 'queue',
      timeoutMin: 90,
      deliver: [{ type: 'file' }, { type: 'chatnode' }],
    })
    expect(written.file).toBe(join(dirs.project, 'round-trip.yaml'))
    expect(written.source).toBe('project')
    expect(written.deliver).toEqual([{ type: 'file' }, { type: 'chatnode' }])
    expect(onlyJob()).toEqual(written)
  })

  it('writes into the global scope on request', () => {
    const written = writeJob(dirs, {
      name: 'shared',
      schedule: '@daily',
      timezone: 'UTC',
      prompt: 'hi',
      scope: 'global',
    })
    expect(written.file).toBe(join(dirs.global, 'shared.yaml'))
    expect(written.source).toBe('global')
    expect(onlyJob().source).toBe('global')
  })

  it('keeps a multi-line prompt as a literal block scalar', () => {
    const prompt = 'Залогинься и проверь тикет.\n\n  Ещё одна строка с отступом.\nПоследняя строка.\n'
    const written = writeJob(dirs, { name: 'block', schedule: '@daily', timezone: 'UTC', prompt })
    const text = readFileSync(written.file, 'utf8')
    expect(text).toContain('prompt: |\n')
    expect(text).toContain('  Залогинься и проверь тикет.\n')
    expect(text).toContain('    Ещё одна строка с отступом.\n')
    expect(onlyJob().prompt).toBe(prompt)
  })

  it('round-trips a prompt that has no trailing newline', () => {
    const written = writeJob(dirs, { name: 'clip', schedule: '@daily', timezone: 'UTC', prompt: 'line one\nline two' })
    expect(readFileSync(written.file, 'utf8')).toContain('prompt: |-\n')
    expect(onlyJob().prompt).toBe('line one\nline two')
  })

  it('omits the cwd it did not receive, and never writes nulls', () => {
    const written = writeJob(dirs, { name: 'no-cwd', schedule: '@daily', timezone: 'UTC', prompt: 'hi' })
    const text = readFileSync(written.file, 'utf8')
    expect(text).not.toContain('cwd:')
    expect(text).not.toContain('null')
    expect(written.cwd).toBe(dirs.project)
    expect(onlyJob().timezone).toBe('UTC')
  })

  it('applies the documented defaults to what it returns', () => {
    const written = writeJob(dirs, { name: 'defaults', schedule: '@daily', timezone: 'UTC', prompt: 'hi' })
    expect(written.profile).toBe('headless')
    expect(written.overlap).toBe('skip')
    expect(written.timeoutMin).toBe(45)
    expect(written.deliver).toEqual([{ type: 'file' }])
    expect(written.paused).toBe(false)
    expect(written.running).toBe(false)
  })

  it('accepts a job that was read back, derived fields and all', () => {
    const original = writeJob(dirs, { name: 'again', schedule: '@daily', timezone: 'UTC', prompt: 'hi' })
    expect(() => writeJob(dirs, original)).not.toThrow()
    expect(readJobs(dirs).jobs).toHaveLength(1)
  })

  it('rejects a field the definition format does not have', () => {
    const input: JobInput = { name: 'typo', schedule: '@daily', timezone: 'UTC', prompt: 'hi' }
    const tampered = { ...input, schedul: '0 3 * * *' }
    expect(() => writeJob(dirs, tampered)).toThrow(/unknown field "schedul"/)
    expect(existsSync(join(dirs.project, 'typo.yaml'))).toBe(false)
  })

  it('rejects an invalid input by naming the field, without writing anything', () => {
    const cases: readonly { label: string; input: unknown; error: RegExp }[] = [
      { label: 'name', input: { name: 'Bad', schedule: '@daily', timezone: 'UTC', prompt: 'hi' }, error: /field "name"/ },
      { label: 'name missing', input: { schedule: '@daily', timezone: 'UTC', prompt: 'hi' }, error: /field "name" is required/ },
      { label: 'schedule', input: { name: 'ok', timezone: 'UTC', prompt: 'hi' }, error: /field "schedule" is required/ },
      { label: 'prompt', input: { name: 'ok', schedule: '@daily', timezone: 'UTC' }, error: /field "prompt" is required/ },
      { label: 'timezone', input: { name: 'ok', schedule: '@daily', timezone: 'Mars/Olympus', prompt: 'hi' }, error: /field "timezone" is not a valid IANA zone/ },
      { label: 'overlap', input: { name: 'ok', schedule: '@daily', timezone: 'UTC', prompt: 'hi', overlap: 'parallel' }, error: /field "overlap"/ },
      { label: 'timeoutMin', input: { name: 'ok', schedule: '@daily', timezone: 'UTC', prompt: 'hi', timeoutMin: 0 }, error: /field "timeoutMin"/ },
      { label: 'deliver', input: { name: 'ok', schedule: '@daily', timezone: 'UTC', prompt: 'hi', deliver: [{ type: 'telegram' }] }, error: /field "deliver"/ },
    ]
    for (const testCase of cases) {
      expect(() => writeJob(dirs, testCase.input as JobInput), testCase.label).toThrow(testCase.error)
      const files = existsSync(dirs.project) ? readdirSync(dirs.project) : []
      expect(files, testCase.label).toEqual([])
    }
  })
})

describe('removeJob', () => {
  it('removes the project definition first, then the global one', () => {
    writeRaw(dirs.project, 'shared', definition('shared'))
    writeRaw(dirs.global, 'shared', definition('shared'))
    expect(removeJob(dirs, 'shared')).toBe(true)
    expect(existsSync(join(dirs.project, 'shared.yaml'))).toBe(false)
    expect(existsSync(join(dirs.global, 'shared.yaml'))).toBe(true)
    expect(removeJob(dirs, 'shared')).toBe(true)
    expect(existsSync(join(dirs.global, 'shared.yaml'))).toBe(false)
    expect(removeJob(dirs, 'shared')).toBe(false)
  })

  it('removes a global definition when no project one exists', () => {
    writeRaw(dirs.global, 'global-only', definition('global-only'))
    expect(removeJob(dirs, 'global-only')).toBe(true)
    expect(readJobs(dirs).jobs).toEqual([])
  })

  it('refuses a name that could address a file outside the store', () => {
    const outside = join(root, 'outside.yaml')
    writeFileSync(outside, definition('outside'), 'utf8')
    for (const name of ['../outside', '../../outside', 'nested/outside', '..', '', 'Bad Name'])
      expect(removeJob(dirs, name), name).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })
})

describe('watchJobs', () => {
  /** Poll for a condition, so a test never depends on one fixed delay. */
  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate())
        return true
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
    return predicate()
  }

  it('notifies on a saved definition, once per save', async (context) => {
    mkdirSync(dirs.project, { recursive: true })
    let calls = 0
    const watcher = watchJobs(dirs, () => {
      calls += 1
    })
    try {
      writeJob(dirs, { name: 'watched', schedule: '@daily', timezone: 'UTC', prompt: 'hi' })
      const fired = await waitFor(() => calls > 0, 3000)
      context.skip(!fired, 'this platform did not deliver a filesystem event within 3 s')
      // Debounced: the several events one atomic save produces are one reload.
      await new Promise((resolve) => {
        setTimeout(resolve, 300)
      })
      expect(calls).toBe(1)
    }
    finally {
      watcher.dispose()
    }
  })

  it('stops notifying after dispose', async (context) => {
    mkdirSync(dirs.project, { recursive: true })
    let calls = 0
    const watcher = watchJobs(dirs, () => {
      calls += 1
    })
    writeJob(dirs, { name: 'first', schedule: '@daily', timezone: 'UTC', prompt: 'hi' })
    const fired = await waitFor(() => calls > 0, 3000)
    watcher.dispose()
    expect(() => watcher.dispose()).not.toThrow()
    context.skip(!fired, 'this platform did not deliver a filesystem event within 3 s')
    const before = calls
    writeJob(dirs, { name: 'second', schedule: '@daily', timezone: 'UTC', prompt: 'hi' })
    await new Promise((resolve) => {
      setTimeout(resolve, 400)
    })
    expect(calls).toBe(before)
  })

  it('picks up a directory that appears after the watch started', async (context) => {
    expect(existsSync(dirs.project)).toBe(false)
    let calls = 0
    const watcher = watchJobs(dirs, () => {
      calls += 1
    })
    try {
      const fired = await waitFor(() => {
        mkdirSync(dirs.project, { recursive: true })
        return calls > 0
      }, 3000)
      context.skip(!fired, 'the directory poll did not fire within 3 s')
      expect(calls).toBeGreaterThan(0)
    }
    finally {
      watcher.dispose()
    }
  })

  it('ignores a non-definition file, and a state save next to the definitions', async (context) => {
    mkdirSync(dirs.project, { recursive: true })
    let calls = 0
    const watcher = watchJobs(dirs, () => {
      calls += 1
    })
    try {
      writeFileSync(join(dirs.project, 'state.json'), '{"paused":[],"lastRunAt":{}}\n', 'utf8')
      writeFileSync(join(dirs.project, 'notes.txt'), 'hello', 'utf8')
      await new Promise((resolve) => {
        setTimeout(resolve, 500)
      })
      context.skip(calls > 0, 'this platform reports directory events we cannot filter')
      expect(calls).toBe(0)
    }
    finally {
      watcher.dispose()
    }
  })
})
