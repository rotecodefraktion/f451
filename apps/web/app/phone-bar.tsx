'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../lib/i18n/provider.js'

type Sheet = 'nav' | 'toc' | 'info'

/**
 * Telefon-Leiste (Issue #66, Variante B; Schwelle aus #64): unter
 * `(max-width: 699px) and (pointer: coarse)` ersetzt sie die Daumenregister.
 * Seitenbaum und Info-Leiste belegen dort keine Spalte, sondern öffnen sich
 * als Blatt von unten — die Monotonie-Zusage gilt erst oberhalb der Schwelle.
 *
 * Die Insel rendert immer; sichtbar ist sie nur unterhalb der Schwelle
 * (`styles/66-telefon.css`). Geschaltet wird über `data-sheet` am
 * `<html>`-Element, nach dem Muster von `data-nav`/`data-rail`
 * (`pane-edges.tsx`): Die Blätter SIND `#pane-nav` und `#pane-rail`, nur anders
 * gesetzt — kein zweiter Seitenbaum, keine zweite Info-Leiste.
 *
 * „Gliederung" zeigt vom `#pane-rail` nur den Abschnitt `.rp-toc`, „Info" alle
 * übrigen. „Weiter" führt zum nächsten Seiteneintrag im gerenderten Baum.
 */
export function PhoneBar() {
  const { t } = useT()
  const pathname = usePathname()
  const router = useRouter()
  const [offen, setOffen] = useState<Sheet | null>(null)
  const [vorhanden, setVorhanden] = useState({ nav: false, toc: false, info: false })

  const setze = useCallback((next: Sheet | null) => {
    setOffen(next)
    if (next) document.documentElement.setAttribute('data-sheet', next)
    else document.documentElement.removeAttribute('data-sheet')
  }, [])

  // Nach jedem Seitenwechsel: Blatt zu, und neu nachsehen, was diese Seite
  // anbietet (nicht jede Ansicht hat eine Info-Leiste oder eine Gliederung).
  useEffect(() => {
    setze(null)
    const rail = document.getElementById('pane-rail')
    setVorhanden({
      nav: !!document.getElementById('pane-nav'),
      toc: !!rail?.querySelector('.rp-toc'),
      info: !!rail?.querySelector('.rp:not(.rp-toc)'),
    })
  }, [pathname, setze])

  // Ein Link im Blatt (Seite im Baum, Sprungmarke in der Gliederung) schließt
  // es — sonst läge das Blatt nach dem Sprung weiter über dem Ziel.
  useEffect(() => {
    function onClick(ev: MouseEvent) {
      if (!document.documentElement.hasAttribute('data-sheet')) return
      if ((ev.target as HTMLElement | null)?.closest('#pane-nav a, #pane-rail a')) setze(null)
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setze(null)
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [setze])

  const knopf = (sheet: Sheet, glyph: string, label: string, aktiv: boolean) => (
    <button
      type="button"
      aria-expanded={offen === sheet}
      aria-controls={sheet === 'nav' ? 'pane-nav' : 'pane-rail'}
      disabled={!aktiv}
      onClick={() => setze(offen === sheet ? null : sheet)}
    >
      <span className="glyph" aria-hidden="true">
        {glyph}
      </span>
      {label}
    </button>
  )

  return (
    <>
      <button type="button" className="phone-scrim" aria-label={t('shell.phoneBar.close')} onClick={() => setze(null)} />
      <nav className="phone-bar" aria-label={t('shell.phoneBar.ariaLabel')}>
        {knopf('nav', '☰', t('shell.phoneBar.nav'), vorhanden.nav)}
        {knopf('toc', '§', t('shell.phoneBar.toc'), vorhanden.toc)}
        {knopf('info', 'ⓘ', t('shell.phoneBar.info'), vorhanden.info)}
        {/* Das Ziel wird erst beim Antippen gesucht: Der Baum klappt den Ast der
            aktuellen Seite auf dem Client auf (`tree-expansion.tsx`), beim
            Einhängen dieser Leiste steht der Eintrag womöglich noch nicht da. */}
        <button
          type="button"
          title={t('shell.phoneBar.nextTitle')}
          disabled={!vorhanden.nav}
          onClick={() => {
            const ziel = naechsteSeite()
            if (ziel) router.push(ziel)
          }}
        >
          <span className="glyph" aria-hidden="true">
            →
          </span>
          {t('shell.phoneBar.next')}
        </button>
      </nav>
    </>
  )
}

/** Der Seiteneintrag nach der aktuellen Seite im gerenderten Baum — ohne die
 *  Werkzeuge (`.tool`; Baum und Werkzeuge stehen beide in `.nav`) und den Kopf.
 *  Eingeklappte Äste zählen nicht mit: „Weiter" folgt dem, was der Baum gerade
 *  zeigt. */
function naechsteSeite(): string | null {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#pane-nav a[href^="/wiki/"]')).filter(
    (a) => !a.matches('.tool') && !a.closest('.head'),
  )
  const hier = links.findIndex((a) => a.getAttribute('aria-current') === 'page')
  return hier >= 0 && hier + 1 < links.length ? links[hier + 1]!.getAttribute('href') : null
}
