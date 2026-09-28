'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '../lib/i18n/provider.js'
import { LANG_COOKIE, type Locale } from '../lib/i18n/types.js'

export interface LangSwitcherProps {
  /** Aktive Sprache — von `Shell` per `getLocale()` ermittelt (Server
   *  Component) und hier nur zur Anzeige (Button-Label, Häkchen im Menü)
   *  durchgereicht; die eigentliche Sprachwahl bleibt serverseitig via
   *  Cookie + `getLocale()`, s. Modul-Kommentar unten. */
  locale: Locale
}

const LOCALES: Locale[] = ['de', 'en']

/**
 * Sprach-Umschalter in der Topbar (neben `<ThemeToggle>`, s. `shell.tsx`).
 * Markup/Verhalten bewusst identisch zu `components/space-switcher.tsx`
 * (`.menu`/`.menu-item`-Bausteine, Pointerdown-außerhalb + Escape schließen).
 *
 * Setzt beim Auswählen NUR den `LANG_COOKIE`-Cookie (nicht httpOnly — muss vom
 * Umschalter selbst lesbar bleiben für Folge-Klicks vor einem Reload) und
 * ruft `router.refresh()`: das lässt alle Server Components (inkl.
 * `app/layout.tsx#getLocale`) den Request neu mit der neuen Sprache
 * rendern. Der Client leitet die Sprache selbst NIE ab — dieser Umschalter
 * ist die EINZIGE Stelle, die den Cookie clientseitig schreibt.
 */
export function LangSwitcher({ locale }: LangSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const router = useRouter()
  const { t, messages } = useT()

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function selectLocale(next: Locale) {
    setOpen(false)
    if (next === locale) return
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    router.refresh()
  }

  return (
    <div className="lang-switcher" ref={rootRef}>
      <button
        type="button"
        className="btn quiet icon"
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        title={t('shell.langSwitcher.title')}
        aria-label={t('shell.langSwitcher.ariaLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {locale.toUpperCase()}
      </button>
      {open ? (
        <div className="menu lang-switcher-menu" role="menu" aria-label={t('shell.langSwitcher.menuAriaLabel')}>
          {LOCALES.map((option) => {
            const isCurrent = option === locale
            return (
              <button
                key={option}
                type="button"
                className={isCurrent ? 'menu-item current' : 'menu-item'}
                role="menuitem"
                aria-current={isCurrent ? 'true' : undefined}
                onClick={() => selectLocale(option)}
              >
                <b>{messages.shell.langSwitcher.locales[option]}</b>
                {isCurrent ? (
                  <span className="check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
