'use client'

import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n/provider'

/**
 * Positionsanzeige des Kolumnentitels („Abschnitt 3 von 6") — zweites und
 * letztes Element des Kolumnentitels (Erscheinungsbild 2026, Etappe 3;
 * Entwurf `.runhead__pos` in `docs/design/mockups-2026/editorial.html`).
 *
 * ZÄHLWEISE (die Falle dieses Features): Der Nenner kommt NICHT aus dem DOM,
 * sondern aus `slugs` — den Abschnitts-Slugs der GANZEN Seite, serverseitig aus
 * `PageData.headings` gebildet (`lib/page-view.ts#sectionSlugs`). Ein DOM-Zähler
 * zählt, was gerade gerendert ist; im Review-Diff sind das nur die GEÄNDERTEN
 * Überschriften, und die Anzeige wäre schlicht falsch („Abschnitt 1 von 2" für
 * den vierten Abschnitt von sechs). Deshalb ist der Kolumnentitel auch
 * ausschließlich Teil der Leseansicht (`components/page-view.tsx`) — Editor und
 * Review-Diff tragen ihn nicht, obwohl sie sich `.page-body` mit ihr teilen.
 *
 * Der Zähler des DOM wird nur für die AKTUELLE Stelle benutzt: welche der
 * bekannten Überschriften zuletzt über der Lesemarke (30 % der Sichthöhe) stand.
 * Fehlt eine davon im DOM, bleibt der Nenner trotzdem richtig.
 *
 * Ohne JavaScript steht „Abschnitt 1 von N" — der Nenner ist auch dann korrekt,
 * weil er vom Server kommt.
 */
export function ReadingPosition({ slugs }: { slugs: string[] }) {
  const { t } = useT()
  const [current, setCurrent] = useState(1)

  useEffect(() => {
    if (slugs.length === 0) return
    const heads = slugs.map((slug) => document.getElementById(slug))
    const scroller = scrollParent(heads.find((h) => h !== null) ?? null)

    const update = () => {
      // Lesemarke: 30 % der Sichthöhe des SCROLLBEREICHS (nicht des Fensters —
      // die Leseansicht scrollt in `.main`, nicht im Dokument, s.
      // `60-chrome-raster.css`; ermittelt wird der Bereich generisch über die
      // `overflow`-Kette, damit diese Komponente nicht an eine Chrome-Klasse
      // eines anderen Bereichs gebunden ist).
      const isWindow = scroller === window
      const viewTop = isWindow ? 0 : (scroller as HTMLElement).getBoundingClientRect().top
      const viewHeight = isWindow ? window.innerHeight : (scroller as HTMLElement).clientHeight
      const marker = viewTop + viewHeight * 0.3
      let index = 0
      heads.forEach((head, i) => {
        if (head && head.getBoundingClientRect().top <= marker) index = i
      })
      setCurrent(index + 1)
    }

    update()
    scroller.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      scroller.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [slugs])

  if (slugs.length === 0) return null
  return (
    <span className="label runhead__pos">{t('read.runhead.position', { current, total: slugs.length })}</span>
  )
}

/** Nächster scrollender Vorfahre (oder das Fenster, wenn es keinen gibt). */
function scrollParent(el: HTMLElement | null): HTMLElement | Window {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node
  }
  return window
}
