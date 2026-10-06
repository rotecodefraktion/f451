import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'

// Local, minimal hast node types instead of an @types/hast dependency (as in render.ts).
interface HNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
  value?: string
}

interface HElement extends HNode {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HNode[]
}

function isElement(node: HNode | undefined, tagName?: string): node is HElement {
  return node?.type === 'element' && (tagName === undefined || node.tagName === tagName)
}

/** Data attributes parse to `''`, so presence is checked, not truthiness. */
function hasProp(node: HElement, name: string): boolean {
  return node.properties[name] !== undefined && node.properties[name] !== null && node.properties[name] !== false
}

function findElement(node: HNode, test: (el: HElement) => boolean): HElement | undefined {
  for (const child of node.children ?? []) {
    if (isElement(child) && test(child)) return child
    const found = findElement(child, test)
    if (found) return found
  }
  return undefined
}

function forEachElement(node: HNode, fn: (el: HElement) => void): void {
  for (const child of node.children ?? []) {
    if (isElement(child)) fn(child)
    forEachElement(child, fn)
  }
}

function textContent(node: HNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textContent).join('')
}

function isBackref(node: HNode): boolean {
  return isElement(node, 'a') && hasProp(node, 'dataFootnoteBackref')
}

/** The li's single paragraph, ignoring backref anchors; undefined if the note has any
 *  other block content (then it stays in the list). */
function singleParagraph(li: HElement): HElement | undefined {
  const elements = li.children.filter((child) => isElement(child) && !isBackref(child))
  return elements.length === 1 && isElement(elements[0], 'p') ? elements[0] : undefined
}

/** Removes backref anchors from `node`'s children (recursively) and the whitespace
 *  that preceded them at the end of the container. */
function stripBackrefs(node: HNode): void {
  if (!node.children) return
  const before = node.children.length
  node.children = node.children.filter((child) => !isBackref(child))
  for (const child of node.children) stripBackrefs(child)
  if (node.children.length === before) return
  while (node.children.length > 0) {
    const last = node.children[node.children.length - 1]
    if (last.type !== 'text') break
    last.value = (last.value ?? '').trimEnd()
    if (last.value !== '') break
    node.children.pop()
  }
}

/** Moves single-paragraph GFM footnotes next to their first reference (margin-note mode).
 *  Pure. Returns the input unchanged when it has no `data-footnotes` section. */
export function placeFootnotes(html: string): string {
  if (!html.includes('data-footnotes')) return html

  const root = fromHtml(html, { fragment: true }) as unknown as HNode
  const topLevel = root.children ?? []
  // Matched by the section attribute, never by the label element: older index entries
  // still carry `h2#footnote-label` instead of `p.footnotes-title`.
  const section = findElement(root, (el) => el.tagName === 'section' && hasProp(el, 'dataFootnotes'))
  if (!section) return html
  const ol = findElement(section, (el) => el.tagName === 'ol')
  if (!ol) return html

  const wrappers = new Set<HElement>()
  const movedIds = new Set<string>()

  // Ordinal of every note before anything moves: the numbers in the text are fixed,
  // so a note that stays in the list must keep its number (`<li value>`).
  const items = ol.children.filter((child): child is HElement => isElement(child, 'li'))
  items.forEach((li, index) => { li.properties.value = index + 1 })

  for (const li of items) {
    if (typeof li.properties.id !== 'string') continue
    const noteId = li.properties.id
    const paragraph = singleParagraph(li)
    if (!paragraph) continue

    let ref: HElement | undefined
    let hostIndex = -1
    for (let i = 0; i < topLevel.length && !ref; i++) {
      const candidate = topLevel[i]
      if (candidate === section) continue
      const isRef = (el: HElement) =>
        el.tagName === 'a' && hasProp(el, 'dataFootnoteRef') && el.properties.href === `#${noteId}`
      ref = isElement(candidate) && isRef(candidate) ? candidate : findElement(candidate, isRef)
      if (ref) hostIndex = i
    }
    if (!ref) continue

    const top = topLevel[hostIndex] as HElement
    let wrapper: HElement
    if (wrappers.has(top)) {
      wrapper = top
    } else {
      wrapper = { type: 'element', tagName: 'div', properties: { className: ['note-host'] }, children: [top] }
      topLevel[hostIndex] = wrapper
      wrappers.add(wrapper)
    }

    stripBackrefs(paragraph)
    const refId = typeof ref.properties.id === 'string' ? ref.properties.id : ''
    const aside: HElement = {
      type: 'element',
      tagName: 'aside',
      properties: { className: ['note'], id: noteId, role: 'note' },
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: { className: ['note__label'], href: `#${refId}` },
          children: [{ type: 'text', value: textContent(ref) }],
        } as HElement,
        { type: 'text', value: ' ' },
        ...paragraph.children,
      ],
    }
    // The host is always the wrapper's last child; asides go before it in list order,
    // which is the order of first reference.
    wrapper.children.splice(wrapper.children.length - 1, 0, aside)

    ol.children = ol.children.filter((child) => child !== li)
    movedIds.add(noteId)
  }

  if (movedIds.size === 0) return html
  // No gaps: the untouched list numbers itself.
  if (ol.children.filter((child) => isElement(child, 'li')).length === items.length) {
    for (const li of items) delete li.properties.value
  }

  if (!ol.children.some((child) => isElement(child, 'li'))) {
    removeNode(root, section)
    // The label the refs described is gone with the section.
    forEachElement(root, (el) => {
      if (
        el.tagName === 'a'
        && hasProp(el, 'dataFootnoteRef')
        && typeof el.properties.href === 'string'
        && movedIds.has(el.properties.href.slice(1))
      ) {
        delete el.properties.ariaDescribedBy
      }
    })
  }

  return toHtml(root as never)
}

function removeNode(parent: HNode, target: HNode): boolean {
  if (!parent.children) return false
  const index = parent.children.indexOf(target)
  if (index !== -1) {
    parent.children.splice(index, 1)
    return true
  }
  return parent.children.some((child) => removeNode(child, target))
}
