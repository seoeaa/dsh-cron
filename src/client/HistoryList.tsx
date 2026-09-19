/**
 * The run-history dialog for one job. Reads nothing itself — the parent owns
 * the Remote call — and renders records grouped by local calendar day, with
 * status tone, timestamps, duration, session id, a collapsible digest,
 * denied approvals, delivery results and the failure text.
 *
 * @module dsh-cron/client/HistoryList
 */

import { useState } from 'react'
import { Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  dayLabelKey,
  formatAbsoluteTime,
  formatDayDate,
  formatDuration,
  groupRunsByDay,
  relativeTime,
  runStatusLabelKey,
  runStatusTone,
} from './present.ts'
import type { RunRecord } from '../types.ts'

/** Digest length above which the text collapses behind a toggle. */
const DIGEST_COLLAPSE_AT = 400

export interface HistoryListProps {
  jobName: string
  /** Clock reference (the snapshot's `now`) for relative timestamps. */
  nowMs: number
  loading: boolean
  error: string | null
  records: RunRecord[] | null
  t: TranslateNS<'settings.dshCron'>
  onClose: () => void
}

/**
 * Render the history dialog. Mounted only while open; `Modal` supplies the
 * portal, mask, Escape handling and the accessible close button.
 */
export function HistoryList({ jobName, nowMs, loading, error, records, t, onClose }: HistoryListProps) {
  const [expanded, setExpanded] = useState<Record<string, true>>({})
  const groups = records !== null && records.length > 0 ? groupRunsByDay(records) : null

  const relativeLabel = (ms: number): string => {
    const rel = relativeTime(ms, nowMs)
    if (rel.direction === 'now') return t('relNow')
    return rel.direction === 'in' ? t('relIn', { time: rel.time }) : t('relAgo', { time: rel.time })
  }

  const dayLabel = (startOfDayMs: number): string => {
    const key = dayLabelKey(startOfDayMs, nowMs)
    if (key === 'today') return t('dayToday')
    if (key === 'yesterday') return t('dayYesterday')
    return formatDayDate(startOfDayMs)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('historyTitle', { name: jobName })}
      closeLabel={t('historyClose')}
    >
      <div data-dsh-cron="">
        <div className="dc-history">
          {loading ? <p className="dc-subtle">{t('historyLoading')}</p> : null}
          {!loading && error !== null ? (
            <div className="dc-error" role="alert">
              <p className="dc-error-detail">{t('historyError')}</p>
              <p className="dc-error-detail">{error}</p>
            </div>
          ) : null}
          {!loading && error === null && groups === null ? (
            <p className="dc-subtle">{t('historyNoRuns')}</p>
          ) : null}
          {groups !== null
            ? groups.map(group => (
              <section className="dc-history-group" key={group.key}>
                <h3 className="dc-history-day">{dayLabel(group.startOfDayMs)}</h3>
                {group.runs.map(record => (
                  <RunCard
                    key={record.runId}
                    record={record}
                    expanded={expanded[record.runId] === true}
                    onToggleDigest={() => {
                      setExpanded(current => {
                        const next = { ...current }
                        if (next[record.runId] === true) delete next[record.runId]
                        else next[record.runId] = true
                        return next
                      })
                    }}
                    relativeLabel={relativeLabel}
                    t={t}
                  />
                ))}
              </section>
            ))
            : null}
        </div>
      </div>
    </Modal>
  )
}

interface RunCardProps {
  record: RunRecord
  expanded: boolean
  onToggleDigest: () => void
  relativeLabel: (ms: number) => string
  t: TranslateNS<'settings.dshCron'>
}

/** One run record card. */
function RunCard({ record, expanded, onToggleDigest, relativeLabel, t }: RunCardProps) {
  const tone = runStatusTone(record.status)
  const statusText = t(runStatusLabelKey(record.status))
  const duration = formatDuration(record.durationMs)
  const digestLong = (record.digest?.length ?? 0) > DIGEST_COLLAPSE_AT
  const collapsed = digestLong && !expanded
  const failed = record.status !== 'completed' && record.status !== 'running'
  const digestId = `dsh-cron-digest-${record.runId}`

  return (
    <article className="dc-history-card">
      <div className="dc-history-meta">
        <span className="dc-state">
          <StateDot state={tone} />
          <span>{statusText}</span>
        </span>
        <span>{t('historyRunAt')}: {formatAbsoluteTime(record.startedAt)}</span>
        <span>{relativeLabel(record.startedAt)}</span>
        {duration !== null ? <span>{t('historyDuration')}: {duration}</span> : null}
      </div>
      {record.sessionId !== undefined && record.sessionId !== '' ? (
        <p className="dc-subtle">{t('historySession')}: <span className="dc-mono">{record.sessionId}</span></p>
      ) : null}

      {record.digest !== undefined && record.digest !== '' ? (
        <div className="dc-history-section">
          <p className="dc-history-section-title">{t('historyDigest')}</p>
          <p className="dc-digest" data-collapsed={collapsed ? 'true' : undefined} id={digestId}>{record.digest}</p>
          {digestLong ? (
            <button type="button" className="dc-action" aria-expanded={!collapsed} aria-controls={digestId} onClick={onToggleDigest}>
              {collapsed ? t('historyShowMore') : t('historyShowLess')}
            </button>
          ) : null}
        </div>
      ) : null}

      {record.denied !== undefined && record.denied.length > 0 ? (
        <div className="dc-history-section">
          <p className="dc-history-section-title">{t('historyDenied')}</p>
          <ul className="dc-detail-list">
            {record.denied.map((denied, index) => (
              <li key={`${denied.toolName}-${index}`}>
                <span className="dc-mono">{denied.toolName}</span>
                {denied.reason !== undefined && denied.reason !== '' ? ` — ${denied.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {record.deliveries !== undefined && record.deliveries.length > 0 ? (
        <div className="dc-history-section">
          <p className="dc-history-section-title">{t('historyDeliveries')}</p>
          <ul className="dc-detail-list">
            {record.deliveries.map((delivery, index) => (
              <li key={`${delivery.type}-${index}`}>
                {delivery.type}: {delivery.ok ? t('deliveryOk') : t('deliveryFailed')}
                {delivery.error !== undefined && delivery.error !== '' ? ` — ${delivery.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failed && record.error !== undefined && record.error !== '' ? (
        <div className="dc-history-section">
          <p className="dc-history-section-title">{t('historyFailure')}</p>
          <p className="dc-failure-text">{record.error}</p>
        </div>
      ) : null}
    </article>
  )
}
