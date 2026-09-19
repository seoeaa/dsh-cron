/**
 * Scoped stylesheet for the dsh-cron settings page. Standalone client bundles
 * cannot use the in-repo CSS-module pipeline, so the sheet ships as a string
 * and is installed effect-scoped into a `<style data-dsh-cron>` element.
 * Every selector is scoped under `[data-dsh-cron]` and uses theme design
 * tokens only, so it follows both colour schemes.
 *
 * Portaled surfaces (the editor and history modals) wrap their own content in
 * a `data-dsh-cron` node, so the same selectors apply inside the portal.
 *
 * @module dsh-cron/client/styles
 */

/** One `<style>` installation; returns the exact disposer that removes it. */
export function installCronStyles(): () => void {
  const existing = document.querySelector('style[data-dsh-cron]')
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.dataset.dshCron = ''
  element.textContent = CRON_CSS
  document.head.append(element)
  return () => { element.remove() }
}

/** The page stylesheet, scoped and token-driven. */
const CRON_CSS = `
[data-dsh-cron] {
  color: var(--dsw-alias-label-primary);
}
[data-dsh-cron] .dc-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
[data-dsh-cron] .dc-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-dsh-cron] .dc-title {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-cron] .dc-spacer {
  flex: 1 1 0;
}
[data-dsh-cron] .dc-subtle {
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-dsh-cron] .dc-updating {
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-cron] .dc-muted {
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-cron] .dc-mono {
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 0.85em;
}
[data-dsh-cron] .dc-error {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
[data-dsh-cron] .dc-error-detail {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 8px 12px;
}
[data-dsh-cron] .dc-banner[data-tone='companion'] {
  border-color: var(--dsw-alias-state-warn-primary);
}
[data-dsh-cron] .dc-banner-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-cron] .dc-banner-detail {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-invalid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 10px 12px;
}
[data-dsh-cron] .dc-invalid-title {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
}
[data-dsh-cron] .dc-invalid-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-dsh-cron] .dc-invalid-path {
  display: block;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 0.85em;
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-invalid-text {
  display: block;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-targets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-targets-title {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-targets-list {
  list-style: disc;
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[data-dsh-cron] .dc-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
}
[data-dsh-cron] .dc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
[data-dsh-cron] .dc-table th,
[data-dsh-cron] .dc-table td {
  text-align: left;
  vertical-align: top;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
[data-dsh-cron] .dc-table th {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
  white-space: nowrap;
}
[data-dsh-cron] .dc-table tbody tr:last-child td {
  border-bottom: 0;
}
[data-dsh-cron] .dc-table tbody tr[data-running='true'] {
  background: var(--dsw-alias-bg-layer-2);
}
[data-dsh-cron] .dc-name {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
[data-dsh-cron] .dc-schedule-raw {
  display: block;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-cron] .dc-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
[data-dsh-cron] .dc-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.8em;
  white-space: nowrap;
  border: 1px solid currentColor;
}
[data-dsh-cron] .dc-badge[data-tone='warn'] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-dsh-cron] .dc-badge[data-tone='ongoing'] {
  color: var(--dsw-alias-state-business-primary);
}
[data-dsh-cron] .dc-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
[data-dsh-cron] .dc-action {
  font: inherit;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  padding: 3px 8px;
  white-space: nowrap;
}
[data-dsh-cron] .dc-action:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
[data-dsh-cron] .dc-action:disabled {
  opacity: 0.55;
  cursor: default;
}
[data-dsh-cron] .dc-action[data-tone='danger'] {
  color: var(--dsw-alias-state-error-primary);
  border-color: currentColor;
}
[data-dsh-cron] .dc-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 4px;
  padding: 8px;
}
[data-dsh-cron] .dc-confirm-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-cron] .dc-empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: 6px;
  padding: 18px 12px;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-truncate {
  display: block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-cron] .dc-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
[data-dsh-cron] .dc-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[data-dsh-cron] .dc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.9em;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-field-label {
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-field input,
[data-dsh-cron] .dc-field select,
[data-dsh-cron] .dc-field textarea {
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  padding: 5px 8px;
  min-width: 0;
}
[data-dsh-cron] .dc-field textarea {
  resize: vertical;
  min-height: 96px;
}
[data-dsh-cron] .dc-field input:focus-visible,
[data-dsh-cron] .dc-field select:focus-visible,
[data-dsh-cron] .dc-field textarea:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
[data-dsh-cron] .dc-hint {
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-field-error {
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-check {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-check-note {
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  padding: 8px;
}
[data-dsh-cron] .dc-preview-desc {
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-cron] .dc-preview-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-preview-next {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[data-dsh-cron] .dc-preview-next li {
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 0.85em;
}
[data-dsh-cron] .dc-modal-footer {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
[data-dsh-cron] .dc-history {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[data-dsh-cron] .dc-history-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-dsh-cron] .dc-history-day {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 0.9em;
}
[data-dsh-cron] .dc-history-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 8px 10px;
}
[data-dsh-cron] .dc-history-meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-cron] .dc-history-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[data-dsh-cron] .dc-history-section-title {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 0.85em;
}
[data-dsh-cron] .dc-digest {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-alias-font-mono, monospace);
  font-size: 0.85em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
[data-dsh-cron] .dc-digest[data-collapsed='true'] {
  max-height: 120px;
}
[data-dsh-cron] .dc-detail-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[data-dsh-cron] .dc-detail-list li {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
[data-dsh-cron] .dc-failure-text {
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
`
