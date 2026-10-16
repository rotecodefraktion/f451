// LibreOffice writes list levels in ways turndown reads badly: lists directly
// inside lists, items that only wrap a deeper list, paragraphs inside items
// (loose lists) and, in the Impress export, one `<ul>` per outline level as
// siblings. Lists are flattened to (level, content) items and rebuilt as plain
// nested lists.

import { el, isBlank, isElement, isList, type HElement, type HNode } from './hast.js'

interface Item {
  level: number
  ordered: boolean
  content: HNode[]
}

/** Inline content of an item: paragraphs are unwrapped, separated by `<br>`. */
function inlineContent(nodes: HNode[]): HNode[] {
  const out: HNode[] = []
  for (const n of nodes) {
    if (isElement(n, 'p')) {
      if (isBlank(n)) continue
      if (out.length) out.push(el('br'))
      out.push(...n.children)
    } else if (!(n.type === 'text' && out.length === 0 && !(n.value ?? '').trim())) out.push(n)
  }
  // Whitespace after the last text (e.g. after Impress's `odfLiEnd` span)
  // would end the Markdown item with a trailing space.
  while (out.length) {
    const last = out[out.length - 1]
    if (last.type !== 'text') break
    const value = (last.value ?? '').trimEnd()
    if (value) {
      out[out.length - 1] = { ...last, value }
      break
    }
    out.pop()
  }
  return out
}

function flatten(list: HElement, level: number, items: Item[]): void {
  const ordered = list.tagName === 'ol'
  for (const child of list.children) {
    if (isList(child)) {
      flatten(child, level + 1, items)
      continue
    }
    if (!isElement(child, 'li')) continue
    const numbered = ordered || child.properties.dataF451Numbered === true || child.properties.dataF451Numbered === 'true'
    let pending: HNode[] = []
    const flush = (): void => {
      const content = inlineContent(pending)
      pending = []
      if (content.length && !content.every(isBlank)) items.push({ level, ordered: numbered, content })
    }
    for (const c of child.children) {
      if (isList(c)) {
        flush()
        flatten(c, level + 1, items)
      } else pending.push(c)
    }
    flush()
  }
}

function rebuild(items: Item[], start: unknown): HElement {
  const rootTag = items[0]?.ordered ? 'ol' : 'ul'
  const root = el(rootTag, rootTag === 'ol' && start !== undefined ? { start } : {})
  const stack: Array<{ level: number; list: HElement; last: HElement | null }> = [{ level: 0, list: root, last: null }]
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].level > item.level) stack.pop()
    while (stack[stack.length - 1].level < item.level) {
      const top = stack[stack.length - 1]
      let li = top.last
      if (!li) {
        li = el('li')
        top.list.children.push(li)
        top.last = li
      }
      const nested = el(item.ordered ? 'ol' : 'ul')
      li.children.push(nested)
      stack.push({ level: top.level + 1, list: nested, last: null })
    }
    const top = stack[stack.length - 1]
    const li = el('li', {}, item.content)
    top.list.children.push(li)
    top.last = li
  }
  return root
}

/** Normalises every list below `root`. With `mergeSiblings`, consecutive
 *  sibling lists (only whitespace between them) become one list. */
export function normaliseLists(root: HElement, mergeSiblings: boolean): void {
  const visit = (node: HElement): void => {
    const out: HNode[] = []
    const children = node.children
    for (let i = 0; i < children.length; i++) {
      const c = children[i]
      if (!isList(c)) {
        if (isElement(c)) visit(c)
        out.push(c)
        continue
      }
      const run: HElement[] = [c]
      if (mergeSiblings) {
        let j = i + 1
        while (j < children.length) {
          const n = children[j]
          if (isList(n)) run.push(n)
          else if (!(n.type === 'text' && !(n.value ?? '').trim())) break
          j++
        }
        // Whitespace after the last list in the run stays.
        while (j > i + 1 && !isList(children[j - 1])) j--
        i = j - 1
      }
      const items: Item[] = []
      for (const list of run) flatten(list, 0, items)
      if (items.length === 0) continue
      const minLevel = Math.min(...items.map((it) => it.level))
      for (const it of items) it.level -= minLevel
      out.push(rebuild(items, c.properties.start))
    }
    node.children = out
  }
  visit(root)
}

/** A list (LibreOffice's heading numbering) holding nothing but headings →
 *  those headings; null otherwise. */
export function headingsOnly(list: HElement): HElement[] | null {
  const out: HElement[] = []
  for (const child of list.children) {
    if (isBlank(child) && !isElement(child)) continue
    if (isList(child)) {
      const inner = headingsOnly(child)
      if (!inner) return null
      out.push(...inner)
      continue
    }
    if (!isElement(child, 'li')) return null
    for (const c of child.children) {
      if (c.type === 'text' && !(c.value ?? '').trim()) continue
      if (c.type === 'comment') continue
      if (isElement(c) && /^h[1-6]$/.test(c.tagName)) out.push(c)
      else if (isList(c)) {
        const inner = headingsOnly(c)
        if (!inner) return null
        out.push(...inner)
      } else return null
    }
  }
  return out.length ? out : null
}

/** Replaces heading-only lists anywhere below `root` by their headings. */
export function unwrapHeadingLists(root: HElement): void {
  const visit = (node: HElement): void => {
    const out: HNode[] = []
    for (const c of node.children) {
      if (isList(c)) {
        const headings = headingsOnly(c)
        if (headings) {
          out.push(...headings)
          continue
        }
      }
      if (isElement(c)) visit(c)
      out.push(c)
    }
    node.children = out
  }
  visit(root)
}
