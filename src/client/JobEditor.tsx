/**
 * The create/edit job dialog. All copy goes through the `settings.dshCron`
 * locale namespace; schedule feedback is computed instantly from `../cron.ts`
 * (no Remote round trip per keystroke) and a parse error is always shown as
 * the error text — never a crash, never a silent empty state.
 *
 * The component is mounted only while the dialog is open, so form state is
 * initialized from `job`/`snapshot` exactly once per open.
 *
 * @module dsh-cron/client/JobEditor
 */

import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { describeSchedule, nextRuns } from '../cron.ts'
import { validateJobName } from './present.ts'
import type { CronJob, CronSnapshot, Delivery, DeliveryKind, JobInput, OverlapPolicy, RoutineSource } from '../types.ts'

/** Schedule templates shown in the picker; `custom` means the raw field rules. */
const PRESETS: Readonly<Record<string, string | undefined>> = {
  every15: '*/15 * * * *',
  hourly: '0 * * * *',
  daily0900: '0 9 * * *',
  weekdays0830: '30 8 * * 1-5',
  weekly: '0 0 * * 0',
  monthly: '0 0 1 * *',
  custom: undefined,
}

/** Resolve the template id for an already-known expression, else `custom`. */
function presetFor(expr: string): string {
  const trimmed = expr.trim()
  for (const [id, value] of Object.entries(PRESETS)) {
    if (id !== 'custom' && value === trimmed) return id
  }
  return 'custom'
}

export interface JobEditorProps {
  job: CronJob | null
  snapshot: CronSnapshot
  busy: boolean
  /** Save failure text from the host; shown inside the dialog. */
  error: string | null
  t: TranslateNS<'settings.dshCron'>
  onClose: () => void
  onSave: (input: JobInput) => void
}

/**
 * Render the create/edit dialog. Mounted only while open (the parent
 * unmounts on close, which is what returns focus to the opener).
 */
export function JobEditor({ job, snapshot, busy, error, t, onClose, onSave }: JobEditorProps) {
  const [name, setName] = useState(job?.name ?? '')
  const [schedule, setSchedule] = useState(job?.schedule ?? '')
  const [preset, setPreset] = useState(() => presetFor(job?.schedule ?? ''))
  const [timezone, setTimezone] = useState(job?.timezone ?? 'UTC')
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [cwd, setCwd] = useState(job?.cwd ?? '')
  const [profile, setProfile] = useState(job?.profile ?? 'headless')
  const [overlap, setOverlap] = useState<OverlapPolicy>(job?.overlap ?? 'skip')
  const [timeoutMin, setTimeoutMin] = useState(String(job?.timeoutMin ?? 45))
  const [deliver, setDeliver] = useState<Delivery[]>(job?.deliver ?? [{ type: 'file' }])
  const [scope, setScope] = useState<RoutineSource>(job?.source ?? 'project')

  // Instant, local schedule feedback. `describeSchedule`/`nextRuns` throw on
  // an invalid expression; the catch turns that into the visible parse error.
  const preview = useMemo(() => {
    const expr = schedule.trim()
    if (expr === '') {
      return { ok: false as const, description: null as string | null, error: null as string | null, next: [] as Date[] }
    }
    try {
      const description = describeSchedule(expr)
      const next = nextRuns(expr, timezone.trim() === '' ? 'UTC' : timezone.trim(), new Date(), 3)
      return { ok: true as const, description, error: null as string | null, next }
    } catch (caught) {
      return {
        ok: false as const,
        description: null as string | null,
        error: caught instanceof Error ? caught.message : String(caught),
        next: [] as Date[],
      }
    }
  }, [schedule, timezone])

  const nameError = validateJobName(name)
  const timezoneError = timezone.trim() === '' ? 'empty' : null
  const promptError = prompt.trim() === '' ? 'empty' : null
  const timeoutNumber = timeoutMin.trim() === '' ? undefined : Number(timeoutMin)
  const timeoutError = timeoutMin.trim() !== '' && (timeoutNumber === undefined || !Number.isFinite(timeoutNumber) || timeoutNumber < 1) ? 'invalid' : null
  const scheduleError = schedule.trim() === '' ? 'empty' : preview.ok ? null : 'invalid'
  const canSave = !busy && nameError === null && scheduleError === null && timezoneError === null && promptError === null && timeoutError === null

  const fileTarget = snapshot.targets.find(target => target.kind === 'file')
  const chatTarget = snapshot.targets.find(target => target.kind === 'chatnode')
  const fileAvailable = fileTarget?.available ?? true
  const chatAvailable = chatTarget?.available ?? false

  const toggleDelivery = (kind: DeliveryKind): void => {
    setDeliver(current => {
      const has = current.some(item => item.type === kind)
      return has ? current.filter(item => item.type !== kind) : [...current, { type: kind }]
    })
  }

  const handleScheduleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const value = event.currentTarget.value
    setSchedule(value)
    setPreset(presetFor(value))
  }

  const handlePresetChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const value = event.currentTarget.value
    setPreset(value)
    const expr = PRESETS[value]
    if (expr !== undefined) setSchedule(expr)
  }

  const handleSave = (): void => {
    if (!canSave) return
    onSave({
      name: name.trim(),
      schedule: schedule.trim(),
      timezone: timezone.trim(),
      prompt,
      cwd: cwd.trim() === '' ? undefined : cwd.trim(),
      profile: profile.trim() === '' ? undefined : profile.trim(),
      overlap,
      timeoutMin: timeoutNumber,
      deliver,
      scope,
    })
  }

  const title = job === null ? t('editorTitleCreate') : t('editorTitleEdit', { name: job.name })

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('editorClose')}
      footer={
        <div className="dc-modal-footer">
          <button type="button" className="dc-action" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="button" className="dc-action" onClick={handleSave} disabled={!canSave}>
            {busy ? t('savingJob') : t('saveJob')}
          </button>
        </div>
      }
    >
      <div data-dsh-cron="">
        <div className="dc-editor">
          {error !== null ? <p className="dc-field-error" role="alert">{error}</p> : null}

          <label className="dc-field">
            <span className="dc-field-label">{t('fieldName')}</span>
            <input
              type="text"
              value={name}
              autoFocus
              spellCheck={false}
              aria-invalid={nameError !== null}
              onChange={(event) => { setName(event.currentTarget.value) }}
            />
            <span className="dc-hint">{t('fieldNameHint')}</span>
            {nameError === 'pattern' ? <span className="dc-field-error" role="alert">{t('errorNamePattern')}</span> : null}
            {nameError === 'length' ? <span className="dc-field-error" role="alert">{t('errorNameLength')}</span> : null}
          </label>

          <label className="dc-field">
            <span className="dc-field-label">{t('fieldSchedule')}</span>
            <select value={preset} aria-label={t('schedulePreset')} onChange={handlePresetChange}>
              <option value="every15">{t('presetEvery15')}</option>
              <option value="hourly">{t('presetHourly')}</option>
              <option value="daily0900">{t('presetDaily0900')}</option>
              <option value="weekdays0830">{t('presetWeekdays0830')}</option>
              <option value="weekly">{t('presetWeekly')}</option>
              <option value="monthly">{t('presetMonthly')}</option>
              <option value="custom">{t('presetCustom')}</option>
            </select>
            <input
              type="text"
              value={schedule}
              spellCheck={false}
              aria-invalid={scheduleError !== null}
              onChange={handleScheduleChange}
            />
            {scheduleError === 'empty' ? <span className="dc-field-error" role="alert">{t('errorScheduleEmpty')}</span> : null}
          </label>

          <div className="dc-preview" aria-live="polite">
            <p className="dc-preview-desc">{t('scheduleLive')}</p>
            {preview.ok && preview.description !== null ? (
              <>
                <p className="dc-preview-desc">{preview.description}</p>
                <p className="dc-subtle">{t('scheduleNext')}</p>
                <ul className="dc-preview-next">
                  {preview.next.map((date) => (
                    <li key={date.getTime()}>{date.toLocaleString()}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {!preview.ok && schedule.trim() !== '' ? (
              <>
                <p className="dc-preview-error">{t('scheduleInvalid')}</p>
                {preview.error !== null ? <p className="dc-preview-error">{preview.error}</p> : null}
              </>
            ) : null}
          </div>

          <label className="dc-field">
            <span className="dc-field-label">{t('fieldTimezone')}</span>
            <input
              type="text"
              value={timezone}
              spellCheck={false}
              list="dsh-cron-timezones"
              aria-invalid={timezoneError !== null}
              onChange={(event) => { setTimezone(event.currentTarget.value) }}
            />
            <datalist id="dsh-cron-timezones">
              <option value="UTC" />
              <option value="Europe/Moscow" />
              <option value="Europe/London" />
              <option value="Europe/Berlin" />
              <option value="Asia/Dubai" />
              <option value="Asia/Shanghai" />
              <option value="Asia/Tokyo" />
              <option value="America/New_York" />
            </datalist>
            <span className="dc-hint">{t('timezoneHint')}</span>
            {timezoneError !== null ? <span className="dc-field-error" role="alert">{t('errorTimezoneEmpty')}</span> : null}
          </label>

          <label className="dc-field">
            <span className="dc-field-label">{t('fieldPrompt')}</span>
            <textarea
              value={prompt}
              aria-invalid={promptError !== null}
              onChange={(event) => { setPrompt(event.currentTarget.value) }}
            />
            {promptError !== null ? <span className="dc-field-error" role="alert">{t('errorPromptEmpty')}</span> : null}
          </label>

          <label className="dc-field">
            <span className="dc-field-label">{t('fieldCwd')}</span>
            <input
              type="text"
              value={cwd}
              spellCheck={false}
              placeholder={snapshot.dirs.project}
              onChange={(event) => { setCwd(event.currentTarget.value) }}
            />
            <span className="dc-hint">{t('cwdHint')}</span>
          </label>

          <div className="dc-field">
            <span className="dc-field-label">{t('fieldProfile')}</span>
            <input
              type="text"
              value={profile}
              spellCheck={false}
              onChange={(event) => { setProfile(event.currentTarget.value) }}
            />
          </div>

          <div className="dc-field">
            <span className="dc-field-label">{t('fieldOverlap')}</span>
            <select value={overlap} onChange={(event) => { setOverlap(event.currentTarget.value as OverlapPolicy) }}>
              <option value="skip">{t('overlapSkip')}</option>
              <option value="queue">{t('overlapQueue')}</option>
              <option value="cancel-previous">{t('overlapCancel')}</option>
            </select>
          </div>

          <label className="dc-field">
            <span className="dc-field-label">{t('fieldTimeoutMin')}</span>
            <input
              type="number"
              min={1}
              value={timeoutMin}
              aria-invalid={timeoutError !== null}
              onChange={(event) => { setTimeoutMin(event.currentTarget.value) }}
            />
            {timeoutError !== null ? <span className="dc-field-error" role="alert">{t('errorTimeoutInvalid')}</span> : null}
          </label>

          <div className="dc-field">
            <span className="dc-field-label">{t('fieldDeliver')}</span>
            <label className="dc-check">
              <input
                type="checkbox"
                checked={deliver.some(item => item.type === 'file')}
                disabled={!fileAvailable}
                onChange={() => { toggleDelivery('file') }}
              />
              <span>{t('deliverFile')}</span>
              {fileTarget?.note !== undefined && fileTarget.note !== '' ? <span className="dc-check-note">{fileTarget.note}</span> : null}
            </label>
            <label className="dc-check">
              <input
                type="checkbox"
                checked={deliver.some(item => item.type === 'chatnode')}
                disabled={!chatAvailable}
                onChange={() => { toggleDelivery('chatnode') }}
              />
              <span>{t('deliverChatnode')}</span>
              {!chatAvailable ? (
                <span className="dc-check-note">
                  {t('targetUnavailable')}
                  {chatTarget?.note !== undefined && chatTarget.note !== '' ? ` — ${chatTarget.note}` : ''}
                </span>
              ) : chatTarget?.note !== undefined && chatTarget.note !== '' ? (
                <span className="dc-check-note">{chatTarget.note}</span>
              ) : null}
            </label>
          </div>

          <div className="dc-field">
            <span className="dc-field-label">{t('fieldScope')}</span>
            <select value={scope} onChange={(event) => { setScope(event.currentTarget.value as RoutineSource) }}>
              <option value="project">{t('sourceProject')}</option>
              <option value="global">{t('sourceGlobal')}</option>
            </select>
          </div>
        </div>
      </div>
    </Modal>
  )
}
