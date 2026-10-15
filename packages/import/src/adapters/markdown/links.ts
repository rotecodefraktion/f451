import type { Root, Link, Image, Definition, Parent, RootContent } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'
import { baseOf, dirOf } from './structure.js'
import { slugifyFileName, uniqueName } from '../bookstack/media.js'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

export function extOf(path: string): string {
  const base = baseOf(path)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extOf(path))
}

/** Joins and normalises a relative POSIX path; null if it leaves the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/** All notes and attachments of the source, looked up by path or by name. */
export class VaultIndex {
  private readonly all: string[]
  private readonly exact = new Set<string>()
  private readonly lower = new Map<string, string[]>()
  private readonly byBase = new Map<string, string[]>()

  constructor(
    readonly notes: string[],
    readonly attachments: string[],
    /** Note path → source id of the page that carries it (folder notes map to their folder). */
    private readonly pageIds: Map<string, string>,
  ) {
    this.all = [...notes, ...attachments]
    for (const p of this.all) {
      this.exact.add(p)
      const l = p.toLowerCase()
      this.lower.set(l, [...(this.lower.get(l) ?? []), p])
      const b = baseOf(l)
      this.byBase.set(b, [...(this.byBase.get(b) ?? []), p])
    }
  }

  isNote(path: string): boolean {
    return this.pageIds.has(path)
  }

  pageIdOf(notePath: string): string | undefined {
    return this.pageIds.get(notePath)
  }

  /** Exact path, else a case-insensitive match. */
  find(path: string): string | null {
    if (this.exact.has(path)) return path
    return this.lower.get(path.toLowerCase())?.[0] ?? null
  }

  /** Obsidian-style lookup of `name` (a file name or a partial path):
   *  exact case preferred; among several, the one in `fromDir` wins, else the
   *  shortest path — that last case is reported as ambiguous. */
  byName(name: string, fromDir: string): { path: string; ambiguous: boolean } | null {
    const lname = name.toLowerCase()
    const pool = this.byBase.get(baseOf(lname)) ?? []
    let hits = pool.filter((p) => {
      const l = p.toLowerCase()
      return l === lname || l.endsWith(`/${lname}`)
    })
    if (hits.length === 0) return null
    const exactCase = hits.filter((p) => p === name || p.endsWith(`/${name}`))
    if (exactCase.length) hits = exactCase
    if (hits.length === 1) return { path: hits[0], ambiguous: false }
    // A target with a folder that names a full path from the root is not ambiguous.
    const rooted = name.includes('/') ? hits.filter((p) => p.toLowerCase() === lname) : []
    if (rooted.length === 1) return { path: rooted[0], ambiguous: false }
    const local = hits.filter((p) => dirOf(p) === fromDir)
    if (local.length === 1) return { path: local[0], ambiguous: false }
    const sorted = [...hits].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
    )
    return { path: sorted[0], ambiguous: true }
  }
}

export interface LinkContext {
  flavor: 'markdown' | 'obsidian'
  notePath: string
  index: VaultIndex
  /** Names already used in this page's `_media/`. */
  usedNames: Set<string>
  /** Attachment path → `_media/` name for this page. */
  media: Map<string, string>
  missing: string[]
  unresolved: string[]
  ambiguous: Array<{ target: string; chosen: string }>
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Keeps a destination usable inside the writer's placeholder (no spaces or parentheses). */
function encodeDest(url: string): string {
  return url.replace(/[\s()]/gu, (c) => encodeURIComponent(c).replace(/\(/g, '%28').replace(/\)/g, '%29'))
}

/** Resolves a local link destination to a file of the source. Tries the path
 *  as written and percent-decoded, relative to the note, then to the root;
 *  the Obsidian flavor finally looks the name up like a wikilink. */
function resolvePath(raw: string, ctx: LinkContext): string | null {
  const variants = [raw]
  const decoded = decode(raw)
  if (decoded !== null && decoded !== raw) variants.push(decoded)
  const dir = dirOf(ctx.notePath)
  for (const v of variants) {
    const tries = v.startsWith('/') ? [v] : [dir ? `${dir}/${v}` : v, v]
    for (const t of tries) {
      const p = normalizePath(t)
      const hit = p ? ctx.index.find(p) : null
      if (hit) return hit
    }
  }
  if (ctx.flavor === 'obsidian') {
    for (const v of variants) {
      if (v.startsWith('/') || v.startsWith('.')) continue
      const hit = ctx.index.byName(v, dir)
      if (hit) {
        if (hit.ambiguous) ctx.ambiguous.push({ target: v, chosen: hit.path })
        return hit.path
      }
    }
  }
  return null
}

function mediaName(path: string, ctx: LinkContext): string {
  let name = ctx.media.get(path)
  if (!name) {
    name = uniqueName(slugifyFileName(baseOf(path)), ctx.usedNames)
    ctx.media.set(path, name)
  }
  return name
}

/** Rewrites one destination. Returns the new URL, or null to leave it alone. */
function rewrite(url: string, isImage: boolean, ctx: LinkContext): string | null {
  if (!url || EXTERNAL.test(url)) return null
  const hash = url.indexOf('#')
  const pathPart = (hash < 0 ? url : url.slice(0, hash)).split('?')[0]
  if (!pathPart) return null
  const target = resolvePath(pathPart, ctx)
  if (!target) {
    const shown = decode(pathPart) ?? pathPart
    if (/\.md$/i.test(shown)) ctx.unresolved.push(shown)
    else if (isImage || extOf(shown)) ctx.missing.push(shown)
    return null
  }
  if (ctx.index.isNote(target)) {
    if (isImage) return null
    return `source:${ctx.index.pageIdOf(target)}|${encodeDest(url)}`
  }
  return `_media/${mediaName(target, ctx)}`
}

/** Remark pass: links to notes become `source:<id>|<url>` placeholders,
 *  links and images pointing at attachments become `_media/<name>`.
 *  Reference-style links are turned inline first, so the writer sees them. */
export function rewriteLinksAndMedia(tree: Root, ctx: LinkContext): void {
  const defs = new Map<string, Definition>()
  visit(tree, 'definition', (d: Definition) => {
    const key = d.identifier.toLowerCase()
    if (!defs.has(key)) defs.set(key, d)
  })
  if (defs.size) {
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return
      if (node.type !== 'linkReference' && node.type !== 'imageReference') return
      const def = defs.get(node.identifier.toLowerCase())
      if (!def) return
      const replacement: Link | Image =
        node.type === 'linkReference'
          ? { type: 'link', url: def.url, title: def.title, children: node.children }
          : { type: 'image', url: def.url, title: def.title, alt: node.alt }
      ;(parent as Parent).children[index] = replacement as RootContent
    })
    visit(tree, 'definition', (_d, index, parent) => {
      if (!parent || index === undefined) return
      parent.children.splice(index, 1)
      return [SKIP, index]
    })
  }

  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'image') return
    const n = node as Link | Image
    const next = rewrite(n.url, n.type === 'image', ctx)
    if (next === null) return
    n.url = next
    // The writer's placeholder pattern allows no title after the URL.
    if (next.startsWith('source:')) n.title = null
  })
}

const INLINE_TAG = /(^|[\s(,;])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu

/** Inline `#tags` in text (code is a separate node type, heading markers are
 *  not text, so both are excluded by construction). */
export function collectInlineTags(tree: Root): string[] {
  const tags: string[] = []
  visit(tree, 'text', (t) => {
    for (const m of t.value.matchAll(INLINE_TAG)) tags.push(m[2])
  })
  return tags
}
