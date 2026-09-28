import type { ReactNode } from 'react'
import { SearchDialog } from '../components/search-dialog'
import { ShortcutsDialog } from '../components/shortcuts-dialog'
import { SpaceSwitcher, type SpaceSwitcherSpace } from '../components/space-switcher'
import { getT } from '../lib/i18n/server.js'
import { LangSwitcher } from './lang-switcher.js'
import { PaneEdges } from './pane-edges'
import { PhoneBar } from './phone-bar'
import { ThemeToggle } from './theme-toggle'

export interface ShellProps {
  /**
   * Space-Name-Slot in der Topbar (`.brand .app`) — z. B. „Betrieb-Wiki".
   * Nur relevant, wenn `spaces` NICHT gesetzt ist (z. B. die Einstellungen-
   * Seite, die keinem Space zugeordnet ist): reines Label, kein Wechsler.
   */
  space?: ReactNode
  /**
   * Alle konfigurierten Spaces (aus `GET /api/spaces`) + die Id des aktuell
   * angezeigten — ersetzt bei ≥2 Einträgen das statische `.app`-Label durch
   * den `<SpaceSwitcher>` (Topbar-Dropdown zum Space-Wechseln). Bei genau
   * einem Space (oder wenn ein Aufrufer diese Liste gar nicht kennt, s.
   * `space`-Prop) bleibt es beim reinen Label — ein Umschalter ohne
   * Alternative wäre sinnlos.
   */
  spaces?: SpaceSwitcherSpace[]
  currentSpaceId?: string
  /** Avatar-/Login-Slot rechts in der Topbar. Wird von Task 2 aus /api/me befüllt. */
  avatar?: ReactNode
  /** Linke Spalte: Seitenbaum. Soll eine eigene `.tree`-Struktur liefern (Task 3). */
  sidebar?: ReactNode
  /**
   * Inhalts-Grid-Kinder (mittlere + rechte Spalte). Die Seite liefert selbst
   * ihr `<main className="main">` und — sofern vorhanden — ihr
   * `<aside className="rail">` als direkte Kinder des `.shell`-Grids.
   *
   * Bewusst NICHT mehr in ein `<main>` gewickelt (und der frühere `rail`-Slot
   * ist entfallen): Im abgenommenen Mockup ist `.main.card` genau EINE Karte,
   * die Toolbar, Subbar, Notices und Body zusammenfasst — das lässt sich nur
   * erreichen, wenn die Seite das `<main class="main">` selbst rendert
   * (Task-1-Review-Finding). Zugleich hängt die rechte Leiste von Seitendaten
   * (ToC/Tags/Relationen) ab; sie als Grid-Geschwister der Seite zu überlassen
   * hält die `<Shell>` frei von Seiteninhalt. Alle Nutzer wickeln ihren Inhalt
   * deshalb in `<main className="main">` (siehe wiki-/einstellungen-Seiten).
   */
  children: ReactNode
  /** 'graph' schaltet das Inhalts-Grid auf das Vollbild-Layout des
   *  abgenommenen Graph-Mockups (60px-Minitree + Stage, docs/design/mockups/
   *  graph.html `.gwrap`) — Topbar bleibt identisch. */
  variant?: 'default' | 'graph'
}

/**
 * App-Shell im abgenommenen Design (docs/design/mockups/leseansicht.html):
 * sticky Topbar mit Logo/Space/Suche/Theme-Toggle/Avatar und ein Grid
 * (Seitenbaum · Inhalt · rechte Leiste) mit den verbindlichen Breakpoints
 * 1160px (Rail aus) / 820px (Baum aus) / 640px + 400px (kompakte Topbar).
 *
 * Server Component (async — ermittelt die aktive Sprache selbst per
 * `getT()`, s. `lib/i18n/server.ts`; kein Aufrufer muss `locale` durchreichen).
 * Client-Inseln sind der Theme-Toggle, der Sprach-Umschalter und die
 * Such-Insel (`<SearchDialog>`: Topbar-Trigger + ⌘K-Dialog in einer
 * Komponente, siehe components/search-dialog.tsx).
 */
export async function Shell({ space, spaces, currentSpaceId, avatar, sidebar, children, variant = 'default' }: ShellProps) {
  const { locale, t } = await getT()
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <a className="brand-home" href="/wiki" aria-label={t('shell.topbar.homeAriaLabel')}>
            <span className="mark">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M6 3h13v3H10v4h7v3h-7v8H6z" fill="currentColor" />
              </svg>
            </span>
            <span className="brand-wort">f451</span>
          </a>
        </div>
        {/* Bewusst AUSSERHALB von `.brand` (das per `overflow: hidden` seinen
            Inhalt beschneidet, s. globals.css): der `SpaceSwitcher` öffnet ein
            absolut positioniertes Dropdown, das sonst am `.brand`-Rand
            geclippt würde (Bugfix „Space-Switcher-Dropdown geclippt"). Als
            eigenes Topbar-Geschwister bleibt es layoutmäßig gleichwertig zum
            bisherigen `.brand .app`-Platz (beide tragen die `.app`-Klasse samt
            deren `border-left`-Trenner, s. `.topbar > .app`-Regel). */}
        {spaces && spaces.length >= 2 ? (
          <SpaceSwitcher spaces={spaces} currentSpaceId={currentSpaceId} />
        ) : space ? (
          <span className="app">{space}</span>
        ) : null}
        <div className="grow" />
        <SearchDialog />
        {/* Nur der Dialog, ohne sichtbaren Auslöser — geöffnet wird er per `?`
            oder per CustomEvent aus der Werkzeugliste der linken Leiste. Er
            hängt hier, weil er auf JEDER Seite der Schale erreichbar sein
            muss (s. components/shortcuts-dialog.tsx). */}
        <ShortcutsDialog />
        <LangSwitcher locale={locale} />
        <ThemeToggle />
        {avatar}
      </header>

      {/* Fünf-Spalten-Raster (Erscheinungsbild 2026): Daumenregister links ·
          Seitenbaum · Dokument · Info-Leiste · Daumenregister rechts. Die
          Register stehen ZUERST im Quelltext — links und rechts unmittelbar
          nebeneinander —, damit der Tabulator-Lauf der räumlichen Anordnung
          folgt (zugesicherte Eigenschaft 7). Ihre Spalten stehen in jeder
          Fensterbreite; welche Leiste offen ist, entscheidet `data-nav`/
          `data-rail` am `<html>`-Element (s. `pane-edges.tsx`).
          Die Graph-Ansicht hat weder Seitenbaum noch Info-Leiste — dort gäbe
          es nichts zu schalten, also auch kein Register. */}
      <div className={variant === 'graph' ? 'shell shell-graph' : 'shell'}>
        {variant === 'graph' ? null : <PaneEdges />}
        {sidebar}
        {children}
      </div>
      {/* Nur unter der Telefon-Schwelle sichtbar (#64/#66, `66-telefon.css`). */}
      {variant === 'graph' ? null : <PhoneBar />}
    </>
  )
}
