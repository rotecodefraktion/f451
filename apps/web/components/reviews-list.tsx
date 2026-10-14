'use client'

/**
 * Review overview list (#131) — the client island of
 * `app/wiki/[space]/(shell)/reviews/page.tsx`. Shows the open reviews of a
 * space and releases a selection of them one at a time, in path order,
 * through the existing `POST /api/pages/:id/release`. A failed release keeps
 * its row selected with the reason; the others continue.
 *
 * Fetches go relative over the Next rewrites with the session cookie, as in
 * `components/import-panel.tsx`; a 401 sends the user to the login page.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState } from 'react'
import { useT } from '../lib/i18n/provider'
import { afterRelease, releaseBody, type ReviewItem, type RowResult } from '../lib/reviews-state'
import { apiPageReleasePath, wikiPageReviewHref } from '../lib/urls'

type Bump = 'major' | 'minor' | 'patch'

class SessionExpired extends Error {}

/** Same-origin JSON POST; 401 redirects to the login page. Network errors throw. */
async function postJson(path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status === 401) {
    const target = `${window.location.pathname}${window.location.search}`
    window.location.href = `/?next=${encodeURIComponent(target)}`
    throw new SessionExpired()
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  return { status: res.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} }
}

/** Server message of an error answer (`{status, reason}` or `{error}`). */
function serverMessage(body: Record<string, unknown>): string | null {
  if (typeof body.reason === 'string' && body.reason) return body.reason
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}

export interface ReviewsListProps {
  space: string
  versioning: boolean
  initial: ReviewItem[]
}

export function ReviewsList({ space, versioning, initial }: ReviewsListProps) {
  const { t, locale } = useT()
  const router = useRouter()
  const uid = useId()

  const [items, setItems] = useState<ReviewItem[]>(initial)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [bump, setBump] = useState<Bump>('minor')
  const [note, setNote] = useState('')
  const [running, setRunning] = useState(false)
  const [releasedCount, setReleasedCount] = useState(0)
  // UTC until hydration, local time after — server and browser would format
  // differently otherwise (pattern `components/api-tokens-panel.tsx`).
  const [timeZone, setTimeZone] = useState<string | undefined>('UTC')
  useEffect(() => setTimeZone(undefined), [])

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone })

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id))

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function onRelease() {
    // `items` comes sorted by path from the API, so this is path order.
    const order = items.filter((item) => selected.has(item.id)).map((item) => item.id)
    if (order.length === 0) return
    const body = releaseBody(versioning, bump, note)
    setRunning(true)
    setReleasedCount(0)
    let currentItems = items
    let currentSelected = selected
    let released = 0
    try {
      for (const id of order) {
        setResults((prev) => ({ ...prev, [id]: { state: 'releasing' } }))
        let outcome: { ok: true } | { ok: false; reason: string }
        try {
          const r = await postJson(apiPageReleasePath(id), body)
          if (r.status >= 200 && r.status < 300) outcome = { ok: true }
          else if (r.status === 409) outcome = { ok: false, reason: t('reviews.errors.conflict') }
          else if (r.status === 403) outcome = { ok: false, reason: t('reviews.errors.forbidden') }
          else outcome = { ok: false, reason: serverMessage(r.body) ?? t('reviews.errors.releaseFailed') }
        } catch (err) {
          if (err instanceof SessionExpired) return
          outcome = { ok: false, reason: t('reviews.errors.network') }
        }
        const next = afterRelease(currentItems, currentSelected, id, outcome)
        currentItems = next.items
        currentSelected = next.selected
        if (outcome.ok) released += 1
        setItems(currentItems)
        setSelected(currentSelected)
        setResults((prev) => ({ ...prev, [id]: next.result }))
      }
    } finally {
      setRunning(false)
      setReleasedCount(released)
    }
    // Released pages change the tree in the sidebar.
    if (released > 0) router.refresh()
  }

  const selectedCount = items.filter((item) => selected.has(item.id)).length

  return (
    <section className="reviews-panel">
      <p className="reviews-count">{t('reviews.count', { count: items.length })}</p>
      {releasedCount > 0 && (
        <div className="callout ok reviews-notice" role="status">
          {t('reviews.released', { count: releasedCount })}
        </div>
      )}
      {items.length === 0 ? (
        <p className="reviews-empty">{t('reviews.empty')}</p>
      ) : (
        <>
          <table className="reviews-table" aria-label={t('reviews.tableLabel')}>
            <thead>
              <tr>
                <th scope="col" className="reviews-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={running}
                    aria-label={t('reviews.selectAll')}
                  />
                </th>
                <th scope="col">{t('reviews.columns.title')}</th>
                <th scope="col">{t('reviews.columns.kind')}</th>
                <th scope="col">{t('reviews.columns.author')}</th>
                <th scope="col">{t('reviews.columns.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const result = results[item.id]
                return (
                  <tr key={item.id}>
                    <td className="reviews-check">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        disabled={running}
                        aria-label={t('reviews.selectRow', { title: item.title })}
                      />
                    </td>
                    <td>
                      <a href={wikiPageReviewHref(space, item.id)}>{item.title}</a>
                      <span className="reviews-path">{item.path}</span>
                      {result?.state === 'releasing' && <span className="reviews-status">{t('reviews.releasing')}</span>}
                      {result?.state === 'failed' && (
                        <span className="reviews-status reviews-failed" role="alert">
                          {result.reason}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${item.isNew ? 'info' : 'neutral'}`}>
                        {item.isNew ? t('reviews.kinds.new') : t('reviews.kinds.changed')}
                      </span>
                    </td>
                    <td>{item.lastAuthor ?? t('reviews.unknownAuthor')}</td>
                    <td>{formatDate(item.updatedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {versioning && (
            <div className="reviews-options">
              <div className="field">
                <label className="label" htmlFor={`${uid}-bump`}>
                  {t('reviews.bump')}
                </label>
                <div className="selectwrap">
                  <select
                    id={`${uid}-bump`}
                    className="select"
                    value={bump}
                    disabled={running}
                    onChange={(e) => setBump(e.target.value as Bump)}
                  >
                    <option value="major">{t('reviews.bumps.major')}</option>
                    <option value="minor">{t('reviews.bumps.minor')}</option>
                    <option value="patch">{t('reviews.bumps.patch')}</option>
                  </select>
                  <span className="caret" aria-hidden="true">
                    ▾
                  </span>
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor={`${uid}-note`}>
                  {t('reviews.note')}
                </label>
                <input
                  id={`${uid}-note`}
                  className="input"
                  value={note}
                  disabled={running}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="btn-row">
            <button type="button" className="btn primary" onClick={onRelease} disabled={running || selectedCount === 0}>
              {running ? t('reviews.releasing') : t('reviews.releaseSelected', { count: selectedCount })}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
