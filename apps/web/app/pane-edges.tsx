'use client'

import { useCallback, useEffect, useState } from 'react'
import { openSearch } from '../components/search-dialog'
import { useT } from '../lib/i18n/provider.js'

/** Schlüssel in `localStorage`. MUSS mit `NO_FLASH_PANES` in `layout.tsx`
 *  übereinstimmen — das Inline-Script liest denselben Eintrag vor dem ersten
 *  Paint, damit eine gespeichert eingeklappte Leiste nicht erst aufblitzt. */
export const PANE_STORAGE_KEY = 'panes'

interface PaneState {
  nav: boolean
  rail: boolean
}

/* ===========================================================================
 * Vorgabe für den ERSTEN Besuch (kein gespeicherter Zustand) steht im
 * flash-freien Inline-Script (`NO_FLASH_PANES` in `app/layout.tsx`): unter
 * 900px startet der Seitenbaum eingeklappt, unter 1180px die Info-Leiste.
 * Danach entscheidet allein der gespeicherte Zustand — er übersteht das
 * Neuladen in jeder Breite.
 *
 * ── Entscheidung zum 800-px-Konflikt ──────────────────────────────────────
 * Bei 800px Fenster blieben neben zwei offenen Leisten von 272px nur rund
 * 166px Dokumentspalte übrig; ein umbruchfreier Überschriftenname läuft dort
 * waagerecht aus der Spalte. Zur Wahl standen Stapeln (wie im Entwurf) und
 * automatisches Einklappen unterhalb einer Schwelle. GEWÄHLT ist KEINES von
 * beiden, sondern eine stetige Untergrenze der Dokumentspalte (22rem, s.
 * `60-chrome-raster.css`): beide Wege hätten dieselbe Zusage gebrochen, die
 * Monotonie. Stapeln verbreitert die Spalte am Haltepunkt sprunghaft — und
 * automatisches Einklappen tut genau dasselbe: fiele die Info-Leiste bei
 * 1180px von selbst weg, spränge die Spalte von 566 auf 817px, und die
 * Kürzungsleiter des Kolumnentitels (`61-lese.css`, hängt an der SPALTENbreite)
 * gäbe die zuvor gekürzten Pfadglieder wieder her: schmaler hieße mehr.
 *
 * Mit der Untergrenze fällt die Spalte stattdessen stetig und bleibt ab etwa
 * 800px auf 22rem stehen — die Leisten geben die Breite ab, nicht das Dokument.
 * Nichts kehrt zurück, nichts springt, und der Zustand ändert sich nie ohne
 * Zutun des Nutzers.
 * ========================================================================= */

/** Liest den Zustand aus den Wurzel-Attributen, die das Inline-Script gesetzt
 *  hat. Fehlt ein Attribut (Script blockiert), gilt „offen" — beide Leisten
 *  sichtbar ist der bedienbare Zustand, nicht der leere. */
function readRoot(): PaneState {
  const root = document.documentElement
  return {
    nav: root.getAttribute('data-nav') !== 'off',
    rail: root.getAttribute('data-rail') !== 'off',
  }
}

function writeRoot(next: PaneState) {
  const root = document.documentElement
  root.setAttribute('data-nav', next.nav ? 'on' : 'off')
  root.setAttribute('data-rail', next.rail ? 'on' : 'off')
}

/**
 * Die beiden Daumenregister des Fünf-Spalten-Rasters (Erscheinungsbild 2026,
 * Entwurf `docs/design/mockups-2026/editorial.html` — `.pane-edge`).
 *
 * Sie stehen in Spalte 1 und Spalte 5 von `.shell` und damit in JEDER
 * Fensterbreite: nur so bleibt der Schalter erreichbar, mit dem eine
 * eingeklappte Leiste wieder aufgeht. Geschaltet wird über die Attribute
 * `data-nav`/`data-rail` am `<html>`-Element (CSS dazu in
 * `styles/60-chrome-raster.css`) — nicht an `.shell`, weil das flash-freie
 * Inline-Script im `<head>` vor dem ersten Paint läuft und `.shell` dort noch
 * nicht existiert.
 *
 * BEIDE Schalter stehen unmittelbar nebeneinander im Quelltext, auch der
 * rechte. Ihre Lage im Satz hängt an der ausgeschriebenen `grid-column`, der
 * Tabulator-Lauf aber am Quelltext: stünde der rechte Schalter zuletzt, müsste
 * man erst den ganzen Seitenbaum und das ganze Dokument durchtabben, um eine
 * eingeklappte Info-Leiste wieder zu öffnen (zugesicherte Eigenschaft 7). Die
 * Tastenkürzel ersetzen das nicht — ein modifikatorloses Einzeltastenkürzel ist
 * eine Abkürzung, kein Zugang.
 */
export interface PaneEdgesProps {
  /** Without a top bar the left edge also carries a magnifier that opens the
   *  search dialog; CSS shows it only while the tree is closed
   *  (`:root[data-nav='off']`), because then the tree head's search field is gone. */
  searchOnEdge?: boolean
}

export function PaneEdges({ searchOnEdge = false }: PaneEdgesProps) {
  const { t } = useT()
  // Erster Render MUSS zum Server-HTML passen (sonst Hydration-Fehler), also
  // „beide offen"; der Effekt unten holt sofort den echten Zustand aus den
  // Wurzel-Attributen nach. Sichtbar ist das nicht: das Raster und die
  // Zustandszeichen hängen am Wurzel-Attribut, nicht an diesem State.
  const [panes, setPanes] = useState<PaneState>({ nav: true, rail: true })

  /** Sichtbaren Zustand setzen, merken und in `localStorage` fortschreiben. */
  const apply = useCallback((next: PaneState) => {
    setPanes(next)
    writeRoot(next)
    try {
      window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* localStorage kann blockiert sein — Schalten funktioniert dann nur für die Sitzung */
    }
  }, [])

  // Kein Effekt auf Fenstergrößen: der Zustand ändert sich AUSSCHLIESSLICH
  // durch den Nutzer (s. Entscheidung oben). Beim Laden hat das Inline-Script
  // im `<head>` die Wurzel-Attribute schon gesetzt; hier wird nur das
  // `aria-expanded` der beiden Schalter darauf nachgezogen.
  useEffect(() => {
    setPanes(readRoot())
  }, [])

  // Tastenkürzel `[` (Seitenbaum), `]` (Info-Leiste), `\` (Vollbreite: beide zu,
  // erneut gedrückt beide auf). Ohne Modifikator und nur außerhalb von
  // Eingaben — im Editor (CodeMirror/TipTap) sind `[` und `]` gewöhnliche
  // Zeichen und müssen es bleiben.
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      const target = ev.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const current = readRoot()
      let next: PaneState
      if (ev.key === '[') next = { ...current, nav: !current.nav }
      else if (ev.key === ']') next = { ...current, rail: !current.rail }
      else if (ev.key === '\\') {
        const anyOpen = current.nav || current.rail
        next = { nav: !anyOpen, rail: !anyOpen }
      } else return
      ev.preventDefault()
      apply(next)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [apply])

  return (
    <>
      <div className={searchOnEdge ? 'pane-edge pane-edge--nav pane-edge--stack' : 'pane-edge pane-edge--nav'}>
        <button
          type="button"
          className="pane-toggle pane-toggle--nav"
          aria-expanded={panes.nav}
          aria-controls="pane-nav"
          title={t('shell.panes.nav.title')}
          onClick={() => apply({ ...readRoot(), nav: !readRoot().nav })}
        >
          <span className="glyph" aria-hidden="true" />
          <span className="t">{t('shell.panes.nav.label')}</span>
          <kbd aria-hidden="true">[</kbd>
        </button>
        {searchOnEdge ? (
          <button
            type="button"
            className="pane-search"
            aria-label={t('shell.panes.search.label')}
            title={t('shell.panes.search.title')}
            aria-haspopup="dialog"
            onClick={openSearch}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      <div className="pane-edge pane-edge--rail">
        <button
          type="button"
          className="pane-toggle pane-toggle--rail"
          aria-expanded={panes.rail}
          aria-controls="pane-rail"
          title={t('shell.panes.rail.title')}
          onClick={() => apply({ ...readRoot(), rail: !readRoot().rail })}
        >
          <span className="glyph" aria-hidden="true" />
          <span className="t">{t('shell.panes.rail.label')}</span>
          <kbd aria-hidden="true">]</kbd>
        </button>
      </div>
    </>
  )
}
