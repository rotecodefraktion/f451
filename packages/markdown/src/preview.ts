import { fromHtml } from 'hast-util-from-html'

// Local, minimal hast node types instead of an @types/hast dependency (as in footnotes.ts).
interface HNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
  value?: string
}

const PREVIEW_MAX = 300
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
/** The default sanitize schema prefixes ids with this; render.ts disables that for ids,
 *  but older index entries may still carry it. */
const CLOBBER_PREFIX = 'user-content-'

type Block = { kind: 'heading'; level: number; id: string | null } | { kind: 'paragraph'; text: string }

function isFootnoteSection(node: HNode): boolean {
  if (node.tagName !== 'section') return false
  const props = node.properties ?? {}
  const dataFootnotes = props.dataFootnotes
  if (dataFootnotes !== undefined && dataFootnotes !== null && dataFootnotes !== false) return true
  const className = props.className
  return Array.isArray(className) && className.includes('footnotes')
}

/** Text content, skipping `sup` (footnote references). */
function textOf(node: HNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'element' && node.tagName === 'sup') return ''
  return (node.children ?? []).map(textOf).join('')
}

/** Headings and non-empty paragraphs in document order; footnotes are skipped. */
function collectBlocks(node: HNode, out: Block[]): void {
  for (const child of node.children ?? []) {
    if (child.type !== 'element' || !child.tagName) continue
    if (child.tagName === 'footer' || isFootnoteSection(child)) continue
    const level = HEADING_LEVEL[child.tagName]
    if (level !== undefined) {
      const id = child.properties?.id
      out.push({ kind: 'heading', level, id: typeof id === 'string' ? id : null })
      continue
    }
    if (child.tagName === 'p') {
      const text = textOf(child).replace(/\s+/g, ' ').trim()
      // Image-only paragraphs carry no text and would make an empty preview.
      if (text !== '') out.push({ kind: 'paragraph', text })
      continue
    }
    collectBlocks(child, out)
  }
}

function truncate(text: string): string {
  if (text.length <= PREVIEW_MAX) return text
  // Leave room for the ellipsis so the result stays within PREVIEW_MAX.
  const limit = PREVIEW_MAX - 1
  let cut = text.slice(0, limit)
  if (!/\s/.test(text.charAt(limit))) {
    const lastSpace = cut.lastIndexOf(' ')
    // A single word longer than the limit: hard cut rather than nothing.
    if (lastSpace > 0) cut = cut.slice(0, lastSpace)
  }
  return `${cut.trimEnd()}…`
}

function headingMatches(id: string | null, section: string): boolean {
  return id === section || id === `${CLOBBER_PREFIX}${section}`
}

/** Plain text for a link preview: the first <p> of the page, or the first <p> after the
 *  heading whose id === section (stopping at the next heading of the same or higher
 *  level — then text is ''). Max 300 chars, cut at a word boundary with '…'.
 *  Unknown or missing section → page start with section: null. */
export function previewText(html: string, section?: string): { text: string; section: string | null } {
  const blocks: Block[] = []
  collectBlocks(fromHtml(html, { fragment: true }) as unknown as HNode, blocks)

  if (section) {
    const start = blocks.findIndex((b) => b.kind === 'heading' && headingMatches(b.id, section))
    if (start !== -1) {
      const level = (blocks[start] as { level: number }).level
      for (const block of blocks.slice(start + 1)) {
        if (block.kind === 'heading') {
          if (block.level <= level) break
          continue
        }
        return { text: truncate(block.text), section }
      }
      return { text: '', section }
    }
  }

  const first = blocks.find((b): b is { kind: 'paragraph'; text: string } => b.kind === 'paragraph')
  return { text: first ? truncate(first.text) : '', section: null }
}
