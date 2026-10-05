import { ActiveLink } from './active-link'
import { SiblingList } from './tree-dnd'
import { TreeBranch, TreeExpansionProvider } from './tree-expansion'
import { TreeFilter } from './tree-filter'
import { TreeNodeActions, type FlatNode } from './tree-node-actions'
import { getT } from '../lib/i18n/server.js'
import type { DotPaths, Params } from '../lib/i18n/format.js'
import type { Messages } from '../lib/i18n/types.js'
import { toNodeRefs } from '../lib/tree-expansion.js'
import { toFilterNodes } from '../lib/tree-filter.js'
import { wikiPageHref } from '../lib/urls'

/** Signatur des an `getT()` gebundenen `t()` — hier durchgereicht, da `Tree`
 *  eine Server Component ist (`await getT()` NUR im obersten `Tree`, nicht in
 *  jedem rekursiven `TreeNode`, s. Aufruf unten). */
type T = (key: DotPaths<Messages>, params?: Params) => string

/** Ein Knoten im Navigationsbaum eines Space (Shape aus `GET /api/spaces/:space/tree`). */
export interface TreeNodeData {
  id: string
  title: string
  path: string
  archived: boolean
  hasChildren: boolean
  children: TreeNodeData[]
}

export interface TreeProps {
  /** Space-ID, aus der die Ziel-URLs (`/wiki/<space>/<pageId>`) gebaut werden. */
  space: string
  nodes: TreeNodeData[]
}

const DOC_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 5h16M4 12h16M4 19h10" strokeLinecap="round" />
  </svg>
)

const ARCHIVE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M3 7h18v3H3zM5 10v9h14v-9M9 13h6" strokeLinejoin="round" />
  </svg>
)

const CARET_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * Seitenbaum (Mockup-Klassen `.nav a` / `.active` / `.archived` / `.badge.arch`
 * aus `docs/design/mockups/leseansicht.html`). Server Component: Baum-Markup
 * und Rekursion laufen serverseitig; nur die Aktiv-Markierung braucht den
 * Browser-Pfad (`usePathname`) und ist deshalb in die Client-Insel
 * `<ActiveLink>` ausgelagert (`components/active-link.tsx`) — Finding 2,
 * Task 3 Review: die ursprüngliche Version machte wegen dieses einen Bits den
 * gesamten Baum zur Client-Komponente; die Aufteilung ist hier (anders als
 * z. B. bei `<Shell>`, wo Slot-Daten die Trennung erschweren würden) ohne
 * Mehraufwand möglich und folgt demselben Muster wie `app/theme-toggle.tsx`
 * und `components/account-menu.tsx`.
 *
 * Auf-/Zuklappen nutzt natives `<details>`/`<summary>`; geöffnet ist per
 * Default jeder Knoten mit Kindern. Welche Knoten AKTUELL offen sind, hält
 * `components/tree-expansion.tsx` (Logik in `lib/tree-expansion.ts`) — bis
 * dahin stand `open` fest auf `true`, wodurch der vom Nutzer zugeklappte Ast
 * bei jedem Seitenwechsel wieder aufsprang (die Baum-Links sind gewöhnliche
 * `<a href>`, jeder Klick ist ein voller Seitenaufbau). Ein Klick auf den Link
 * stoppt die Event-Propagation, damit derselbe Klick nicht zugleich das
 * umgebende `<summary>` toggelt.
 */
/** Flacht den Baum für den Ziel-Parent-Picker im Verschieben-Dialog
 *  (`tree-node-actions.tsx`) — derselbe Baum, den `Tree` ohnehin schon
 *  rendert, einmal an der Wurzel flachgeklopft statt für jeden Knoten neu
 *  aus der API nachgeladen. */
function flattenNodes(nodes: readonly TreeNodeData[], depth: number): FlatNode[] {
  const result: FlatNode[] = []
  for (const node of nodes) {
    result.push({ id: node.id, title: node.title, path: node.path, depth })
    result.push(...flattenNodes(node.children, depth + 1))
  }
  return result
}

export async function Tree({ space, nodes }: TreeProps) {
  const { t } = await getT()
  const allNodes = flattenNodes(nodes, 0)
  return (
    <TreeExpansionProvider space={space} nodes={toNodeRefs(nodes)}>
      <TreeFilter nodes={toFilterNodes(nodes)} />
      <SiblingList space={space} parentId={null} childIds={nodes.map((node) => node.id)}>
        {nodes.map((node) => (
          <TreeNode key={node.id} node={node} space={space} depth={0} allNodes={allNodes} t={t} />
        ))}
      </SiblingList>
    </TreeExpansionProvider>
  )
}

function TreeNode({
  node,
  space,
  depth,
  allNodes,
  t,
}: {
  node: TreeNodeData
  space: string
  depth: number
  allNodes: readonly FlatNode[]
  t: T
}) {
  const href = wikiPageHref(space, node.id)
  const classes = node.archived ? 'archived' : undefined

  // Space-Startseite (Wurzel-`index.md`, `depth === 0` — die API liefert als
  // oberste Baum-Ebene ausschließlich Seiten OHNE Hierarchie-Elternseite, das
  // ist praktisch immer genau die Startseite): „Umbenennen"/„Verschieben"
  // erscheinen dort gar nicht erst (der Server lehnt sie mit 400 ab,
  // `RootPageMoveError` — kein Grund, die Buttons überhaupt anzuzeigen).
  const isSpaceRoot = depth === 0

  const link = (
    <ActiveLink
      href={href}
      className={classes}
      title={node.archived ? t('actions.tree.archivedTitle', { title: node.title }) : undefined}
      style={{ paddingLeft: 'var(--space-3)' }}
      stopClickPropagation
    >
      {node.archived ? ARCHIVE_ICON : DOC_ICON}
      <span className="lbl">{node.title}</span>
      {node.archived ? <span className="chip archived">{t('actions.tree.archivedBadge')}</span> : null}
    </ActiveLink>
  )

  // Umbenennen/Verschieben (Phase 3.2) — eigene Zeile aus Link + Aktionen,
  // damit die Klick-Buttons NICHT innerhalb des `<a>` sitzen (kein
  // verschachteltes interaktives Element) und per Hover (`.node-row:hover
  // .node-actions`, `app/globals.css`) ein-/ausgeblendet werden können.
  // `data-node-id` is the hook for the filter island (`tree-filter.tsx`),
  // which hides nodes in the DOM instead of re-rendering the tree.
  const row = (
    <div className="node-row" data-node-id={node.id}>
      {link}
      {isSpaceRoot ? null : (
        <TreeNodeActions space={space} node={{ id: node.id, title: node.title, path: node.path }} allNodes={allNodes} />
      )}
    </div>
  )

  if (!node.hasChildren) {
    return row
  }

  return (
    <TreeBranch
      nodeId={node.id}
      summary={
        <>
          <span className="caret">{CARET_ICON}</span>
          {row}
        </>
      }
    >
      {/* `.kids` carries the indentation of a nesting level (and the guide line
          of `--tree-guides`, 60-chrome-raster.css); not interactive. */}
      <div className="kids">
        <SiblingList space={space} parentId={node.id} childIds={node.children.map((child) => child.id)}>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} space={space} depth={depth + 1} allNodes={allNodes} t={t} />
          ))}
        </SiblingList>
      </div>
    </TreeBranch>
  )
}
