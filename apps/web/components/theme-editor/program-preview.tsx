'use client'

import type { ResolvedTheme } from '@f451/design-tokens'
import { useEffect, useRef } from 'react'
import { istVorschau, leseUeberschreibungen, schreibeUeberschreibungen } from '../../lib/erscheinungsbild'
import { useT } from '../../lib/i18n/provider'
import {
  PREVIEW_EVENT,
  PREVIEW_STORAGE_KEY,
  currentMode,
  overrideNames,
  programOverrides,
  type PreviewOverrides,
} from '../../lib/theme-preview'

export interface ProgramPreviewProps {
  resolved: ResolvedTheme
  active: boolean
  onChange(active: boolean): void
}

/*
 * The storage and document side of "Im ganzen Programm ausprobieren". The
 * no-flash script of `app/layout.tsx` (`NO_FLASH_TOKENS`) applies the stored
 * overrides on every load; these functions do the same for the page that is
 * already open, so the preview takes effect without a reload. Storage may be
 * blocked (private mode, policy) — then the preview silently does nothing.
 */

function readStored(): PreviewOverrides | null {
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_KEY)
    return raw === null ? null : leseUeberschreibungen(raw)
  } catch {
    return null
  }
}

/**
 * True when a program preview is stored in this browser — a value carrying the
 * preview marker. An unmarked value is an old override set (the appearance page
 * offers to take it over into "Meine Einstellungen"), not a running preview.
 */
export function isProgramPreviewActive(): boolean {
  try {
    return istVorschau(localStorage.getItem(PREVIEW_STORAGE_KEY))
  } catch {
    return false
  }
}

/**
 * Puts the stored overrides of the mode in effect on `<html>`, after taking
 * off whatever either mode had put there. Called on start, and by the banner
 * whenever the mode changes — the no-flash script only runs on load.
 */
export function applyStoredPreview(): void {
  const stored = readStored()
  if (!stored) return
  const root = document.documentElement
  for (const name of overrideNames(stored)) root.style.removeProperty(name)
  const mode = currentMode(root.getAttribute('data-theme'), window.matchMedia('(prefers-color-scheme: dark)').matches)
  for (const [name, value] of Object.entries(stored[mode])) {
    if (name.startsWith('--')) root.style.setProperty(name, value)
  }
}

function announce(active: boolean): void {
  window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: { active } }))
}

export function startProgramPreview(resolved: ResolvedTheme): void {
  const overrides = programOverrides(resolved)
  const before = readStored()
  try {
    localStorage.setItem(PREVIEW_STORAGE_KEY, schreibeUeberschreibungen(overrides, { preview: true }))
  } catch {
    return
  }
  // A refresh with fewer changed tokens must take off the ones it no longer has.
  if (before) for (const name of overrideNames(before)) document.documentElement.style.removeProperty(name)
  applyStoredPreview()
  announce(true)
}

export function endProgramPreview(): void {
  const stored = readStored()
  try {
    localStorage.removeItem(PREVIEW_STORAGE_KEY)
  } catch {
    /* blocked storage — nothing was stored either */
  }
  if (stored) for (const name of overrideNames(stored)) document.documentElement.style.removeProperty(name)
  announce(false)
}

/**
 * "Im ganzen Programm ausprobieren" (July spec, "Vorschau"): stores the draft
 * for this browser only, without a commit. Controlled — `active` is owned by
 * the caller; on mount and on every start/end (here, in the banner or in
 * another component) `onChange` reports the stored state.
 */
export function ProgramPreview({ resolved, active, onChange }: ProgramPreviewProps) {
  const { t } = useT()
  // Latest callback without re-subscribing when the caller passes a new function.
  const report = useRef(onChange)
  useEffect(() => {
    report.current = onChange
  })

  useEffect(() => {
    const sync = () => report.current(isProgramPreviewActive())
    sync()
    window.addEventListener(PREVIEW_EVENT, sync)
    return () => window.removeEventListener(PREVIEW_EVENT, sync)
  }, [])

  return (
    <div className="te-try">
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => startProgramPreview(resolved)}>
          {active ? t('settings.appearance.programPreview.refresh') : t('settings.appearance.programPreview.start')}
        </button>
        {active ? (
          <button type="button" className="btn quiet" onClick={endProgramPreview}>
            {t('settings.appearance.programPreview.end')}
          </button>
        ) : null}
      </div>
      <p className="te-try-hint" role="status">
        {active ? t('settings.appearance.programPreview.active') : t('settings.appearance.programPreview.hint')}
      </p>
    </div>
  )
}
