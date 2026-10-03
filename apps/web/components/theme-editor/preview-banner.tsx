'use client'

import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n/provider'
import { PREVIEW_EVENT, PREVIEW_STORAGE_KEY } from '../../lib/theme-preview'
import { applyStoredPreview, endProgramPreview, isProgramPreviewActive } from './program-preview'

/**
 * The persistent bar "Vorschau aktiv — beenden" (July spec, "Vorschau"): keeps
 * anyone from taking a trial for the real thing. Mounted once in the root
 * layout; renders nothing unless a program preview is stored.
 *
 * While the preview is on it also follows mode changes: the no-flash script
 * applies the stored overrides of ONE mode on load, so switching between light
 * and dark afterwards would otherwise keep the other mode's values on `<html>`.
 */
export function PreviewBanner() {
  const { t } = useT()
  const [active, setActive] = useState(false)

  useEffect(() => {
    const sync = () => setActive(isProgramPreviewActive())
    sync()
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === PREVIEW_STORAGE_KEY) sync()
    }
    window.addEventListener(PREVIEW_EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PREVIEW_EVENT, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const observer = new MutationObserver(applyStoredPreview)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', applyStoredPreview)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', applyStoredPreview)
    }
  }, [active])

  if (!active) return null

  return (
    <div className="te-preview-banner" role="region" aria-label={t('settings.appearance.programPreview.banner')}>
      <span className="te-preview-banner-text">{t('settings.appearance.programPreview.banner')}</span>
      <button type="button" className="btn small" onClick={endProgramPreview}>
        {t('settings.appearance.programPreview.bannerEnd')}
      </button>
    </div>
  )
}
