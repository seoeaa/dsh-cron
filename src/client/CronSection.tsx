/**
 * The dsh-cron settings section: engine banner, invalid-file diagnostics,
 * delivery targets, the jobs table (run/pause/resume/edit/history/copy/
 * delete) and the create/edit + history dialogs. The page renders exclusively
 * from `CronSnapshot`; every mutation reuses the refreshed snapshot the host
 * returns on the mutation response, so a successful action never re-fetches.
 *
 * @module dsh-cron/client/CronSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { StateDot, Toast, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { describeSchedule } from '../cron.ts'
import { encodeWire } from '../wire.ts'
import {
  formatAbsoluteTime,
  overlapLabelKey,
  relativeTime,
  runStatusLabelKey,
  runStatusTone,
  sourceLabelKey,
  truncatePath,
} from './present.ts'
import { JobEditor } from './JobEditor.tsx'
import { HistoryList } from './HistoryList.tsx'
import type {
  CronJob,
  CronSnapshot,
  JobInput,
  JobMutation,
  MutationResult,
  RunRecord,
  SchedulePreview,
} from '../types.ts'

/** Business face the settings page receives through the slot inject. */
export interface CronSectionInjected {
  /** Read the whole panel snapshot. */
  status: () => Promise<CronSnapshot>
  /** Apply one job mutation; the host returns the refreshed snapshot. */
  mutate: (requestJson: string) => Promise<MutationResult>
  /** Read one job's run records, newest first. */
  history: (name: string, limit?: number) => Promise<RunRecord[]>
  /** Validate one schedule expression (kept for face parity; the editor uses local math). */
  preview: (schedule: string, timezone?: string) => Promise<SchedulePreview>
}

/** Full component props assembled by the Settings slot renderer. */
export type CronSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.dshCron'>
  & InjectFace<CronSectionInjected>

/** Human-readable schedule, falling back to the raw expression on any error. */
function describeSafe(expr: string): string {
  try {
    return describeSchedule(expr)
  } catch {
    return expr
  }
}

interface EditorState {
  /** The job being edited; `null` means create mode. */
  job: CronJob | null
}

interface HistoryViewState {
  job: string
  loading: boolean
  error: string | null
  records: RunRecord[] | null
}

const EMPTY_HISTORY: HistoryViewState = { job: '', loading: false, error: null, records: null }

/**
 * Render the settings page. Data arrives through the injected Remote face;
 * the component owns only view state (dialogs, confirmations, busy flags).
 */
export function CronSection({ status, mutate, history, t }: CronSectionProps) {
  const [snapshot, setSnapshot] = useState<CronSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [request, setRequest] = useState(0)
  const hasData = useRef(false)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)

  const [historyJob, setHistoryJob] = useState<CronJob | null>(null)
  const [historyView, setHistoryView] = useState<HistoryViewState>(EMPTY_HISTORY)
  const historySeq = useRef(0)

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busyNames, setBusyNames] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  const showToast = useCallback((text: string): void => {
    setToast({ id: Date.now(), text })
  }, [])

  // Initial load and manual refresh. A refresh keeps the current table mounted
  // and flips a subtle "updating" flag; a failed refresh keeps the last good
  // snapshot and reports the failure, it never unmounts the page.
  useEffect(() => {
    let current = true
    if (hasData.current) setRefreshing(true)
    void status().then(
      (next) => {
        if (!current) return
        hasData.current = true
        setSnapshot(next)
        setLoadError(null)
        setRefreshError(null)
        setRefreshing(false)
      },
      (caught: unknown) => {
        if (!current) return
        setRefreshing(false)
        const message = caught instanceof Error ? caught.message : String(caught)
        if (hasData.current) setRefreshError(message)
        else setLoadError(message)
      },
    )
    return () => { current = false }
  }, [status, request])

  const nowMs = snapshot !== null && Number.isFinite(Date.parse(snapshot.now))
    ? Date.parse(snapshot.now)
    : Date.now()

  const restoreFocus = (): void => {
    const opener = openerRef.current
    openerRef.current = null
    if (opener !== null) {
      requestAnimationFrame(() => { opener.focus() })
    }
  }

  const rememberOpener = (): void => {
    const active = document.activeElement
    if (active instanceof HTMLElement) openerRef.current = active
  }

  /** Run one mutation; the host's refreshed snapshot replaces the current one. */
  const applyMutation = useCallback(async (
    mutation: JobMutation,
    options?: { busyName?: string; busyValue?: string },
  ): Promise<MutationResult | null> => {
    const busyName = options?.busyName
    const busyValue = options?.busyValue
    if (busyName !== undefined && busyValue !== undefined) {
      setBusyNames(current => ({ ...current, [busyName]: busyValue }))
    }
    try {
      const result = await mutate(encodeWire(mutation))
      if (result.snapshot !== undefined) setSnapshot(result.snapshot)
      showToast(result.ok ? t('mutationDone') : `${t('mutationFailed')} ${result.message}`)
      return result
    } catch (caught) {
      showToast(`${t('mutationFailed')} ${caught instanceof Error ? caught.message : String(caught)}`)
      return null
    } finally {
      if (busyName !== undefined) {
        setBusyNames(current => {
          const next = { ...current }
          delete next[busyName]
          return next
        })
      }
    }
  }, [mutate, showToast, t])

  const openCreate = (): void => {
    rememberOpener()
    setEditorError(null)
    setEditor({ job: null })
  }

  const openEdit = (job: CronJob): void => {
    rememberOpener()
    setEditorError(null)
    setEditor({ job })
  }

  const closeEditor = (): void => {
    setEditor(null)
    restoreFocus()
  }

  const handleSave = async (input: JobInput): Promise<void> => {
    setSaving(true)
    setEditorError(null)
    const result = await applyMutation({ action: 'save', job: input })
    setSaving(false)
    if (result === null) {
      setEditorError(t('mutationFailed'))
      return
    }
    if (result.ok) {
      setEditor(null)
      restoreFocus()
    } else {
      setEditorError(result.error ?? result.message)
    }
  }

  const openHistory = (job: CronJob): void => {
    rememberOpener()
    const seq = ++historySeq.current
    setHistoryJob(job)
    setHistoryView({ job: job.name, loading: true, error: null, records: null })
    void history(job.name, 100).then(
      (records) => {
        if (historySeq.current !== seq) return
        setHistoryView({ job: job.name, loading: false, error: null, records })
      },
      (caught: unknown) => {
        if (historySeq.current !== seq) return
        setHistoryView({
          job: job.name,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught),
          records: null,
        })
      },
    )
  }

  const closeHistory = (): void => {
    historySeq.current += 1
    setHistoryJob(null)
    restoreFocus()
  }

  const runNow = (job: CronJob): void => {
    void applyMutation({ action: 'run', name: job.name }, { busyName: job.name, busyValue: 'run' })
  }

  const togglePause = (job: CronJob): void => {
    const paused = job.paused || snapshot?.paused.includes(job.name) === true
    void applyMutation(
      { action: paused ? 'resume' : 'pause', name: job.name },
      { busyName: job.name, busyValue: paused ? 'resume' : 'pause' },
    )
  }

  const removeJob = (name: string): void => {
    void applyMutation({ action: 'remove', name }, { busyName: name, busyValue: 'delete' }).then((result) => {
      if (result !== null && result.ok) setConfirmDelete(null)
    })
  }

  const copyPrompt = async (job: CronJob): Promise<void> => {
    const ok = await writeClipboard(job.prompt)
    showToast(ok ? t('copyPromptOk') : t('copyPromptFailed'))
  }

  const relativeText = (ms: number): string => {
    const rel = relativeTime(ms, nowMs)
    if (rel.direction === 'now') return t('relNow')
    return rel.direction === 'in' ? t('relIn', { time: rel.time }) : t('relAgo', { time: rel.time })
  }

  return (
    <div className="dc-root" data-dsh-cron="" aria-busy={refreshing || snapshot === null}>
      <div className="dc-toolbar">
        <h2 className="dc-title">{t('nav')}</h2>
        {snapshot !== null ? <span className="dc-muted">{snapshot.plugin} {snapshot.version}</span> : null}
        <span className="dc-spacer" />
        <button type="button" className="dc-action" onClick={() => { setRequest(value => value + 1) }} disabled={refreshing}>
          {refreshing ? t('refreshing') : t('refresh')}
        </button>
        <button type="button" className="dc-action" onClick={openCreate}>{t('newJob')}</button>
      </div>

      {loadError !== null ? (
        <div className="dc-error" role="alert">
          <p>{t('error')}</p>
          <p className="dc-error-detail">{loadError}</p>
          <button type="button" className="dc-action" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button>
        </div>
      ) : null}

      {snapshot === null && loadError === null ? <p className="dc-subtle" role="status">{t('loading')}</p> : null}

      {snapshot !== null ? (
        <>
          {snapshot.engine.mode === 'companion' ? (
            <div className="dc-banner" data-tone="companion">
              <p className="dc-banner-title">
                {snapshot.engine.owner !== undefined && snapshot.engine.owner !== ''
                  ? t('engineCompanion', { owner: snapshot.engine.owner })
                  : t('engineCompanionUnknown')}
              </p>
              {snapshot.engine.reason !== undefined && snapshot.engine.reason !== '' ? (
                <p className="dc-banner-detail">{snapshot.engine.reason}</p>
              ) : null}
              <p className="dc-banner-detail">{t('engineCompanionEdit')}</p>
            </div>
          ) : (
            <p className="dc-subtle">{t('engineOwn')}</p>
          )}

          {refreshError !== null ? (
            <p className="dc-updating" role="status">{t('updateFailed')} <span className="dc-mono">{refreshError}</span></p>
          ) : null}

          {snapshot.invalid.length > 0 ? (
            <section className="dc-invalid" aria-label={t('invalidTitle')}>
              <h3 className="dc-invalid-title">{t('invalidTitle')}</h3>
              <p className="dc-subtle">{t('invalidHint')}</p>
              <ul className="dc-invalid-list">
                {snapshot.invalid.map(item => (
                  <li key={item.file}>
                    <span className="dc-invalid-path">{item.file}</span>
                    <span className="dc-invalid-text">{item.error}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="dc-targets" aria-label={t('targetsTitle')}>
            <p className="dc-targets-title">{t('targetsTitle')}</p>
            <ul className="dc-targets-list">
              <li>{t('targetsFileHint')}</li>
              {snapshot.targets
                .filter(target => target.kind !== 'file')
                .map(target => (
                  <li key={target.id}>
                    {target.label}{target.note !== undefined && target.note !== '' ? ` — ${target.note}` : ''}
                  </li>
                ))}
            </ul>
          </section>

          <h3 className="dc-title">{t('jobsTitle')}</h3>

          <div className="dc-table-wrap">
            {refreshing ? <p className="dc-updating" role="status">{t('refreshing')}</p> : null}
            <table className="dc-table">
              <thead>
                <tr>
                  <th scope="col">{t('colName')}</th>
                  <th scope="col">{t('colSchedule')}</th>
                  <th scope="col">{t('colTimezone')}</th>
                  <th scope="col">{t('colNext')}</th>
                  <th scope="col">{t('colLast')}</th>
                  <th scope="col">{t('colSource')}</th>
                  <th scope="col">{t('colOverlap')}</th>
                  <th scope="col">{t('colCwd')}</th>
                  <th scope="col">{t('colProfile')}</th>
                  <th scope="col">{t('colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.jobs.length === 0 ? (
                  <tr>
                    <td colSpan={10}>
                      <div className="dc-empty">
                        <p>{t('empty')}</p>
                        <p>{t('emptyHint')}</p>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {snapshot.jobs.map(job => {
                  const running = job.running || snapshot.running.includes(job.name)
                  const paused = job.paused || snapshot.paused.includes(job.name)
                  const busyValue = busyNames[job.name]
                  const nextMs = job.nextRunAt !== undefined ? Date.parse(job.nextRunAt) : Number.NaN
                  const lastMs = job.lastRunAt !== undefined ? Date.parse(job.lastRunAt) : Number.NaN
                  return (
                    <JobRows
                      key={job.name}
                      job={job}
                      running={running}
                      paused={paused}
                      nowMs={nowMs}
                      busyValue={busyValue}
                      confirmingDelete={confirmDelete === job.name}
                      t={t}
                      describeSafe={describeSafe}
                      relativeText={relativeText}
                      onRun={() => { runNow(job) }}
                      onTogglePause={() => { togglePause(job) }}
                      onEdit={() => { openEdit(job) }}
                      onHistory={() => { openHistory(job) }}
                      onCopyPrompt={() => { void copyPrompt(job) }}
                      onAskDelete={() => { setConfirmDelete(job.name) }}
                      onCancelDelete={() => { setConfirmDelete(null) }}
                      onConfirmDelete={() => { removeJob(job.name) }}
                      nextMs={nextMs}
                      lastMs={lastMs}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {editor !== null ? (
        <JobEditor
          job={editor.job}
          snapshot={snapshot ?? EMPTY_SNAPSHOT}
          busy={saving}
          error={editorError}
          t={t}
          onClose={closeEditor}
          onSave={(input) => { void handleSave(input) }}
        />
      ) : null}

      {historyJob !== null ? (
        <HistoryList
          jobName={historyJob.name}
          nowMs={nowMs}
          loading={historyView.loading}
          error={historyView.error}
          records={historyView.records}
          t={t}
          onClose={closeHistory}
        />
      ) : null}

      {toast !== null ? (
        <Toast
          key={toast.id}
          text={toast.text}
          holdMs={3200}
          onDone={() => { setToast(current => (current?.id === toast.id ? null : current)) }}
        />
      ) : null}
    </div>
  )
}

interface JobRowsProps {
  job: CronJob
  running: boolean
  paused: boolean
  nowMs: number
  nextMs: number
  lastMs: number
  busyValue: string | undefined
  confirmingDelete: boolean
  t: TranslateNS<'settings.dshCron'>
  describeSafe: (expr: string) => string
  relativeText: (ms: number) => string
  onRun: () => void
  onTogglePause: () => void
  onEdit: () => void
  onHistory: () => void
  onCopyPrompt: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

/** One job row plus its inline delete-confirmation row. */
function JobRows({
  job, running, paused, nowMs, nextMs, lastMs, busyValue, confirmingDelete, t,
  describeSafe, relativeText,
  onRun, onTogglePause, onEdit, onHistory, onCopyPrompt, onAskDelete, onCancelDelete, onConfirmDelete,
}: JobRowsProps) {
  const actionsDisabled = busyValue !== undefined
  const lastStatus = job.lastStatus
  const lastTooltip = Number.isFinite(lastMs)
    ? `${formatAbsoluteTime(lastMs)}${job.lastError !== undefined && job.lastError !== '' ? ` — ${job.lastError}` : ''}`
    : undefined

  return (
    <>
      <tr data-running={running ? 'true' : undefined}>
        <td>
          <span className="dc-name">{job.name}</span>{' '}
          {paused ? <span className="dc-badge" data-tone="warn">{t('pausedBadge')}</span> : null}{' '}
          {running ? <span className="dc-badge" data-tone="ongoing">{t('runningBadge')}</span> : null}
        </td>
        <td>
          <span>{describeSafe(job.schedule)}</span>
          <span className="dc-schedule-raw dc-mono">{job.schedule}</span>
        </td>
        <td><span className="dc-mono">{job.timezone}</span></td>
        <td>
          {Number.isFinite(nextMs) ? (
            <Tooltip label={formatAbsoluteTime(nextMs)}>
              <span className="dc-state">{relativeText(nextMs)}</span>
            </Tooltip>
          ) : (
            <span className="dc-muted">{t('none')}</span>
          )}
        </td>
        <td>
          {Number.isFinite(lastMs) && lastStatus !== undefined ? (
            <Tooltip label={lastTooltip ?? formatAbsoluteTime(lastMs)}>
              <span className="dc-state">
                <StateDot state={runStatusTone(lastStatus)} />
                <span>{t(runStatusLabelKey(lastStatus))}</span>
                <span className="dc-muted">{relativeText(lastMs)}</span>
              </span>
            </Tooltip>
          ) : (
            <span className="dc-muted">{t('none')}</span>
          )}
        </td>
        <td>{t(sourceLabelKey(job.source))}</td>
        <td>{t(overlapLabelKey(job.overlap))}</td>
        <td>
          <Tooltip label={job.cwd} maxWidth={560}>
            <span className="dc-truncate">{truncatePath(job.cwd)}</span>
          </Tooltip>
        </td>
        <td>{job.profile}</td>
        <td>
          <div className="dc-actions" role="group" aria-label={t('jobActionsLabel', { name: job.name })}>
            <button type="button" className="dc-action" onClick={onRun} disabled={actionsDisabled || running}>
              {busyValue === 'run' ? t('refreshing') : t('actionRun')}
            </button>
            <button type="button" className="dc-action" onClick={onTogglePause} disabled={actionsDisabled || running}>
              {paused ? t('actionResume') : t('actionPause')}
            </button>
            <button type="button" className="dc-action" onClick={onEdit} disabled={actionsDisabled}>
              {t('actionEdit')}
            </button>
            <button type="button" className="dc-action" onClick={onHistory} disabled={actionsDisabled}>
              {t('actionHistory')}
            </button>
            <button type="button" className="dc-action" onClick={onCopyPrompt}>{t('actionCopyPrompt')}</button>
            <button type="button" className="dc-action" data-tone="danger" onClick={onAskDelete} disabled={actionsDisabled}>
              {t('actionDelete')}
            </button>
          </div>
        </td>
      </tr>
      {confirmingDelete ? (
        <tr>
          <td colSpan={10}>
            <div className="dc-confirm" role="alertdialog" aria-label={t('confirmDelete', { name: job.name })}>
              <p className="dc-confirm-text">{t('confirmDelete', { name: job.name })}</p>
              <p className="dc-subtle">{t('confirmDeleteHint')}</p>
              <div className="dc-actions">
                <button type="button" className="dc-action" data-tone="danger" onClick={onConfirmDelete} disabled={busyValue === 'delete'}>
                  {busyValue === 'delete' ? t('refreshing') : t('actionDelete')}
                </button>
                <button type="button" className="dc-action" onClick={onCancelDelete}>{t('cancel')}</button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

/** Fallback snapshot so the editor stays typed even before the first load. */
const EMPTY_SNAPSHOT: CronSnapshot = {
  jobs: [],
  invalid: [],
  engine: { mode: 'own' },
  dirs: { project: '', global: '' },
  running: [],
  paused: [],
  targets: [],
  now: new Date(0).toISOString(),
  plugin: 'dsh-cron',
  version: '',
}
