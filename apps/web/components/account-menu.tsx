'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '../lib/i18n/provider.js'

export interface AccountMenuProps {
  displayName: string
}

/** Initialen aus dem Anzeigenamen — erstes + letztes Wort, sonst die ersten zwei Zeichen. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase()
}

/**
 * Topbar-Avatar mit Menü (Einstellungen-Link, Abmelden). Client-Insel: die
 * Shell selbst bleibt Server Component, nur dieser Slot ist interaktiv.
 * Logout ist bewusst ein POST-Fetch (CSRF-Schutz, siehe apps/api/src/routes/auth.ts)
 * statt eines simplen Links.
 */
export function AccountMenu({ displayName }: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const { t } = useT()

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  async function logout() {
    setLoggingOut(true)
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      setOpen(false)
      router.push('/')
      router.refresh()
    }
  }

  return (
    <div className="account" ref={rootRef}>
      <button
        type="button"
        className="avatar"
        onClick={() => setOpen((value) => !value)}
        title={displayName}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {initials(displayName)}
      </button>
      {open ? (
        <div className="menu account-menu" role="menu" aria-label={t('shell.account.menuAriaLabel')}>
          <div className="pop-user">{displayName}</div>
          {/* `stacked` = die zweizeilige Ausnahme des Menü-Bausteins (Titel
              über Beschreibung). Bis Teilschritt H1 war das Zweizeilige der
              Standard ALLER Menüzeilen — daher die beiden Spezifitätstricks
              im Space- und Sprach-Wechsler, die jetzt weg sind. */}
          <a
            className="menu-item stacked"
            role="menuitem"
            href="/einstellungen/verbindungen"
            onClick={() => setOpen(false)}
          >
            <b>{t('shell.account.settingsLabel')}</b>
            <span>{t('shell.account.settingsSubtitle')}</span>
          </a>
          <button type="button" className="menu-item stacked" role="menuitem" onClick={logout} disabled={loggingOut}>
            <b>{loggingOut ? t('shell.account.loggingOut') : t('shell.account.logout')}</b>
          </button>
        </div>
      ) : null}
    </div>
  )
}
