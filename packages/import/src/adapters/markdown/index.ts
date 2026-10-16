import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import type { Root } from 'mdast'
import { parse as parseYaml } from 'yaml'
import type { FileSource } from '../../files/source.js'
import type { ImportMedia, ImportNode, ImportTree } from '../../model.js'
import { normalizeMarkdown } from '../../normalize.js'
import { htmlToMarkdown } from '../bookstack/html-to-md.js'
import { mimeFor } from '../bookstack/media.js'
import { convertCallouts } from './callouts.js'
import { readHtmlNote } from './html.js'
import { collectInlineTags, isImagePath, normalizePath, rewriteLinksAndMedia, VaultIndex, type LinkContext } from './links.js'
import { obsidianPrepass } from './obsidian.js'
import {
  baseOf,
  buildStructure,
  classifyPaths,
  dirOf,
  sourceIdFor,
  stripNoteExt,
  type Flavor,
  type PlanNode,
} from './structure.js'

export type { Flavor } from './structure.js'

interface NoteData {
  title: string
  body: string
  tags: string[]
}

const NOT_IN_ARCHIVE = 'not in the archive'
const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/
const UTF8 = new TextDecoder('utf-8', { fatal: true })

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', fences: true, emphasis: '*', strong: '*', rule: '-', listItemIndent: 'one' })

/** UTF-8 without BOM and with `\n` line ends; throws on undecodable bytes. */
function decodeUtf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

function tagList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/[,\s]+/) : []
  return raw.map((t) => t.trim().replace(/^#/, '')).filter((t) => t !== '')
}

/** Splits off the YAML frontmatter: `title` and `tags` are used, every other
 *  key is counted in `dropped`. */
function readNote(text: string, fallbackTitle: string, dropped: Record<string, number>): NoteData {
  const m = FRONTMATTER.exec(text)
  if (!m) return { title: fallbackTitle, body: text, tags: [] }
  const body = text.slice(m[0].length)
  let data: unknown
  try {
    data = parseYaml(m[1] ?? '')
  } catch {
    count(dropped, '(invalid YAML)')
    return { title: fallbackTitle, body, tags: [] }
  }
  if (data === null || data === undefined) return { title: fallbackTitle, body, tags: [] }
  if (typeof data !== 'object' || Array.isArray(data)) {
    count(dropped, '(invalid YAML)')
    return { title: fallbackTitle, body, tags: [] }
  }
  let title = fallbackTitle
  let tags: string[] = []
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === 'title' && (typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      title = String(value).trim()
    } else if (key === 'tags') tags = tagList(value)
    else count(dropped, key)
  }
  return { title, body, tags }
}

/** Reads an HTML file into a note: title and content root, converted to
 *  Markdown; constructs Markdown cannot express are counted in `dropped`. */
function readHtml(bytes: Uint8Array, fallbackTitle: string, dropped: Record<string, number>): NoteData {
  const { title, html } = readHtmlNote(bytes, fallbackTitle)
  const converted = htmlToMarkdown(html, { baseUrl: '', resolveInternalLink: () => null })
  for (const [k, n] of Object.entries(converted.dropped)) dropped[k] = (dropped[k] ?? 0) + n
  return { title, body: converted.markdown, tags: [] }
}

/** Loads a Markdown folder, an Obsidian vault or an HTML folder into an
 *  `ImportTree`. Notes that cannot be read, decoded or converted are listed
 *  in `failed`; the rest continues. */
export async function loadMarkdownTree(src: FileSource, opts: { flavor: Flavor }): Promise<ImportTree> {
  const { flavor } = opts
  const droppedFrontmatter: Record<string, number> = {}
  const unresolved: NonNullable<ImportTree['unresolved']> = []
  const ambiguous: NonNullable<ImportTree['ambiguous']> = []
  const tree: ImportTree = {
    root: [],
    droppedHtml: {},
    drawingsAsPng: [],
    failed: [],
    mediaSkipped: [],
    droppedFrontmatter,
    unreferenced: [],
    unresolved,
    ambiguous,
  }

  const { notes, attachments, skipped } = classifyPaths(await src.list(), flavor)
  for (const s of skipped) tree.mediaSkipped.push({ sourceId: sourceIdFor(flavor, s.path), name: s.path, reason: s.reason })

  const data = new Map<string, NoteData>()
  const unreadable = new Map<string, string>()
  for (const path of notes) {
    const fallbackTitle = stripNoteExt(baseOf(path), flavor)
    let bytes: Uint8Array
    try {
      bytes = await src.read(path)
    } catch (e) {
      unreadable.set(path, e instanceof Error ? e.message : String(e))
      continue
    }
    if (flavor === 'html') {
      try {
        data.set(path, readHtml(bytes, fallbackTitle, tree.droppedHtml))
      } catch (e) {
        unreadable.set(path, e instanceof Error ? e.message : String(e))
      }
      continue
    }
    let text: string
    try {
      text = decodeUtf8(bytes)
    } catch {
      unreadable.set(path, 'not valid UTF-8')
      continue
    }
    data.set(path, readNote(text, fallbackTitle, droppedFrontmatter))
  }

  const plan = buildStructure(notes, (p) => data.get(p)?.title ?? stripNoteExt(baseOf(p), flavor), flavor)
  const pageIds = new Map<string, string>()
  const folderIds = new Map<string, string>()
  const collectIds = (nodes: PlanNode[]): void => {
    for (const n of nodes) {
      if (n.notePath) pageIds.set(n.notePath, n.sourceId)
      if (n.folder) folderIds.set(n.folder, n.sourceId)
      collectIds(n.children)
    }
  }
  collectIds(plan)
  const index = new VaultIndex(notes, attachments, pageIds, folderIds)

  const bytesCache = new Map<string, Promise<Uint8Array>>()
  const readOnce = (path: string): Promise<Uint8Array> => {
    let p = bytesCache.get(path)
    if (!p) {
      p = src.read(path)
      bytesCache.set(path, p)
    }
    return p
  }
  const referenced = new Set<string>()

  /** Converts one page body; `notePath` is the file the text came from (links
   *  are relative to it); both are null for a folder page without a note. */
  const convert = async (
    sourceId: string,
    title: string,
    notePath: string | null,
    note: NoteData | null,
  ): Promise<{ markdown: string; tags: string[]; media: ImportMedia[] }> => {
    let body = note?.body ?? ''
    if (notePath && note && flavor === 'obsidian') {
      const dir = dirOf(notePath)
      const pre = obsidianPrepass(body, (target) => {
        if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
          const p = normalizePath(target.startsWith('/') || !dir ? target : `${dir}/${target}`)
          return p ? index.find(p) : null
        }
        const hit = index.byName(target, dir)
        if (!hit) return null
        if (hit.ambiguous) ambiguous.push({ sourceId, target, chosen: hit.path })
        return hit.path
      })
      body = pre.text
      for (const t of pre.unresolved) unresolved.push({ sourceId, target: t })
      for (const t of pre.missing) tree.mediaSkipped.push({ sourceId, name: t, reason: NOT_IN_ARCHIVE })
    }

    const ast = processor.parse(body) as Root
    const ctx: LinkContext = {
      flavor,
      notePath: notePath ?? '',
      index,
      usedNames: new Set(),
      media: new Map(),
      missing: [],
      unresolved: [],
      ambiguous: [],
    }
    if (flavor === 'obsidian') convertCallouts(ast)
    rewriteLinksAndMedia(ast, ctx)
    for (const t of ctx.unresolved) unresolved.push({ sourceId, target: t })
    for (const a of ctx.ambiguous) ambiguous.push({ sourceId, ...a })
    for (const t of ctx.missing) tree.mediaSkipped.push({ sourceId, name: t, reason: NOT_IN_ARCHIVE })

    // HTML pages carry no tags; a `#word` in their text is just text.
    const tags = flavor === 'html' ? [] : [...new Set([...(note?.tags ?? []), ...collectInlineTags(ast)])]
    const first = ast.children[0]
    if (!(first && first.type === 'heading' && first.depth === 1)) {
      ast.children.unshift({ type: 'heading', depth: 1, children: [{ type: 'text', value: title }] })
    }
    const normalized = normalizeMarkdown(processor.stringify(ast))
    for (const [k, n] of Object.entries(normalized.dropped)) tree.droppedHtml[k] = (tree.droppedHtml[k] ?? 0) + n

    const media: ImportMedia[] = []
    for (const [path, name] of ctx.media) {
      referenced.add(path)
      try {
        media.push({
          name,
          bytes: await readOnce(path),
          mime: mimeFor(name),
          kind: isImagePath(path) ? 'image' : 'file',
          ref: `_media/${name}`,
        })
      } catch (e) {
        tree.mediaSkipped.push({ sourceId, name: path, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    return { markdown: normalized.markdown, tags, media }
  }

  const build = async (nodes: PlanNode[]): Promise<ImportNode[]> => {
    const out: ImportNode[] = []
    for (const [i, n] of nodes.entries()) {
      const notePath = n.notePath ?? null
      const failure = notePath ? unreadable.get(notePath) : undefined
      if (failure && notePath) {
        if (!n.folder) {
          tree.failed.push({ sourceId: n.sourceId, title: n.title, reason: failure })
          continue
        }
        // The folder page still holds its children; only the folder note is lost.
        tree.failed.push({ sourceId: sourceIdFor(flavor, notePath), title: baseOf(notePath), reason: failure })
      }
      const note = notePath ? (data.get(notePath) ?? null) : null
      const converted = await convert(n.sourceId, n.title, note ? notePath : null, note)
      out.push({
        sourceRef: { type: flavor, id: n.sourceId },
        title: n.title,
        markdown: converted.markdown,
        tags: converted.tags,
        children: await build(n.children),
        media: converted.media,
        order: i,
      })
    }
    return out
  }

  tree.root = await build(plan)
  tree.unreferenced = attachments.filter((a) => !referenced.has(a))
  return tree
}

export function loadMarkdownFolderTree(src: FileSource): Promise<ImportTree> {
  return loadMarkdownTree(src, { flavor: 'markdown' })
}

export function loadObsidianTree(src: FileSource): Promise<ImportTree> {
  return loadMarkdownTree(src, { flavor: 'obsidian' })
}

export function loadHtmlTree(src: FileSource): Promise<ImportTree> {
  return loadMarkdownTree(src, { flavor: 'html' })
}
