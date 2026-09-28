'use client'

import { useT } from '../lib/i18n/provider.js'

/**
 * Hell/Dunkel-Umschalter. Setzt `data-theme` am <html>-Element und merkt sich die
 * Wahl in localStorage. Das Flash-freie Setzen beim ersten Paint übernimmt das
 * Inline-Script im <head> (siehe layout.tsx); dieser Toggle ändert es zur Laufzeit.
 */
export function ThemeToggle() {
  const { t } = useT()
  function toggle() {
    const el = document.documentElement
    const current = el.getAttribute('data-theme')
    const next =
      current === 'dark'
        ? 'light'
        : current === 'light'
          ? 'dark'
          : window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'light'
            : 'dark'
    el.setAttribute('data-theme', next)
    try {
      localStorage.setItem('theme', next)
    } catch {
      /* localStorage kann blockiert sein — Umschalten funktioniert trotzdem für die Sitzung */
    }
  }

  return (
    <button
      type="button"
      className="btn quiet icon"
      onClick={toggle}
      title={t('shell.themeToggle.title')}
      aria-label={t('shell.themeToggle.ariaLabel')}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
