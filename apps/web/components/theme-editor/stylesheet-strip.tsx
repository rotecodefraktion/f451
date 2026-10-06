'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useRef, useState, type ChangeEvent } from 'react'
import { useT } from '../../lib/i18n/provider'
import type { EditorScope, EditorStylesheet } from '../../lib/theme-editor'
import { SKIP_THEME_CSS_PARAM } from '../../lib/theme-style'

export interface StylesheetStripProps {
  /** instance or space — the user scope has no stylesheet */
  scope: EditorScope
  /** `EditorData.stylesheet` */
  stylesheet: EditorStylesheet
  canWrite: boolean
  /** a theme write of the editor is running */
  busy: boolean
  /** the draft differs from the saved file — a write refreshes the page and drops it */
  dirty: boolean
}

type StripStatus = { kind: 'ok'; text: string } | { kind: 'error'; text: string; items: string[] }

/** Upper bound of `_meta/theme.css`, as the API checks it (`apps/api/src/theme/stylesheet.ts`). */
const STYLESHEET_MAX_BYTES = 256 * 1024

function stylesheetApiPath(scope: EditorScope): string | null {
  if (scope.kind === 'instance') return '/api/theme/stylesheet'
  if (scope.kind === 'space') return `/api/spaces/${encodeURIComponent(scope.id)}/theme/stylesheet`
  return null
}

/**
 * "Stylesheet" next to the brand strip (f451#61, spec decision 3), instance and
 * space only. Upload and remove commit `_meta/theme.css` at once through the
 * stylesheet routes, then the page is refreshed so the layout links the new
 * file. Fonts come into the repo through Git only; the strip lists them. The
 * link "Ohne Stylesheet anzeigen" reloads this page with `?ohne-stylesheet`,
 * which leaves the theme stylesheets out — a broken file must not make the
 * page unusable on which it is removed.
 */
export function StylesheetStrip({ scope, stylesheet, canWrite, busy, dirty }: StylesheetStripProps) {
  const { t, locale } = useT()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [working, setWorking] = useState(false)
  const [status, setStatus] = useState<StripStatus | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const path = stylesheetApiPath(scope)
  const disabled = !canWrite || busy || working
  const present = stylesheet.status !== 'missing'

  const size = (bytes: number | null): string =>
    bytes === null ? '' : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`
  const sha7 = stylesheet.sha ? stylesheet.sha.slice(0, 7) : ''
  const lineText = (line: number | undefined, message: string) =>
    typeof line === 'number' ? t('settings.appearance.stylesheet.problemLine', { line: String(line), message }) : message

  // The current URL with or without `ohne-stylesheet`; a plain `<a>` below, so the
  // root layout renders anew (the middleware reads the query on a document request).
  const skipping = searchParams.has(SKIP_THEME_CSS_PARAM)
  const query = new URLSearchParams(searchParams.toString())
  query.delete(SKIP_THEME_CSS_PARAM)
  const rest = query.toString()
  const withoutHref = `${pathname}?${rest ? `${rest}&` : ''}${SKIP_THEME_CSS_PARAM}`
  const withHref = rest ? `${pathname}?${rest}` : pathname

  async function failureOf(res: Response): Promise<StripStatus> {
    if (res.status === 403) return { kind: 'error', text: t('settings.appearance.stylesheet.errorForbidden'), items: [] }
    if (res.status === 404) return { kind: 'error', text: t('settings.appearance.stylesheet.errorNotFound'), items: [] }
    if (res.status === 409) return { kind: 'error', text: t('settings.appearance.stylesheet.errorConflict'), items: [] }
    if (res.status === 422) {
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      const errors = (body as { errors?: unknown } | null)?.errors
      const list = Array.isArray(errors)
        ? errors.filter(
            (e): e is { code: string; line?: number; message: string } =>
              typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string',
          )
        : []
      if (list.some((e) => e.code === 'css_too_large')) {
        return { kind: 'error', text: t('settings.appearance.stylesheet.errorTooLarge'), items: [] }
      }
      if (list.some((e) => e.code === 'css_not_text')) {
        return { kind: 'error', text: t('settings.appearance.stylesheet.errorNotText'), items: [] }
      }
      return {
        kind: 'error',
        text: t('settings.appearance.stylesheet.errorInvalid'),
        items: list.map((e) => lineText(e.line, e.message)),
      }
    }
    return { kind: 'error', text: t('settings.appearance.serverError'), items: [] }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget
    const chosen = field.files?.[0]
    // Clear the input so choosing the same file again fires `change` again.
    field.value = ''
    if (!chosen || !path) return
    if (chosen.size > STYLESHEET_MAX_BYTES) {
      setStatus({ kind: 'error', text: t('settings.appearance.stylesheet.errorTooLarge'), items: [] })
      return
    }
    if (dirty && !window.confirm(t('settings.appearance.stylesheet.unsavedConfirm'))) return
    setWorking(true)
    setStatus(null)
    try {
      const res = await fetch(path, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'text/css' },
        body: await chosen.text(),
      })
      if (!res.ok) {
        setStatus(await failureOf(res))
        return
      }
      setStatus({ kind: 'ok', text: t('settings.appearance.stylesheet.uploaded') })
      router.refresh()
    } catch {
      setStatus({ kind: 'error', text: t('settings.appearance.serverError'), items: [] })
    } finally {
      setWorking(false)
    }
  }

  async function remove() {
    if (!path) return
    if (!window.confirm(t('settings.appearance.stylesheet.removeConfirm'))) return
    if (dirty && !window.confirm(t('settings.appearance.stylesheet.unsavedConfirm'))) return
    setWorking(true)
    setStatus(null)
    try {
      const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin' })
      if (!res.ok) {
        setStatus(await failureOf(res))
        return
      }
      setStatus({ kind: 'ok', text: t('settings.appearance.stylesheet.removed') })
      router.refresh()
    } catch {
      setStatus({ kind: 'error', text: t('settings.appearance.serverError'), items: [] })
    } finally {
      setWorking(false)
    }
  }

  let state = ''
  switch (stylesheet.status) {
    case 'missing':
      state = t('settings.appearance.stylesheet.stateNone')
      break
    case 'ok':
      state = t('settings.appearance.stylesheet.stateOk', { size: size(stylesheet.bytes), sha: sha7 })
      break
    case 'invalid':
      state = t('settings.appearance.stylesheet.stateInvalid', { size: size(stylesheet.bytes), sha: sha7 })
      break
    case 'too_large':
      state = t('settings.appearance.stylesheet.stateTooLarge', { size: size(stylesheet.bytes) })
      break
    case 'unreadable':
      state = t('settings.appearance.stylesheet.stateUnreadable')
      break
  }
  const stateError = stylesheet.status === 'invalid' || stylesheet.status === 'too_large' || stylesheet.status === 'unreadable'

  return (
    <section className="te-brand" aria-labelledby="te-stylesheet-heading">
      <h2 className="te-brand-heading" id="te-stylesheet-heading">
        {t('settings.appearance.stylesheet.heading')}
      </h2>
      <p className="te-brand-note">{t('settings.appearance.stylesheet.intro')}</p>

      <div className="te-brand-file">
        <div className={stateError ? 'te-brand-status te-brand-status-error' : 'te-brand-status'}>
          <span>{state}</span>
          {stylesheet.status === 'invalid' && stylesheet.problems.length > 0 ? (
            <ul className="te-messages">
              {stylesheet.problems.map((p) => (
                <li key={`${p.line}-${p.code}-${p.message}`}>{lineText(p.line, p.message)}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <p className="te-brand-note">{t('settings.appearance.stylesheet.hint')}</p>
        {canWrite && path ? (
          <div className="btn-row">
            <button type="button" className="btn small" disabled={disabled} onClick={() => input.current?.click()}>
              {working ? t('settings.appearance.stylesheet.working') : t('settings.appearance.stylesheet.upload')}
            </button>
            {present ? (
              <button type="button" className="btn small quiet" disabled={disabled} onClick={() => void remove()}>
                {t('settings.appearance.stylesheet.remove')}
              </button>
            ) : null}
            <input
              ref={input}
              type="file"
              accept=".css,text/css"
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => void upload(event)}
            />
          </div>
        ) : null}
      </div>

      <div className="te-brand-file">
        <h3 className="te-brand-subheading">{t('settings.appearance.stylesheet.fontsHeading')}</h3>
        {stylesheet.fonts.length === 0 ? (
          <p className="te-brand-note">{t('settings.appearance.stylesheet.noFonts')}</p>
        ) : (
          <ul className="te-messages">
            {stylesheet.fonts.map((font) => (
              <li key={font.name}>
                {font.name}
                {font.bytes !== null ? ` · ${size(font.bytes)}` : ''}
                {' · '}
                {font.ok ? t('settings.appearance.stylesheet.fontOk') : t('settings.appearance.stylesheet.fontInvalid')}
              </li>
            ))}
          </ul>
        )}
        <p className="te-brand-note">{t('settings.appearance.stylesheet.fontsHint')}</p>
      </div>

      <p className="te-brand-note">{t('settings.appearance.stylesheet.everywhere')}</p>
      <p className="te-brand-note">
        {skipping ? (
          <>
            {t('settings.appearance.stylesheet.skipping')} <a href={withHref}>{t('settings.appearance.stylesheet.showWith')}</a>
          </>
        ) : (
          <a href={withoutHref}>{t('settings.appearance.stylesheet.showWithout')}</a>
        )}
      </p>

      {status ? (
        <div
          className={status.kind === 'error' ? 'te-brand-status te-brand-status-error' : 'te-brand-status'}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{status.text}</span>
          {status.kind === 'error' && status.items.length > 0 ? (
            <ul className="te-messages">
              {status.items.map((item, i) => (
                <li key={`${i}-${item}`}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
