/**
 * Pure state helpers for the import/export panel (#128,
 * `components/import-panel.tsx`). The panel polls `GET /api/jobs/:id` and
 * feeds each answer through {@link nextState}; keeping the transitions here
 * makes them testable without a DOM.
 *
 * `JobView` mirrors `apps/api/src/import/jobs.ts` — the web app does not
 * import from the API package, so the shape is redeclared.
 */

export type JobKind = 'import-bookstack' | 'export-bookstack'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobEvent {
  status: string
  title: string
  pageId?: string
  reason?: string
}

export interface JobView {
  id: string
  kind: JobKind
  space: string
  status: JobStatus
  startedAt: string
  finishedAt: string | null
  total: number
  done: number
  events: JobEvent[]
  counts: Record<string, number>
  report: string | null
}

export type PanelState =
  | { kind: 'form' }
  | { kind: 'running'; jobId: string; view: JobView | null }
  | { kind: 'finished'; view: JobView }

export type PollResult = { status: 200; view: JobView } | { status: 404 } | { status: 'error' }

/**
 * Next panel state after one poll. A 404 means the job is gone (API restart,
 * expiry, or never ours) → back to the form. A transient error keeps the
 * previous state so the next tick can retry.
 */
export function nextState(prev: PanelState, poll: PollResult): PanelState {
  if (poll.status === 'error') return prev
  if (poll.status === 404) return { kind: 'form' }
  const view = poll.view
  if (view.status === 'running') return { kind: 'running', jobId: view.id, view }
  return { kind: 'finished', view }
}

/** `sessionStorage` key holding the running job id of a space. */
export function storageKey(space: string): string {
  return `f451:import-job:${space}`
}

/** Progress in whole percent (0..100); 0 while the total is still unknown. */
export function progressPercent(view: JobView): number {
  if (view.total <= 0) return 0
  const pct = Math.round((view.done / view.total) * 100)
  return Math.min(100, Math.max(0, pct))
}

/** File name for the "Download report" button. */
export function reportFileName(kind: JobView['kind']): string {
  return kind === 'import-bookstack' ? 'import-report.md' : 'export-report.md'
}
