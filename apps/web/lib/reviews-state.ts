/**
 * Pure helpers for the review overview (#131, `components/reviews-list.tsx`).
 * The list releases the selected reviews one at a time through
 * `POST /api/pages/:id/release`; how the rows change after each answer lives
 * here so it is testable without a DOM.
 */

/** One open review as `GET /api/spaces/:space/reviews` returns it. */
export interface ReviewItem {
  id: string
  title: string
  path: string
  isNew: boolean
  /** The review deletes the page and its subpages (#155). */
  isDeletion: boolean
  lastAuthor: string | null
  updatedAt: string
  prNumber: number
  prUrl: string
}

/** What happened to a row in the current batch. */
export type RowResult = { state: 'idle' } | { state: 'releasing' } | { state: 'failed'; reason: string }

/** Request body of one release. Only versioned spaces take `bump`/`note`
 *  (the release route rejects them otherwise); a blank note is left out. */
export function releaseBody(versioning: boolean, bump: 'major' | 'minor' | 'patch', note: string): Record<string, unknown> {
  if (!versioning) return {}
  const trimmed = note.trim()
  return trimmed ? { bump, note: trimmed } : { bump }
}

/** Rows after one release answer: a released row disappears and leaves the
 *  selection; a failed row stays, stays selected and carries its reason. */
export function afterRelease(
  items: ReviewItem[],
  selected: Set<string>,
  id: string,
  outcome: { ok: true } | { ok: false; reason: string },
): { items: ReviewItem[]; selected: Set<string>; result: RowResult } {
  if (!outcome.ok) {
    return { items, selected, result: { state: 'failed', reason: outcome.reason } }
  }
  const nextSelected = new Set(selected)
  nextSelected.delete(id)
  return { items: items.filter((item) => item.id !== id), selected: nextSelected, result: { state: 'idle' } }
}

/** Number of import events whose page now waits in an open review. */
export function waitingReviews(events: Array<{ link?: string }>): number {
  return events.filter((e) => e.link === 'review').length
}
