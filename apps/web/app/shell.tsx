import { BrandMark } from '../components/brand-mark'
import type { ReactNode } from 'react'
import { SearchDialog, SearchTrigger } from '../components/search-dialog'
import { ShortcutsDialog } from '../components/shortcuts-dialog'
import { SpaceSwitcher, type SpaceSwitcherSpace } from '../components/space-switcher'
import { LegalLinks } from '../components/legal-links'
import { getT } from '../lib/i18n/server.js'
import { getBrand, getFrame } from '../lib/resolved-theme.js'
import { LangSwitcher } from './lang-switcher.js'
import { PaneBarToggle } from './pane-bar-toggle'
import { PaneEdges } from './pane-edges'
import { PhoneBar } from './phone-bar'
import { ThemeToggle } from './theme-toggle'

/** The top bar controls as two rows of the tree when the top bar is off. */
export interface TreeChrome {
  /** Brand + space switcher, then the search field — above the tree's `.head`. */
  head: ReactNode
  /** Language, light/dark, account — directly above `<Attribution>`. */
  foot: ReactNode
}

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
  /**
   * Linke Spalte: Seitenbaum. Soll eine eigene `.tree`-Struktur liefern (Task 3).
   * As a function it receives the tree chrome: `null` while the top bar is
   * shown, otherwise the head and foot rows the tree renders (above its `.head`
   * and directly above `<Attribution>`).
   */
  sidebar?: ReactNode | ((chrome: TreeChrome | null) => ReactNode)
  /** The page renders a tree that places the `TreeChrome` slots. Only then may
   *  the theme switch the top bar off (`frameShape`). */
  hasTree?: boolean
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
export async function Shell({
  space,
  spaces,
  currentSpaceId,
  avatar,
  sidebar,
  hasTree = false,
  children,
  variant = 'default',
}: ShellProps) {
  const { locale, t } = await getT()
  // Brand of the instance/space (addendum §5): the logo replaces the f451 mark,
  // the name the word. Same per-request call as the root layout.
  const brand = await getBrand()
  const frame = await getFrame({ hasTree })
  // `--pane-controls: topbar` (frameShape guarantees the top bar is there):
  // the pane switches sit in the top bar instead of the edge grips. The graph
  // view has no panes, so it gets neither.
  const barPanes = variant !== 'graph' && frame.paneControls === 'topbar'

  const brandBlock = (
    <div className="brand">
      <a className="brand-home" href="/wiki" aria-label={t('shell.topbar.homeAriaLabel')}>
        {brand?.logoUrl ? (
          <img src={brand.logoUrl} alt={brand.name ?? 'f451'} className="brand-logo" />
        ) : (
          <span className="mark">
            <BrandMark />
          </span>
        )}
        <span className="brand-wort">{brand?.name ?? 'f451'}</span>
      </a>
    </div>
  )
  // Bewusst AUSSERHALB von `.brand` (das per `overflow: hidden` seinen Inhalt
  // beschneidet): der `SpaceSwitcher` öffnet ein absolut positioniertes
  // Dropdown, das sonst am `.brand`-Rand geclippt würde (Bugfix
  // „Space-Switcher-Dropdown geclippt").
  const spaceControl =
    spaces && spaces.length >= 2 ? (
      <SpaceSwitcher spaces={spaces} currentSpaceId={currentSpaceId} />
    ) : space ? (
      <span className="app">{space}</span>
    ) : null

  // Without a top bar (structure spec 2) brand, space and search move into the
  // tree head, language, light/dark and account into the tree foot.
  const chrome: TreeChrome | null = frame.topbar
    ? null
    : {
        head: (
          <div className="tree-head">
            <div className="tree-head-row">
              {brandBlock}
              {spaceControl}
            </div>
            <SearchTrigger variant="field" />
          </div>
        ),
        foot: (
          <div className="tree-foot">
            <LangSwitcher locale={locale} />
            <ThemeToggle />
            <LegalLinks />
            {avatar}
          </div>
        ),
      }

  return (
    <>
      {frame.topbar ? (
        <header className="topbar">
          {brandBlock}
          {spaceControl}
          <div className="grow" />
          {/* Pane switches around the search, in reading order: the tree's
              switch left of it, the info sidebar's right of it. */}
          {barPanes ? <PaneBarToggle pane="nav" shortcuts /> : null}
          <SearchDialog />
          {barPanes ? <PaneBarToggle pane="rail" /> : null}
          {/* Nur der Dialog, ohne sichtbaren Auslöser — geöffnet wird er per `?`
              oder per CustomEvent aus der Werkzeugliste der linken Leiste. Er
              hängt hier, weil er auf JEDER Seite der Schale erreichbar sein
              muss (s. components/shortcuts-dialog.tsx). */}
          <ShortcutsDialog />
          <LangSwitcher locale={locale} />
          <ThemeToggle />
          <LegalLinks />
          {avatar}
        </header>
      ) : (
        <>
          {/* The phone layout is unchanged for every frame switch: below the
              phone threshold this bar is shown and the tree chrome rows are
              hidden; above it the reverse (`60-chrome-topbar.css`). Its search
              field fires the open event, so the dialog below exists once. */}
          <header className="topbar topbar-phone">
            {brandBlock}
            {spaceControl}
            <div className="grow" />
            <SearchTrigger />
            <LangSwitcher locale={locale} />
            <ThemeToggle />
            <LegalLinks />
            {avatar}
          </header>
          {/* Both dialogs outside the header: a dialog inside a `display: none`
              ancestor would not show even in the top layer. */}
          <SearchDialog trigger={false} />
          <ShortcutsDialog />
        </>
      )}

      {/* Fünf-Spalten-Raster (Erscheinungsbild 2026): Daumenregister links ·
          Seitenbaum · Dokument · Info-Leiste · Daumenregister rechts. Die
          Register stehen ZUERST im Quelltext — links und rechts unmittelbar
          nebeneinander —, damit der Tabulator-Lauf der räumlichen Anordnung
          folgt (zugesicherte Eigenschaft 7). Ihre Spalten stehen in jeder
          Fensterbreite; welche Leiste offen ist, entscheidet `data-nav`/
          `data-rail` am `<html>`-Element (s. `pane-edges.tsx`).
          Die Graph-Ansicht hat weder Seitenbaum noch Info-Leiste — dort gäbe
          es nichts zu schalten, also auch kein Register. */}
      {/* Every class string is spelled out in full: `pnpm css:inventar` only
          finds class names that appear literally inside `className`. */}
      <div
        className={
          variant === 'graph'
            ? 'shell shell-graph'
            : frame.topbar
              ? barPanes
                ? 'shell shell-bar-panes'
                : 'shell'
              : barPanes
                ? 'shell shell-no-topbar shell-bar-panes'
                : 'shell shell-no-topbar'
        }
      >
        {variant === 'graph' || barPanes ? null : <PaneEdges searchOnEdge={!frame.topbar} />}
        {typeof sidebar === 'function' ? sidebar(chrome) : sidebar}
        {children}
      </div>
      {/* Nur unter der Telefon-Schwelle sichtbar (#64/#66, `66-telefon.css`). */}
      {variant === 'graph' ? null : <PhoneBar />}
    </>
  )
}
