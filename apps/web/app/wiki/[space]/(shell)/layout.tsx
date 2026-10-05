import type { ReactNode } from 'react'
import { Attribution } from '../../../../components/attribution'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AccountMenu } from '../../../../components/account-menu'
import { NewPageButton } from '../../../../components/new-page-button'
import { ToolTrigger } from '../../../../components/tool-trigger'
import { Tree, type TreeNodeData } from '../../../../components/tree'
import { ApiError, apiFetch } from '../../../../lib/api'
import { getT } from '../../../../lib/i18n/server.js'
import { getMe } from '../../../../lib/session'
import {
  apiSpaceTreePath,
  decodeRouteParam,
  wikiGraphHref,
  wikiMetadataSchemaHref,
  wikiReportHref,
  wikiSpaceHref,
  wikiTemplatesHref,
} from '../../../../lib/urls'
import { Shell, type TreeChrome } from '../../../shell'

interface SpaceSummary {
  id: string
  name: string
  defaultLang: string
}

/** Werkzeug-Icons (Redesign Phase 2, Handoff „Sidebar" — 1:1 aus
 *  `f451 Knowledge Base.dc.html`), im selben `.nav a svg`-Vokabular wie die
 *  Seitenbaum-Icons (`components/tree.tsx`): stroke `currentColor`, Opacity
 *  kommt aus der `.nav a svg`-Regel in `globals.css`. */
const GRAPH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <circle cx="5" cy="6" r="2.5" />
    <circle cx="19" cy="6" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <path d="M6.5 7.5 11 16m2-8-4.5 8.5M7 6h10" />
  </svg>
)

const REPORT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
  </svg>
)

const SCHEMA_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 4v16" />
  </svg>
)

const TEMPLATES_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

/** Die Lupe ist dieselbe Zeichnung wie am Topbar-Trigger
 *  (`components/search-dialog.tsx`) — dort mit Strichstärke 2, hier auf die
 *  1.8 der übrigen Werkzeug-Icons gebracht, damit die sieben Zeilen ein
 *  einheitliches Bild geben. */
const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" strokeLinecap="round" />
  </svg>
)

/** Stecker in der Buchse — „Verbindungen" sind die Zugänge, über die sich
 *  fremde Werkzeuge (KI-Agenten) an den Space anschließen. */
const CONNECTIONS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path d="M9 3v5M15 3v5" />
    <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" />
    <path d="M12 17v4" />
  </svg>
)

/** Kreis, senkrecht geteilt — das gebräuchliche Zeichen für Hell/Dunkel und
 *  Kontrast. Bewusst nicht die Mondsichel: die trägt in der Kopfleiste bereits
 *  den Hell/Dunkel-Umschalter (`app/theme-toggle.tsx`), und das Erscheinungsbild
 *  ist mehr als der Moduswechsel. */
const APPEARANCE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" />
  </svg>
)

const SHORTCUTS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h1M10 10h1M14 10h1M18 10h1M8 14h8" />
  </svg>
)

/** Zählt einen Baum (inkl. aller Kinder) für die Sidebar-Kopfzeile ("N Seiten"). */
function countPages(nodes: TreeNodeData[]): number {
  let total = 0
  for (const node of nodes) {
    total += 1 + countPages(node.children)
  }
  return total
}

interface SpaceLayoutProps {
  children: ReactNode
  params: Promise<{ space: string }>
}

/**
 * Lädt Seitenbaum + Space-Metadaten für den ausgewählten Space und füllt den
 * Sidebar-Slot der `<Shell>`. Unbekannter/nicht zugänglicher Space → 404
 * (die API liefert für beide Fälle bewusst dieselbe Antwort, kein
 * Existenz-Orakel — siehe `apps/api/src/routes/pages.ts`).
 *
 * Eigene `getMe`-Instanz für den Avatar (siehe Architektur-Kommentar in
 * `wiki/layout.tsx`) — die Session ist durch das Eltern-Layout bereits
 * geprüft, ein erneuter `null`-Fall wird hier defensiv trotzdem behandelt.
 */
export default async function SpaceLayout({ children, params }: SpaceLayoutProps) {
  const { space: rawSpaceId } = await params
  // `params.space` ist noch URL-kodiert (Next.js dekodiert Dynamic-Segment-
  // Params NICHT automatisch, s. Kommentar in `lib/urls.ts`) — vor jedem
  // Vergleich mit API-Daten und vor jedem Weiterreichen an `apiFetch`/Hrefs
  // dekodieren (die Helfer aus `lib/urls.ts` kodieren beim Bauen einer URL
  // selbst wieder neu).
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString() || undefined
  const { t } = await getT()

  let me: Awaited<ReturnType<typeof getMe>>
  try {
    me = await getMe(cookieHeader)
  } catch {
    return (
      <main className="login-page">
        <div className="login-card card">
          <div className="callout error" role="alert">
            <span>Der Server ist aktuell nicht erreichbar.</span>
            <a href={wikiSpaceHref(spaceId)}>Erneut versuchen</a>
          </div>
        </div>
      </main>
    )
  }
  if (!me) {
    redirect(`/?next=${encodeURIComponent(wikiSpaceHref(spaceId))}`)
  }

  const avatar = <AccountMenu displayName={me.displayName} />

  let spaces: SpaceSummary[]
  let tree: TreeNodeData[]
  try {
    ;[spaces, tree] = await Promise.all([
      apiFetch<SpaceSummary[]>('/api/spaces', { cookie: cookieHeader }),
      apiFetch<TreeNodeData[]>(apiSpaceTreePath(spaceId), { cookie: cookieHeader }),
    ])
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    return (
      <Shell avatar={avatar}>
        <main className="main" style={{ padding: 'var(--space-6) var(--space-7)' }}>
          <div className="callout error" role="alert">
            <p>Der Server ist aktuell nicht erreichbar.</p>
            <div className="btn-row">
              <a href={wikiSpaceHref(spaceId)}>Erneut versuchen</a>
            </div>
          </div>
        </main>
      </Shell>
    )
  }

  const space = spaces.find((s) => s.id === spaceId)
  if (!space) {
    notFound()
  }

  const pageCount = countPages(tree)
  // A function of the tree chrome: without a top bar the Shell hands over the
  // head row (brand, space, search) and the foot row (language, light/dark,
  // account); with a top bar `chrome` is null.
  const sidebar = (chrome: TreeChrome | null) => (
    // `id="pane-nav"` ist das Ziel des `aria-controls` am linken Daumenregister
    // (`app/pane-edges.tsx`) — der Schalter, der diese Leiste ein- und
    // ausklappt.
    <nav className="tree" id="pane-nav" aria-label={t('sidebar.treeAriaLabel', { space: space.name })}>
      {chrome?.head}
      <div className="head">
        <span className="sq">{space.name.charAt(0).toUpperCase() || '?'}</span>
        <div>
          <b>{space.name}</b>
          <small>
            {t('sidebar.pageCount', { count: pageCount })} · {t('sidebar.spaceLabel')}
          </small>
        </div>
        <NewPageButton space={spaceId} />
      </div>
      <div className="grp">{t('sidebar.pagesGroup')}</div>
      {tree.length > 0 ? (
        <Tree space={spaceId} nodes={tree} />
      ) : (
        <p style={{ padding: '0 var(--space-3) var(--space-3)', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
          {t('sidebar.empty')}
        </p>
      )}
      {/* Werkzeugliste: drei Gruppen, sieben zweizeilige Zeilen (Titel plus
          Erklärsatz). Der `.nav`-Wrapper wiederverwendet dieselben Zeilen-
          Styles wie der Seitenbaum (Radius/Hover/Icon-Opacity); die zweite
          Zeile trägt `.tool` (s. `app/styles/60-chrome-raster.css`).

          Je Gruppe ein eigener `.nav`-Wrapper, die Gruppentitel bleiben
          direkte Geschwister von „Seiten" — nur so greift die Regel
          `.grp ~ .grp` mit dem größeren Abstand vor jeder Folgegruppe. */}
      <div className="grp">{t('sidebar.toolGroups.find')}</div>
      <div className="nav">
        {/* Suche und Tastenkürzel führen nicht an einen Ort, sondern öffnen
            einen Dialog — deshalb Knöpfe, die ein Ereignis feuern, das der
            jeweilige Dialog an anderer Stelle im Baum aufnimmt. */}
        <ToolTrigger eventName="f451:open-search" className="tool" aria-label={t('sidebar.tools.search.label')}>
          {SEARCH_ICON}
          <span className="lbl">{t('sidebar.tools.search.label')}</span>
          <span className="kbd">⌘K</span>
          <span className="sub">{t('sidebar.tools.search.desc')}</span>
        </ToolTrigger>
        <Link className="tool" href={wikiGraphHref(spaceId)}>
          {GRAPH_ICON}
          <span className="lbl">{t('sidebar.tools.graph.label')}</span>
          <span className="sub">{t('sidebar.tools.graph.desc')}</span>
        </Link>
        <Link className="tool" href={wikiReportHref(spaceId)}>
          {REPORT_ICON}
          <span className="lbl">{t('sidebar.tools.report.label')}</span>
          <span className="sub">{t('sidebar.tools.report.desc')}</span>
        </Link>
      </div>
      <div className="grp">{t('sidebar.toolGroups.configure')}</div>
      <div className="nav">
        <Link className="tool" href={wikiTemplatesHref(spaceId)}>
          {TEMPLATES_ICON}
          <span className="lbl">{t('sidebar.tools.templates.label')}</span>
          <span className="sub">{t('sidebar.tools.templates.desc')}</span>
        </Link>
        <Link className="tool" href={wikiMetadataSchemaHref(spaceId)}>
          {SCHEMA_ICON}
          <span className="lbl">{t('sidebar.tools.schema.label')}</span>
          <span className="sub">{t('sidebar.tools.schema.desc')}</span>
        </Link>
        {/* Fester Pfad, kein Space-Helfer: die Verbindungen hängen am Konto,
            nicht am Space — dieselbe Adresse wie im Avatar-Menü
            (`components/account-menu.tsx`). */}
        <Link className="tool" href="/einstellungen/verbindungen">
          {CONNECTIONS_ICON}
          <span className="lbl">{t('sidebar.tools.connections.label')}</span>
          <span className="sub">{t('sidebar.tools.connections.desc')}</span>
        </Link>
        {/* Ebenfalls fester Pfad: das Erscheinungsbild hängt am Browser des
            Nutzers, nicht am Space. */}
        <Link className="tool" href="/einstellungen/erscheinungsbild">
          {APPEARANCE_ICON}
          <span className="lbl">{t('sidebar.tools.appearance.label')}</span>
          <span className="sub">{t('sidebar.tools.appearance.desc')}</span>
        </Link>
      </div>
      <div className="grp">{t('sidebar.toolGroups.help')}</div>
      <div className="nav">
        <ToolTrigger eventName="f451:open-shortcuts" className="tool" aria-label={t('sidebar.tools.shortcuts.label')}>
          {SHORTCUTS_ICON}
          <span className="lbl">{t('sidebar.tools.shortcuts.label')}</span>
          <span className="sub">{t('sidebar.tools.shortcuts.desc')}</span>
        </ToolTrigger>
      </div>
      {chrome?.foot}
      <Attribution />
    </nav>
  )

  return (
    <Shell space={space.name} spaces={spaces} currentSpaceId={spaceId} avatar={avatar} sidebar={sidebar} hasTree>
      {children}
    </Shell>
  )
}
