'use client'

import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n/provider.js'
import { filterTree, type FilterNode } from '../lib/tree-filter.js'

/** The DOM pieces of one tree node, found via the `data-node-id` that
 *  `components/tree.tsx` puts on each `.node-row`. */
interface NodeElements {
  /** What gets `hidden`: the per-sibling wrapper of `SiblingList`
   *  (`components/tree-dnd.tsx`), which holds the whole node incl. subtree. */
  item: HTMLElement
  /** The `<details>` of a node with children, `null` for a leaf. */
  details: HTMLDetailsElement | null
}

function collectNodes(root: HTMLElement): Map<string, NodeElements> {
  const map = new Map<string, NodeElements>()
  for (const row of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const id = row.dataset.nodeId
    if (!id) continue
    const item = row.closest<HTMLElement>('[draggable]') ?? row
    // A branch's row sits in `<summary>` directly under its `<details>`; a
    // leaf's row must not pick up the `<details>` of its parent.
    const summary = row.parentElement
    const details =
      summary?.tagName === 'SUMMARY' && summary.parentElement instanceof HTMLDetailsElement ? summary.parentElement : null
    map.set(id, { item, details })
  }
  return map
}

/** Ids of visible nodes that have a visible child — the branches that must be
 *  open so the matches below them can be seen. */
function openIds(nodes: readonly FilterNode[], visible: ReadonlySet<string>): Set<string> {
  const open = new Set<string>()
  const walk = (list: readonly FilterNode[]) => {
    for (const node of list) {
      if (!visible.has(node.id)) continue
      if (node.children.some((child) => visible.has(child.id))) open.add(node.id)
      walk(node.children)
    }
  }
  walk(nodes)
  return open
}

/**
 * Filter field above the page tree. Client island over the server-rendered
 * tree (`components/tree.tsx`): it does not re-render the tree, it only sets
 * the `hidden` attribute on non-matching nodes and opens the branches leading
 * to matches. `hidden` rather than a class with `display: none`, because
 * filtered nodes are meant to leave the accessibility tree too.
 *
 * The open state of every branch is remembered when filtering starts and
 * restored once the query is empty again. Note that opening a `<details>`
 * fires `toggle`, which `TreeBranch` (`components/tree-expansion.tsx`) records
 * — the restore toggles it back, so the stored expansion ends up unchanged.
 */
export function TreeFilter({ nodes }: { nodes: readonly FilterNode[] }) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  /** Open state before filtering began; `null` while not filtering. */
  const savedOpen = useRef<Map<string, boolean> | null>(null)

  // Only the content of the node list matters — it is a new array on every
  // server render (same reasoning as `nodesKey` in `tree-expansion.tsx`).
  const nodesKey = JSON.stringify(nodes)

  useEffect(() => {
    // The island renders inside the tree's container, next to the root list.
    const root = inputRef.current?.parentElement
    if (!root) return
    const elements = collectNodes(root)
    const visible = filterTree(nodes, query)

    if (visible === null) {
      for (const { item } of elements.values()) item.hidden = false
      const saved = savedOpen.current
      if (saved) {
        for (const [id, { details }] of elements) {
          const wasOpen = saved.get(id)
          if (details && wasOpen !== undefined && details.open !== wasOpen) details.open = wasOpen
        }
        savedOpen.current = null
      }
      return
    }

    if (!savedOpen.current) {
      const saved = new Map<string, boolean>()
      for (const [id, { details }] of elements) if (details) saved.set(id, details.open)
      savedOpen.current = saved
    }
    const saved = savedOpen.current
    const open = openIds(nodes, visible)
    for (const [id, { item, details }] of elements) {
      item.hidden = !visible.has(id)
      if (!details) continue
      // Branches no longer leading to a match fall back to their prior state.
      const shouldOpen = open.has(id) || (saved.get(id) ?? false)
      if (details.open !== shouldOpen) details.open = shouldOpen
    }
    // `nodes` is covered by `nodesKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, nodesKey])

  const label = t('actions.tree.filter.placeholder')
  return (
    <input
      ref={inputRef}
      type="search"
      className="input tree-filter"
      placeholder={label}
      aria-label={label}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && query !== '') {
          event.preventDefault()
          setQuery('')
        }
      }}
    />
  )
}
