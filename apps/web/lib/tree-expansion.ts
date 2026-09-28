import { wikiPageHref } from './urls.js'

/**
 * Aufklappzustand des Seitenbaums (`components/tree.tsx`).
 *
 * Bis hierher hatte der Baum GAR KEINEN Zustand: jeder Knoten mit Kindern
 * wurde als `<details open>` gerendert. Weil die Baum-Links gewöhnliche
 * `<a href>` sind (voller Seitenaufbau, s. `components/active-link.tsx`),
 * kam bei JEDEM Seitenwechsel frisches Server-HTML — und damit wieder
 * „alles offen". Der vom Nutzer zugeklappte Ast ging dabei verloren.
 *
 * Dieses Modul hält die reine Logik dahinter (Speicherformat, Vorfahren der
 * aktuellen Seite, Zusammenführen); der Zustand selbst lebt in der
 * Client-Insel `components/tree-expansion.tsx` und wird — wie der
 * Leisten-Zustand der Schale (`app/pane-edges.tsx`) — in `localStorage`
 * fortgeschrieben, damit er Seitenwechsel UND Neuladen übersteht.
 */

/** Knoten mit Kindern (strukturell kompatibel zu `TreeNodeData`). */
export interface TreeNodeLike {
  id: string
  children: readonly TreeNodeLike[]
}

/** Ein Knoten samt Elternknoten — alles, was die Zustandslogik braucht. */
export interface TreeNodeRef {
  id: string
  parentId: string | null
}

/**
 * Gespeicherter Zustand: NUR die Abweichungen vom Standard. Ein fehlender
 * Eintrag heißt „zu" (s. {@link isExpanded}) — ein frisch aufgerufener Space
 * zeigt damit seine oberste Ebene und nicht den ganzen ausgeklappten Baum.
 */
export type ExpansionState = Readonly<Record<string, boolean>>

/** Präfix des `localStorage`-Schlüssels — je Space ein eigener Eintrag, weil
 *  Seiten-Ids nur innerhalb eines Space eindeutig sind. */
export const TREE_EXPANSION_STORAGE_PREFIX = 'tree-open:'

export function treeExpansionStorageKey(space: string): string {
  return `${TREE_EXPANSION_STORAGE_PREFIX}${space}`
}

/** Liest das gespeicherte JSON defensiv: alles Unerwartete (kaputtes JSON,
 *  Array, Nicht-Boolean-Werte) fällt auf „nichts gespeichert" zurück statt
 *  den Baum zu verbiegen. */
export function parseExpansion(raw: string | null | undefined): ExpansionState {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const state: Record<string, boolean> = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'boolean') state[id] = value
  }
  return state
}

/** ZU ist der Standard — gespeichert wird nur, was der Nutzer aufgeklappt
 *  (oder wieder zugeklappt) hat.
 *
 *  Bis hierher war „offen" der Standard: Wer einen Space zum ersten Mal
 *  aufrufte oder den Space wechselte, bekam den vollständig ausgeklappten
 *  Baum — bei 69 Seiten eine Wand, in der die eigene Position untergeht. Der
 *  Ast zur aufgerufenen Seite kommt weiterhin auf, dafür sorgt
 *  {@link activeAncestorIds} zusammen mit {@link withExpanded}; die
 *  Orientierung geht also nicht verloren. */
export function isExpanded(state: ExpansionState, id: string): boolean {
  return state[id] ?? false
}

/** Flacht den Baum zu `{ id, parentId }` ab — die Form, die der Provider über
 *  die Server/Client-Grenze bekommt (serialisierbar, ohne Titel und Markup). */
export function toNodeRefs(nodes: readonly TreeNodeLike[], parentId: string | null = null): TreeNodeRef[] {
  const refs: TreeNodeRef[] = []
  for (const node of nodes) {
    refs.push({ id: node.id, parentId })
    refs.push(...toNodeRefs(node.children, node.id))
  }
  return refs
}

/**
 * Ids der Vorfahren der Seite, auf der wir gerade stehen (ohne die Seite
 * selbst) — der Ast, der aufgeklappt sein muss, damit man sieht, wo man ist.
 *
 * Verglichen wird gegen `wikiPageHref` (dieselbe Kodierung, die auch
 * `usePathname()` liefert, s. `components/active-link.tsx`). `pathname` darf
 * dabei Unterrouten der Seite tragen (`…/edit`, `…/review`) — das führende
 * `/` im Präfixvergleich verhindert, dass eine Id die eines anderen Knotens
 * mitmeint (`…/abc` vs. `…/abcd`).
 */
export function activeAncestorIds(
  nodes: readonly TreeNodeRef[],
  space: string,
  pathname: string | null | undefined,
): string[] {
  if (!pathname) return []
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]))
  const active = nodes.find((node) => {
    const href = wikiPageHref(space, node.id)
    return pathname === href || pathname.startsWith(`${href}/`)
  })
  if (!active) return []

  const ancestors: string[] = []
  const seen = new Set<string>([active.id])
  let current = active.parentId
  while (current !== null && current !== undefined && !seen.has(current)) {
    ancestors.push(current)
    seen.add(current)
    current = parentById.get(current) ?? null
  }
  return ancestors
}

/**
 * Klappt die genannten Äste auf, ohne den Rest anzufassen. Gibt den
 * UNVERÄNDERTEN Zustand zurück, wenn nichts zu tun ist (kein unnötiges
 * Schreiben in `localStorage`, kein unnötiges Neurendern).
 *
 * Seit „zu" der Standard ist, reicht die frühere Prüfung `=== false` nicht
 * mehr: Ein Knoten OHNE Eintrag ist jetzt ebenfalls zu und braucht seinen
 * expliziten `true`-Eintrag, sonst bliebe der Ast zur aufgerufenen Seite
 * geschlossen.
 */
export function withExpanded(state: ExpansionState, ids: readonly string[]): ExpansionState {
  const collapsed = ids.filter((id) => state[id] !== true)
  if (collapsed.length === 0) return state
  const next: Record<string, boolean> = { ...state }
  for (const id of collapsed) next[id] = true
  return next
}
