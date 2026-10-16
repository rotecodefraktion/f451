/**
 * Pure state helpers for the import/export panel (#128,
 * `components/import-panel.tsx`). The panel polls `GET /api/jobs/:id` and
 * feeds each answer through {@link nextState}; keeping the transitions here
 * makes them testable without a DOM.
 *
 * `JobView` mirrors `apps/api/src/import/jobs.ts` — the web app does not
 * import from the API package, so the shape is redeclared.
 */

import { wikiPageHref, wikiPageReviewHref } from './urls'

export type JobKind = 'import-bookstack' | 'import-file' | 'export-bookstack'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobEvent {
  status: string
  title: string
  pageId?: string
  reason?: string
  /** Set by the API: the published page or its open review; absent → no link. */
  link?: 'page' | 'review'
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
  /** The runner's current phase (`creating`, `reading`, `placing`, `writing`); null until the first. */
  phase: string | null
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

/**
 * Shape check for a 200 answer of `GET /api/jobs/:id` (and the cancel route).
 * A proxy can answer 200 with HTML or `{}`; such a body must not reach the
 * views, which read `events`, `counts`, `total` and `done` unguarded. Checks
 * only the fields the panel dereferences, not the full {@link JobView}.
 */
export function isJobView(x: unknown): x is JobView {
  if (!x || typeof x !== 'object') return false
  const v = x as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.status === 'string' &&
    Array.isArray(v.events) &&
    typeof v.counts === 'object' &&
    v.counts !== null &&
    !Array.isArray(v.counts) &&
    typeof v.total === 'number' &&
    typeof v.done === 'number'
  )
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
  return kind === 'export-bookstack' ? 'export-report.md' : 'import-report.md'
}

/** What `GET /api/import/instances` offers: the BookStack allow-list and,
 *  if the API supports it, the file import with its upload limit. */
export interface ImportOffer {
  bookstack: string[]
  /** Upload limit in MB; null → this API has no file import. */
  maxUploadMb: number | null
}

/** Reads an answer of `GET /api/import/instances` defensively (unknown
 *  fields ignored, malformed ones treated as absent). */
export function parseImportOffer(body: unknown): ImportOffer {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const bookstack = Array.isArray(b.bookstack) ? b.bookstack.filter((u): u is string => typeof u === 'string') : []
  const file = b.fileImport && typeof b.fileImport === 'object' ? (b.fileImport as Record<string, unknown>) : null
  const mb = file?.maxUploadMb
  const maxUploadMb = typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : null
  return { bookstack, maxUploadMb }
}

/** Whether the import page and its sidebar link are offered at all. */
export function importAvailable(offer: ImportOffer): boolean {
  return offer.bookstack.length > 0 || offer.maxUploadMb !== null
}

/** Client-side size check before the upload (the API checks again → 413). */
export function exceedsUploadLimit(bytes: number, maxUploadMb: number): boolean {
  return bytes > maxUploadMb * 1024 * 1024
}

export type FileFormat = 'markdown' | 'obsidian' | 'html'

export interface FileImportOptions {
  format: FileFormat
  parentId: string
  update: boolean
  release: boolean
  dryRun: boolean
}

/**
 * Multipart body for `POST /api/spaces/:space/import/file`. The text fields
 * come before the file part: `@fastify/multipart`'s `req.file()` only sees
 * the fields that precede the file in the stream.
 */
export function fileImportForm(file: Blob, fileName: string, opts: FileImportOptions): FormData {
  const form = new FormData()
  form.append('format', opts.format)
  const parent = opts.parentId.trim()
  if (parent) form.append('parentId', parent)
  form.append('update', String(opts.update))
  form.append('release', String(opts.release))
  form.append('dryRun', String(opts.dryRun))
  form.append('file', file, fileName)
  return form
}

/** Link for one event's page, as the API decided it (`JobEvent.link`). */
export function eventHref(space: string, e: JobEvent): string | null {
  if (!e.pageId || !e.link) return null
  return e.link === 'review' ? wikiPageReviewHref(space, e.pageId) : wikiPageHref(space, e.pageId)
}
