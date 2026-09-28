/**
 * Reine (DOM-freie) Helfer der Leseansicht — hier isoliert, damit die
 * pfad-/locale-abhängige Logik ohne React unit-testbar ist (`lib/**`).
 */

import type { Locale, T } from './i18n/types.js'
import { wikiSpaceHref } from './urls'

export interface Crumb {
  label: string
  /** Nur gesetzt, wenn das Segment ein bekanntes Ziel hat (aktuell nur der Space). */
  href?: string
}

/** Ersetzt `-`/`_` durch Leerzeichen (Pfadsegmente lesbar machen). */
function humanizeSegment(seg: string): string {
  return seg.replace(/[-_]+/g, ' ').trim()
}

/**
 * Breadcrumb aus dem Repo-Pfad der Seite. Erstes Element = Space (verlinkt auf
 * die Space-Startseite), mittlere Elemente = Verzeichnisse des Pfads (nur Text —
 * für Ordner ist keine Seiten-Id bekannt), letztes Element = Seitentitel. Das
 * letzte Pfadsegment (die Datei selbst) wird durch den Titel ersetzt.
 *
 * Bugfix „Breadcrumb-Redundanz": liegt eine Seite in einem gleichnamigen
 * Verzeichnis (z. B. `kerneltausch-alt/index.md` mit Titel „Kerneltausch
 * alt"), stünde Ordner-Krümel UND Titel-Krümel identisch nebeneinander — der
 * LETZTE Verzeichnis-Krümel entfällt deshalb, wenn er (humanisiert,
 * case-insensitiv) dem Titel entspricht. Alle anderen Verzeichnis-Krümel
 * bleiben unverändert.
 */
export function buildBreadcrumb(space: string, path: string, title: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: space, href: wikiSpaceHref(space) }]
  const dirs = path.split('/').filter(Boolean).slice(0, -1)
  const lastDir = dirs.at(-1)
  const dirsToRender =
    lastDir !== undefined && humanizeSegment(lastDir).toLowerCase() === title.toLowerCase() ? dirs.slice(0, -1) : dirs
  for (const dir of dirsToRender) {
    crumbs.push({ label: humanizeSegment(dir) })
  }
  crumbs.push({ label: title })
  return crumbs
}

/** Eine Überschrift, wie sie `GET /api/pages/:id` im Feld `headings` liefert
 *  (Strukturkopie von `components/page-view.tsx#PageHeading` — dieses Modul
 *  bleibt React-frei und importiert deshalb nichts aus `components/**`). */
interface HeadingLike {
  depth: number
  slug: string
}

/**
 * Abschnitts-Slugs für die Positionsanzeige des Kolumnentitels („Abschnitt 3
 * von 6", `components/reading-position.tsx`).
 *
 * Gezählt werden die Überschriften der GANZEN Seite — genau das ist die Falle
 * dieses Features: ein Zähler über das gerade gerenderte DOM zählt im
 * Review-Diff nur die GEÄNDERTEN Überschriften und liefert falsche Nummern.
 * Grundlage ist deshalb die Überschriftenliste der API (vollständige Seite),
 * dieselbe Quelle wie das Inhaltsverzeichnis der rechten Leiste
 * (`components/rail.tsx`, dort `depth >= 2`).
 *
 * „Abschnitt" ist die OBERSTE im Inhalt vorkommende Gliederungsebene: in der
 * Regel `h2` (`h1` ist der Seitentitel), bei Seiten, die erst bei `h3`
 * beginnen, eben `h3`. Ohne Überschriften bleibt die Liste leer — dann
 * entfällt die Positionsanzeige ganz, statt „Abschnitt 1 von 0" zu behaupten.
 */
export function sectionSlugs(headings: readonly HeadingLike[]): string[] {
  const inToc = headings.filter((h) => h.depth >= 2)
  if (inToc.length === 0) return []
  const topDepth = Math.min(...inToc.map((h) => h.depth))
  return inToc.filter((h) => h.depth === topDepth).map((h) => h.slug)
}

const KNOWN_RELATION_TYPES = [
  'depends_on',
  'supersedes',
  'superseded_by',
  'related',
  'parent',
  'child',
  'references',
] as const
type KnownRelationType = (typeof KNOWN_RELATION_TYPES)[number]

function isKnownRelationType(type: string): type is KnownRelationType {
  return (KNOWN_RELATION_TYPES as readonly string[]).includes(type)
}

/** Menschlich lesbares Label für einen Relationstyp (übersetzt über `read.relations.*`,
 *  Fallback für unbekannte Typen: humanisiert, sprachneutral — die Relations-
 *  Rohwerte kommen aus der Frontmatter und sind kein Übersetzungsgegenstand). */
export function relationLabel(t: T, type: string): string {
  if (isKnownRelationType(type)) return t(`read.relations.${type}`)
  const human = humanizeSegment(type)
  return human.charAt(0).toUpperCase() + human.slice(1)
}

/** ISO-Zeitstempel → lokalisiertes Datum „TT.MM.JJJJ" (`de`) bzw. `locale`-
 *  entsprechend (`en` → „MM/DD/YYYY"). Ungültiger Wert → Rohwert. */
export function formatUpdatedAt(iso: string, locale: Locale): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
}

/**
 * Status-Label für die rechte Info-Leiste (`<Rail status=…>`, Phase 2d Task
 * 6) — bewusst dieselbe Priorität wie der Toolbar-Chip in `page-view.tsx`
 * (`workflow.state` schlägt `archived`): ohne das würden Chip und
 * Metadaten-Zeile widersprüchliche Auskünfte zeigen (Chip „Entwurf", Leiste
 * weiterhin „Released"). `workflow` ist nur für Schreibberechtigte gesetzt
 * (s. `apps/api/src/routes/pages.ts#resolveWorkflowField`) — für alle
 * anderen bleibt es beim reinen `archived`-Fall.
 */
export function pageStatusLabel(t: T, archived: boolean, workflowState: 'working' | 'review' | null): string {
  if (workflowState === 'review') return t('read.status.review')
  if (workflowState === 'working') return t('read.status.draft')
  return archived ? t('read.status.archived') : t('read.status.released')
}
