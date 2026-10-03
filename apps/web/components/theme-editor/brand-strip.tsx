'use client'

import type { Mode, ResolvedTheme, ThemeFile } from '@f451/design-tokens'
import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { useT } from '../../lib/i18n/provider'
import type { EditorScope } from '../../lib/theme-editor'
import {
  BRAND_MAX_BYTES,
  brandAllowed,
  brandApiPath,
  brandImageUrl,
  describeBrandFailure,
  type BrandFailure,
  type BrandKind,
} from '../../lib/theme-editor-view'
import { previewStyle } from '../../lib/theme-preview'

export interface BrandStripProps {
  /** instance or space — the user scope has no brand */
  scope: EditorScope
  /** the scope's saved file (`EditorData.file`): its `brand` pointers say which files exist */
  file: ThemeFile | null
  /** the draft's `brand.name` */
  name: string
  canWrite: boolean
  /** a theme write of the editor is running */
  busy: boolean
  /** the draft differs from the saved file — an upload refreshes the page and drops it */
  dirty: boolean
  /** the draft resolved — the preview boxes take its surface and text colours */
  resolved: ResolvedTheme
  onName: (name: string | null) => void
}

type BrandStatus = { kind: 'ok'; text: string; note?: string } | { kind: 'error'; text: string; items: string[] }

const MODES: readonly Mode[] = ['light', 'dark']

/**
 * "Marke" above the token table (addendum §5/§7), instance and space only.
 * The name is part of the draft and goes with the normal save. Logo and
 * favicon are files of their own: upload and remove commit at once through the
 * brand routes, then the page is refreshed so the draft carries the new
 * pointer (a later save would otherwise drop it) and the top bar shows the
 * file. The favicon exists only in the instance.
 */
export function BrandStrip({ scope, file, name, canWrite, busy, dirty, resolved, onName }: BrandStripProps) {
  const { t } = useT()
  const router = useRouter()
  const [working, setWorking] = useState<BrandKind | null>(null)
  const [status, setStatus] = useState<BrandStatus | null>(null)
  // Bumped after a write: the image URL stays the same, the file behind it does not.
  const [version, setVersion] = useState(0)
  const inputs = { logo: useRef<HTMLInputElement>(null), favicon: useRef<HTMLInputElement>(null) }

  const styles = useMemo(
    () => ({
      light: previewStyle(resolved, 'light') as CSSProperties,
      dark: previewStyle(resolved, 'dark') as CSSProperties,
    }),
    [resolved],
  )

  const disabled = !canWrite || busy || working !== null
  const imageUrl = (kind: BrandKind): string | null => {
    const url = brandImageUrl(scope, file, kind)
    return url && version > 0 ? `${url}?v=${version}` : url
  }
  const logoUrl = imageUrl('logo')
  const faviconUrl = imageUrl('favicon')
  const modeLabel = (mode: Mode) => (mode === 'light' ? t('settings.appearance.modeLight') : t('settings.appearance.modeDark'))

  function failureStatus(failure: BrandFailure): BrandStatus {
    switch (failure.kind) {
      case 'notSvg':
        return { kind: 'error', text: t('settings.appearance.brand.errorNotSvg'), items: [] }
      case 'tooLarge':
        return { kind: 'error', text: t('settings.appearance.brand.errorTooLarge'), items: [] }
      case 'invalid':
        return { kind: 'error', text: t('settings.appearance.brand.errorInvalid'), items: failure.messages }
      case 'forbidden':
        return { kind: 'error', text: t('settings.appearance.brand.errorForbidden'), items: [] }
      case 'conflict':
        return { kind: 'error', text: t('settings.appearance.brand.errorConflict'), items: [] }
      case 'notFound':
        return { kind: 'error', text: t('settings.appearance.brand.errorNotFound'), items: [] }
      case 'error':
        return { kind: 'error', text: t('settings.appearance.serverError'), items: [] }
    }
  }

  async function failureOf(res: Response): Promise<BrandStatus> {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return failureStatus(describeBrandFailure(res.status, body))
  }

  async function upload(kind: BrandKind, event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const chosen = input.files?.[0]
    // Clear the input so choosing the same file again fires `change` again.
    input.value = ''
    const path = brandApiPath(scope, kind)
    if (!chosen || !path) return
    if (chosen.size > BRAND_MAX_BYTES) {
      setStatus(failureStatus({ kind: 'tooLarge' }))
      return
    }
    if (dirty && !window.confirm(t('settings.appearance.brand.unsavedConfirm'))) return
    setWorking(kind)
    setStatus(null)
    try {
      const res = await fetch(path, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'image/svg+xml' },
        body: chosen,
      })
      if (!res.ok) {
        setStatus(await failureOf(res))
        return
      }
      let sanitized = false
      try {
        const body: unknown = await res.json()
        sanitized = typeof body === 'object' && body !== null && (body as { sanitized?: unknown }).sanitized === true
      } catch {
        sanitized = false
      }
      setVersion((v) => v + 1)
      setStatus({
        kind: 'ok',
        text: t(kind === 'logo' ? 'settings.appearance.brand.uploaded' : 'settings.appearance.brand.faviconUploaded'),
        note: sanitized ? t('settings.appearance.brand.sanitized') : undefined,
      })
      router.refresh()
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
    } finally {
      setWorking(null)
    }
  }

  async function remove(kind: BrandKind) {
    const path = brandApiPath(scope, kind)
    if (!path) return
    const question = t(kind === 'logo' ? 'settings.appearance.brand.removeConfirm' : 'settings.appearance.brand.faviconRemoveConfirm')
    if (!window.confirm(question)) return
    if (dirty && !window.confirm(t('settings.appearance.brand.unsavedConfirm'))) return
    setWorking(kind)
    setStatus(null)
    try {
      const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin' })
      if (!res.ok) {
        setStatus(await failureOf(res))
        return
      }
      setVersion((v) => v + 1)
      setStatus({
        kind: 'ok',
        text: t(kind === 'logo' ? 'settings.appearance.brand.removed' : 'settings.appearance.brand.faviconRemoved'),
      })
      router.refresh()
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
    } finally {
      setWorking(null)
    }
  }

  function fileButtons(kind: BrandKind, present: boolean) {
    const uploadLabel = t(kind === 'logo' ? 'settings.appearance.brand.upload' : 'settings.appearance.brand.faviconUpload')
    const removeLabel = t(kind === 'logo' ? 'settings.appearance.brand.remove' : 'settings.appearance.brand.faviconRemove')
    return (
      <div className="btn-row">
        <button type="button" className="btn small" disabled={disabled} onClick={() => inputs[kind].current?.click()}>
          {working === kind ? t('settings.appearance.brand.working') : uploadLabel}
        </button>
        {present ? (
          <button type="button" className="btn small quiet" disabled={disabled} onClick={() => void remove(kind)}>
            {removeLabel}
          </button>
        ) : null}
        <input
          ref={inputs[kind]}
          type="file"
          accept="image/svg+xml,.svg"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => void upload(kind, event)}
        />
      </div>
    )
  }

  return (
    <section className="te-brand" aria-labelledby="te-brand-heading">
      <h2 className="te-brand-heading" id="te-brand-heading">
        {t('settings.appearance.brand.heading')}
      </h2>
      <p className="te-brand-note">{t('settings.appearance.brand.intro')}</p>

      <div className="field te-brand-name">
        <label className="label" htmlFor="te-brand-name">
          {t('settings.appearance.brand.nameLabel')}
        </label>
        <input
          id="te-brand-name"
          className="input"
          value={name}
          placeholder="f451"
          autoComplete="off"
          disabled={!canWrite || busy}
          aria-describedby="te-brand-name-hint"
          onChange={(event) => onName(event.target.value === '' ? null : event.target.value)}
        />
        <small id="te-brand-name-hint" className="te-brand-note">
          {t('settings.appearance.brand.nameHint')}
        </small>
      </div>

      <div className="te-brand-file">
        <h3 className="te-brand-subheading">{t('settings.appearance.brand.logoHeading')}</h3>
        <div className="te-brand-previews">
          {MODES.map((mode) => (
            <figure key={mode} className="te-brand-preview" data-theme={mode} style={styles[mode]}>
              <div className="te-brand-sample">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt={t('settings.appearance.brand.previewLabel', { mode: modeLabel(mode) })}
                    className="te-brand-logo"
                  />
                ) : (
                  <span className="te-brand-empty">{t('settings.appearance.brand.noLogo')}</span>
                )}
                <span className="te-brand-word">{name || 'f451'}</span>
              </div>
              <figcaption className="te-brand-caption">{modeLabel(mode)}</figcaption>
            </figure>
          ))}
        </div>
        <p className="te-brand-note">
          {t('settings.appearance.brand.logoHint')}
          {scope.kind === 'space' && !logoUrl ? ` ${t('settings.appearance.brand.inheritedLogo')}` : null}
        </p>
        {canWrite ? fileButtons('logo', logoUrl !== null) : null}
      </div>

      {brandAllowed(scope, 'favicon') ? (
        <div className="te-brand-file">
          <h3 className="te-brand-subheading">{t('settings.appearance.brand.faviconHeading')}</h3>
          <div className="te-brand-favicon">
            {faviconUrl ? (
              <img src={faviconUrl} alt="" className="te-brand-favicon-img" />
            ) : (
              <span className="te-brand-empty">{t('settings.appearance.brand.noFavicon')}</span>
            )}
          </div>
          <p className="te-brand-note">{t('settings.appearance.brand.faviconHint')}</p>
          {canWrite ? fileButtons('favicon', faviconUrl !== null) : null}
        </div>
      ) : null}

      {status ? (
        <div
          className={status.kind === 'error' ? 'te-brand-status te-brand-status-error' : 'te-brand-status'}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{status.text}</span>
          {status.kind === 'ok' && status.note ? <p className="te-brand-note">{status.note}</p> : null}
          {status.kind === 'error' && status.items.length > 0 ? (
            <ul className="te-messages">
              {status.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
