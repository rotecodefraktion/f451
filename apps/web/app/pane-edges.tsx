'use client'

import { openSearch } from '../components/search-dialog'
import { useT } from '../lib/i18n/provider.js'
import { togglePane, usePaneShortcuts, usePanes } from './pane-state'

// The state, its persistence and the keys live in `pane-state.ts`, shared with
// the top bar buttons (`pane-bar-toggle.tsx`, `--pane-controls: topbar`).
export { PANE_STORAGE_KEY } from './pane-state'

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
  // No effect on window size: the state changes ONLY through the user (see the
  // decision above). `usePanes` only keeps `aria-expanded` in step with the
  // root attributes the inline script in `<head>` has already set.
  const panes = usePanes()
  usePaneShortcuts()

  return (
    <>
      <div className={searchOnEdge ? 'pane-edge pane-edge--nav pane-edge--stack' : 'pane-edge pane-edge--nav'}>
        <button
          type="button"
          className="pane-toggle pane-toggle--nav"
          aria-expanded={panes.nav}
          aria-controls="pane-nav"
          title={t('shell.panes.nav.title')}
          onClick={() => togglePane('nav')}
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
          onClick={() => togglePane('rail')}
        >
          <span className="glyph" aria-hidden="true" />
          <span className="t">{t('shell.panes.rail.label')}</span>
          <kbd aria-hidden="true">]</kbd>
        </button>
      </div>
    </>
  )
}
