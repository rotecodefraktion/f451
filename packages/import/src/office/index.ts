// Office import (spec 2026-10-16-office-import §2–§4): Word, PowerPoint and
// Excel files — a single file or a ZIP — through the convert service. Each file
// is checked (OOXML and ODF are ZIPs), converted to HTML, run through the
// pre-pass of its kind and `htmlToMarkdown`, then through the part A link and
// media pass. A file that cannot be converted is listed in `failed`; the run
// continues.

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import type { Heading, Image, Link, List, ListItem, Root, RootContent, Text } from 'mdast'
import { createSlugger } from '@f451/markdown'
import { visit } from 'unist-util-visit'
import { htmlToMarkdown } from '../adapters/bookstack/html-to-md.js'
import { mimeFor, slugifyFileName, uniqueName } from '../adapters/bookstack/media.js'
import { isImagePath, rewriteLinksAndMedia, VaultIndex, type LinkContext } from '../adapters/markdown/links.js'
import { baseOf, buildStructure, classifyPaths, sourceIdFor, stripNoteExt, type PlanNode } from '../adapters/markdown/structure.js'
import { ArchiveRejectedError, type FileSource, type ZipLimits } from '../files/source.js'
import { zipSource } from '../files/zip.js'
import type { ImportMedia, ImportNode, ImportTree } from '../model.js'
import { normalizeMarkdown } from '../normalize.js'
import { applyCharts } from './charts.js'
import type { Converter } from './converter.js'
import { label, type Lang, type OfficeDoc, type OfficePart } from './doc.js'
import { expandSelfClosing, findAll, parseBody, prop, type HNode } from './hast.js'
import { detectLang } from './lang.js'
import { extensionOf, officeKind } from './kinds.js'
import { attachmentList, avMime, collectAttachments, type Attachment } from './media.js'
import { scanOdf } from './odf.js'
import { sheetsPrepass } from './sheets.js'
import { slidesPrepass } from './slides.js'
import { textPrepass } from './text.js'
import { HEADING_LINK, stripTokens, takeHeadingTokens, Tokens } from './tokens.js'
import { markPackage } from './marks.js'
import { assignIds, DEFAULT_WORD_OPTIONS, mainTitle, parseIdPattern, subTitle, type WordOptions } from './naming.js'
import { acceptPackageChanges, rewritePackage } from './revisions.js'

export type { WordOptions } from './naming.js'

export interface OfficeTreeOptions {
  converter: Converter
  /** Text at the split level, one page per slide, one page per sheet. */
  split: boolean
  /** Options for text documents; unset fields take `DEFAULT_WORD_OPTIONS`. */
  text?: Partial<WordOptions>
  /** All page titles of the target space: the ID counter continues after the highest number. */
  existingTitles?: string[]
  /** Source id → current title of pages already imported: such a page keeps its ID number. */
  existingIds?: Map<string, string>
  /** Language of generated names ("Folie n" / "Slide n", chart alt text, TOC
   *  heading) for a file whose language cannot be detected from its text;
   *  default `en`. */
  lang?: Lang
  /** Limits of the ZIP check on OOXML and ODF files; part A defaults if unset. */
  limits?: Partial<ZipLimits>
  /** Checked before each conversion. */
  signal?: AbortSignal
  /** Called before each file is converted (0-based index). */
  onFile?: (path: string, index: number, total: number) => void
}

const FLAVOR = 'office'
/** Destinations of media from the bundle and the package, resolved per page. */
const MEDIA_SCHEME = 'f451-media:'
const ZIP_BASED = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'])
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', fences: true, emphasis: '*', strong: '*', rule: '-', listItemIndent: 'one' })

interface PreparedPart {
  /** The heading as shown (with its number when numbering is on). */
  title: string
  /** The heading without its outline number. */
  text: string
  number: string | null
  /** Dotted position among the parts (`3`, `3.2`); the source id suffix. */
  position: string
  body: string
  /** Heading tokens of the part heading, which becomes the page's H1. */
  anchors: number[]
  children: PreparedPart[]
}

interface Prepared {
  /** A text document: the Word options apply. */
  text: boolean
  /** Language of the generated names: detected from the text, else the fallback. */
  lang: Lang
  /** The document title: Title paragraph, title property or file name. */
  title: string
  fileBody: string
  /** Attachment list at the end of the file page, '' if none. */
  fileTail: string
  parts: PreparedPart[]
  /** Media key (bundle path or `attach:<entry>`) → bytes. */
  media: Map<string, Uint8Array>
  dropped: Record<string, number>
  notices: Array<{ name: string; reason: string }>
  /** `part` is the 0-based part index with a split, null without. */
  truncated: Array<{ part: number | null; sheet: string; rows: number }>
}

function merge(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function sameTitle(a: string, b: string): boolean {
  return collapse(a).toLowerCase() === collapse(b).toLowerCase()
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The runner converts `in/document.<ext>` into `out/`, so LibreOffice writes
 *  relative links relative to `out/` (`deck.pptx` → `../in/deck.pptx`). This
 *  turns them back into links relative to the document. */
export function fromOutDir(url: string): string {
  if (!url || EXTERNAL.test(url) || url.startsWith('/') || url.startsWith('#')) return url
  const cut = url.search(/[?#]/)
  const path = cut < 0 ? url : url.slice(0, cut)
  const rest = cut < 0 ? '' : url.slice(cut)
  const stack = ['out']
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) return url
      stack.pop()
    } else stack.push(seg)
  }
  if (stack.length === 0) return url
  const fixed = stack[0] === 'in' ? stack.slice(1).join('/') : `../${stack.join('/')}`
  return fixed ? fixed + rest : url
}

function isBlankHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').trim() === '' && !/<img\b/i.test(html)
}

function headingText(h: Heading): string {
  let out = ''
  visit(h, 'text', (t) => {
    out += t.value
  })
  return out
}

/** OOXML/ODF packages are mostly XML, which compresses far better than the
 *  files of a part A archive: a long text document passes ratio 10 easily.
 *  The unpacked cap stays below the convert service's 1 GB memory limit. */
const OFFICE_PACKAGE_LIMITS: Partial<ZipLimits> = { maxRatio: 100, maxUnpackedBytes: 512 * 1024 * 1024 }

function plainText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value
  return Array.isArray(node.children) ? node.children.map((c) => plainText(c as typeof node)).join('') : ''
}

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** The text of an HTML body for language detection: blocks separated by a
 *  space, so the last word of one paragraph does not run into the next. */
function bodyText(node: HNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'comment') return ''
  const inner = (node.children ?? []).map(bodyText).join('')
  return node.type === 'element' && BLOCK_TAGS.has(node.tagName ?? '') ? ` ${inner} ` : inner
}

interface PageHeading {
  depth: number
  text: string
  /** The id the renderer gives the heading on its page. */
  slug: string
}

/** Where a marked heading of one document ended up. `top`: the page's H1. */
interface HeadingTarget {
  sourceId: string
  slug: string
  top: boolean
}

/** A page between the two halves of its conversion. */
interface OpenPage {
  sourceId: string
  ast: Root
  /** Attachment path → media name, from the link pass. */
  linked: Map<string, string>
  /** Media key → media name, for media of the bundle and the package. */
  own: Map<string, string>
  lookup: Map<string, Uint8Array>
  headings: PageHeading[]
}

/** The page's headings in order with the slugs the renderer gives them; the
 *  heading tokens are taken out and their targets recorded. */
function collectHeadings(ast: Root, sourceId: string, targets: Map<number, HeadingTarget>): PageHeading[] {
  const slugger = createSlugger()
  const out: PageHeading[] = []
  visit(ast, 'heading', (h: Heading) => {
    const ids: number[] = []
    let last: Text | null = null
    visit(h, 'text', (t: Text) => {
      const taken = takeHeadingTokens(t.value)
      ids.push(...taken.ids)
      t.value = taken.text
      last = t
    })
    // The token sat at the end; space before it would now trail the heading.
    if (ids.length && last) (last as Text).value = (last as Text).value.trimEnd()
    const text = plainText(h)
    const slug = slugger(text)
    const top = out.length === 0 && h.depth === 1
    out.push({ depth: h.depth, text: collapse(text), slug })
    for (const id of ids) targets.set(id, { sourceId, slug, top })
  })
  return out
}

/** In-document links of the text pre-pass: a link to a heading on this page
 *  gets its slug, one to a heading on another page of the same document a
 *  link placeholder (to the page itself for its H1); a link to a heading
 *  that is no heading any more keeps only its text. */
function resolveHeadingLinks(ast: Root, sourceId: string, targets: Map<number, HeadingTarget>): void {
  visit(ast, 'link', (node: Link, index, parent) => {
    if (!node.url.startsWith(HEADING_LINK)) return
    const target = targets.get(Number(node.url.slice(HEADING_LINK.length)))
    if (!target) {
      if (parent && index !== undefined) {
        parent.children.splice(index, 1, ...node.children)
        return index
      }
      return
    }
    if (target.sourceId === sourceId) node.url = `#${target.slug}`
    else {
      node.url = target.top ? `source:${target.sourceId}|#` : `source:${target.sourceId}#${target.slug}|#`
      // The writer's placeholder pattern allows no title after the URL.
      node.title = null
    }
  })
}

interface TocPage {
  sourceId: string
  title: string
  headings: PageHeading[]
  children: TocPage[]
}

interface TocEntry {
  text: string
  url: string
  children: TocEntry[]
}

/** The table of contents of a split text document (spec §Table of contents):
 *  every part page, and on each its headings down to `depth` (depth 1 = the
 *  pages only, 2 = plus their `##` headings, …). Bold paragraphs are no
 *  headings any more and stay out by construction. */
function tableOfContents(pages: TocPage[], depth: number, heading: string): RootContent[] {
  const sections = (page: TocPage): TocEntry[] => {
    const root: TocEntry[] = []
    const stack: Array<{ depth: number; items: TocEntry[] }> = [{ depth: 1, items: root }]
    for (const h of page.headings) {
      if (h.depth < 2 || h.depth > depth || !h.text) continue
      while (stack[stack.length - 1].depth >= h.depth) stack.pop()
      const entry: TocEntry = { text: h.text, url: `source:${page.sourceId}#${h.slug}|#`, children: [] }
      stack[stack.length - 1].items.push(entry)
      stack.push({ depth: h.depth, items: entry.children })
    }
    return root
  }
  const entry = (page: TocPage): TocEntry => ({
    text: page.title,
    url: `source:${page.sourceId}|#`,
    children: [...sections(page), ...page.children.map(entry)],
  })
  const list = (entries: TocEntry[]): List => ({
    type: 'list',
    ordered: false,
    spread: false,
    children: entries.map(
      (e): ListItem => ({
        type: 'listItem',
        spread: false,
        children: [
          { type: 'paragraph', children: [{ type: 'link', url: e.url, title: null, children: [{ type: 'text', value: e.text }] }] },
          ...(e.children.length ? [list(e.children)] : []),
        ],
      }),
    ),
  })
  return [{ type: 'heading', depth: 2, children: [{ type: 'text', value: heading }] }, list(pages.map(entry))]
}

function tryZip(bytes: Uint8Array, limits?: Partial<ZipLimits>): FileSource | null {
  try {
    return zipSource(bytes, limits)
  } catch {
    return null
  }
}

async function prepareFile(
  path: string,
  bytes: Uint8Array,
  opts: OfficeTreeOptions,
  fallbackLang: Lang,
  word: WordOptions,
): Promise<Prepared> {
  const kind = officeKind(path)
  if (!kind) throw new Error('not an Office file')
  const ext = extensionOf(path)

  // OOXML and ODF files are ZIPs: the part A checks run before LibreOffice sees them.
  let pkg: FileSource | null = null
  if (ZIP_BASED.has(ext)) {
    try {
      pkg = zipSource(bytes, { ...OFFICE_PACKAGE_LIMITS, ...opts.limits })
    } catch (e) {
      if (e instanceof ArchiveRejectedError) throw new Error(`rejected before conversion: ${e.message}`)
      throw e
    }
  }

  // One pass over a text package: LibreOffice would write deleted text of
  // open revisions as plain text, and drops the paragraph styles the Title
  // paragraph and headings past level 6 are known by.
  let revisions = 0
  const input = rewritePackage(bytes, ext, (files, pkgKind) => {
    revisions = acceptPackageChanges(files, pkgKind)
    const marked = markPackage(files, pkgKind)
    return revisions > 0 || marked > 0
  })
  const bundle = await opts.converter.toHtml(input, baseOf(path))
  const scan = scanOdf(bundle.odf)
  const dropped: Record<string, number> = { ...scan.dropped }
  if (revisions) dropped.trackedChange = (dropped.trackedChange ?? 0) + revisions
  const notices: Prepared['notices'] = []
  if (pkg && !dropped.macro && (await pkg.list()).some((p) => /(^|\/)vbaProject\.bin$/i.test(p))) dropped.macro = 1

  const html = kind === 'slides' || /^\s*<\?xml/.test(bundle.html) ? expandSelfClosing(bundle.html) : bundle.html
  const body = parseBody(html)
  // The file's own language names what the import generates for it; the
  // fallback (the space's default) only when its text says too little.
  const lang = detectLang(bodyText(body)) ?? fallbackLang

  const charts = applyCharts(body, scan.svmFrames, label('chart', lang), dropped)
  if (charts.dropped) {
    notices.push({
      name: 'chart image',
      reason: `${charts.dropped} chart or SmartArt image(s) could not be made; only their text is kept`,
    })
  }
  if (!charts.matched && charts.charts > 0) {
    notices.push({
      name: 'chart data',
      reason: `${charts.images} chart image(s) but ${scan.svmFrames.length} embedded object(s): the order is unclear, no data tables added`,
    })
  }

  // Images from the bundle get a placeholder destination the media pass
  // resolves; other references are made relative to the document again.
  const media = new Map<string, Uint8Array>()
  for (const img of findAll(body, (e) => e.tagName === 'img')) {
    const src = prop(img, 'src')
    const key = bundle.media.has(src) ? src : bundle.media.has(safeDecode(src)) ? safeDecode(src) : null
    if (key) {
      media.set(key, bundle.media.get(key)!)
      img.properties.src = MEDIA_SCHEME + encodeURIComponent(key)
    } else img.properties.src = fromOutDir(src)
  }
  for (const a of findAll(body, (e) => e.tagName === 'a')) {
    if (typeof a.properties.href === 'string') a.properties.href = fromOutDir(a.properties.href)
  }

  // Video and audio from the package (for binary formats: from the ODF copy,
  // which LibreOffice wrote from an accepted input; its XML compresses far
  // beyond the ratio limit, so only the size limit applies).
  const mediaPkg = pkg ?? tryZip(bundle.odf, { ...opts.limits, maxRatio: Number.POSITIVE_INFINITY })
  const attachments = mediaPkg ? await collectAttachments(mediaPkg, { pptx: ext === 'pptx', pages: scan.pages }) : []
  const keyOf = (a: Attachment): string => `attach:${a.path}`
  const href = (a: Attachment): string => MEDIA_SCHEME + encodeURIComponent(keyOf(a))
  for (const a of attachments) media.set(keyOf(a), a.bytes)
  const bySlide = new Map<number, Attachment[]>()
  const atEnd: Attachment[] = []
  for (const a of attachments) {
    if (kind === 'slides' && a.slide !== null) bySlide.set(a.slide, [...(bySlide.get(a.slide) ?? []), a])
    else atEnd.push(a)
  }

  const tokens = new Tokens()
  let doc: OfficeDoc
  let truncated: Prepared['truncated'] = []
  if (kind === 'text') {
    doc = textPrepass(body, { tokens, dropped, lang, splitLevel: opts.split ? word.splitLevel : null, numbering: word.numbering })
  } else if (kind === 'slides') {
    doc = slidesPrepass(body, {
      tokens,
      dropped,
      lang,
      split: opts.split,
      pages: scan.pages,
      attachments: (depth, slide) => {
        const list = bySlide.get(slide)
        return list?.length ? attachmentList(list, depth, href) : null
      },
    })
    for (const [slide, list] of bySlide) if (slide >= doc.parts.length) atEnd.push(...list)
  } else {
    const sheets = sheetsPrepass(body, scan.sheets)
    doc = sheets
    for (const name of sheets.empty) notices.push({ name: `sheet "${name}"`, reason: 'empty, not imported' })
    truncated = sheets.truncated.map((t) => ({ part: opts.split ? t.part : null, sheet: t.sheet, rows: t.rows }))
  }
  // The Title paragraph, else the title property, else the file name.
  const title = doc.title ?? scan.title ?? stripNoteExt(baseOf(path), FLAVOR)

  let intro = doc.intro
  let parts: OfficePart[] = doc.parts
  // A document opening with its title as H1: that heading is the file page's,
  // not a first chapter of the same name. Its subparts move up a level.
  if (opts.split && kind === 'text' && isBlankHtml(intro) && parts[0] && sameTitle(parts[0].title, title)) {
    intro = parts[0].heading + parts[0].html
    parts = [...(parts[0].children ?? []), ...parts.slice(1)]
  }

  const toMd = (fragment: string): string => {
    const converted = htmlToMarkdown(fragment, { baseUrl: '', resolveInternalLink: () => null })
    merge(dropped, converted.dropped)
    return tokens.resolve(converted.markdown)
  }
  const toPrepared = (p: OfficePart, position: string): PreparedPart => ({
    title: p.title,
    text: p.text ?? p.title,
    number: p.number ?? null,
    position,
    body: toMd(p.html),
    anchors: takeHeadingTokens(p.heading).ids,
    children: (p.children ?? []).map((c, k) => toPrepared(c, `${position}.${k + 1}`)),
  })
  let fileBody: string
  let partBodies: PreparedPart[] = []
  if (opts.split) {
    fileBody = toMd(intro)
    partBodies = parts.map((p, k) => toPrepared(p, String(k + 1)))
  } else {
    fileBody = toMd(intro + parts.map((p) => p.heading + p.html).join('\n'))
  }
  const fileTail = atEnd.length ? `${attachmentList(atEnd, 2, href)}\n` : ''

  return { text: kind === 'text', lang, title, fileBody, fileTail, parts: partBodies, media, dropped, notices, truncated }
}

/** Loads Office files (`FileSource` of one file, a folder or a ZIP) into an
 *  `ImportTree`. Conversions run one at a time, in path order. */
export async function loadOfficeTree(src: FileSource, opts: OfficeTreeOptions): Promise<ImportTree> {
  const lang = opts.lang ?? 'en'
  const word: WordOptions = { ...DEFAULT_WORD_OPTIONS, ...opts.text }
  const unresolved: NonNullable<ImportTree['unresolved']> = []
  const ambiguous: NonNullable<ImportTree['ambiguous']> = []
  const truncated: NonNullable<ImportTree['truncated']> = []
  const tree: ImportTree = {
    root: [],
    droppedHtml: {},
    drawingsAsPng: [],
    failed: [],
    mediaSkipped: [],
    unreferenced: [],
    unresolved,
    ambiguous,
    truncated,
  }

  // Office imports skip nothing but dot paths, so `skipped` stays empty.
  const { notes, attachments } = classifyPaths(await src.list(), FLAVOR)

  const prepared = new Map<string, Prepared>()
  const failures = new Map<string, string>()
  for (const [i, path] of notes.entries()) {
    opts.signal?.throwIfAborted()
    opts.onFile?.(path, i, notes.length)
    try {
      prepared.set(path, await prepareFile(path, await src.read(path), opts, lang, word))
    } catch (e) {
      failures.set(path, e instanceof Error ? e.message : String(e))
    }
  }

  // Own IDs for the converted text documents, numbered in source-path order.
  const fileName = (path: string): string => stripNoteExt(baseOf(path), FLAVOR)
  const textPaths = notes.filter((p) => prepared.get(p)?.text).sort()
  const ids =
    word.mainName === 'id' && word.idPattern
      ? assignIds(
          word.idPattern,
          textPaths.map((p) => sourceIdFor(FLAVOR, p)),
          opts.existingTitles ?? [],
          opts.existingIds ?? new Map(),
        )
      : new Map<string, string>()
  // A fixed ID (pattern without counter) shown alone names every text file
  // the same; only the first file in path order keeps it, the others fail.
  const fixedIdTaken = new Set(
    word.mainName === 'id' && word.idPattern && !parseIdPattern(word.idPattern) && word.idDisplay === 'id'
      ? textPaths.slice(1)
      : [],
  )
  const pageTitle = (path: string): string => {
    const p = prepared.get(path)
    if (!p) return fileName(path)
    if (!p.text) return p.title
    return mainTitle({
      mainName: word.mainName,
      idDisplay: word.idDisplay,
      title: p.title,
      fileName: fileName(path),
      id: ids.get(sourceIdFor(FLAVOR, path)),
    })
  }

  const plan = buildStructure(notes, pageTitle, FLAVOR)
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

  const parse = (markdown: string): Root => processor.parse(markdown) as Root

  /** First half of a page: link pass (links relative to `notePath`), media
   *  from `lookup`, the title as H1 unless the body already opens with it,
   *  the headings with their slugs. `anchors` are heading tokens that point
   *  at the H1; `demote` moves an H1 of the body that is not the title one
   *  level down, so the page keeps a single H1. */
  const openPage = (
    sourceId: string,
    title: string,
    notePath: string | null,
    ast: Root,
    lookup: Map<string, Uint8Array>,
    targets: Map<number, HeadingTarget>,
    extra: { anchors?: number[]; demote?: boolean } = {},
  ): OpenPage => {
    const ctx: LinkContext = {
      flavor: FLAVOR,
      notePath: notePath ?? '',
      index,
      usedNames: new Set(),
      media: new Map(),
      missing: [],
      unresolved: [],
      ambiguous: [],
    }
    rewriteLinksAndMedia(ast, ctx)
    for (const t of ctx.unresolved) unresolved.push({ sourceId, target: t })
    for (const a of ctx.ambiguous) ambiguous.push({ sourceId, ...a })
    for (const t of ctx.missing) tree.mediaSkipped.push({ sourceId, name: t, reason: 'not in the archive' })

    const own = new Map<string, string>()
    visit(ast, (node) => {
      if (node.type !== 'image' && node.type !== 'link') return
      const n = node as Image | Link
      if (!n.url.startsWith(MEDIA_SCHEME)) return
      const key = safeDecode(n.url.slice(MEDIA_SCHEME.length))
      if (!lookup.has(key)) return
      let name = own.get(key)
      if (!name) {
        name = uniqueName(slugifyFileName(baseOf(key)), ctx.usedNames)
        own.set(key, name)
      }
      n.url = `_media/${name}`
    })

    const first = ast.children[0]
    if (first && first.type === 'heading' && sameTitle(stripTokens(headingText(first)), title)) first.depth = 1
    else {
      if (extra.demote && first && first.type === 'heading' && first.depth === 1) first.depth = 2
      ast.children.unshift({ type: 'heading', depth: 1, children: [{ type: 'text', value: title }] })
    }
    const headings = collectHeadings(ast, sourceId, targets)
    for (const id of extra.anchors ?? []) targets.set(id, { sourceId, slug: headings[0].slug, top: true })
    return { sourceId, ast, linked: ctx.media, own, lookup, headings }
  }

  /** Second half: heading links (all pages of the document opened), Markdown, media. */
  const finishPage = async (
    page: OpenPage,
    targets: Map<number, HeadingTarget>,
  ): Promise<{ markdown: string; media: ImportMedia[] }> => {
    const { sourceId, own, lookup } = page
    resolveHeadingLinks(page.ast, sourceId, targets)
    const normalized = normalizeMarkdown(processor.stringify(page.ast))
    merge(tree.droppedHtml, normalized.dropped)

    const media: ImportMedia[] = []
    for (const [path, name] of page.linked) {
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
    for (const [key, name] of own) {
      media.push({
        name,
        bytes: lookup.get(key)!,
        mime: avMime(name) ?? mimeFor(name),
        kind: isImagePath(name) ? 'image' : 'file',
        ref: `_media/${name}`,
      })
    }
    return { markdown: normalized.markdown, media }
  }

  interface SubPage extends TocPage {
    order: number
    page: OpenPage
    children: SubPage[]
  }

  const build = async (nodes: PlanNode[]): Promise<ImportNode[]> => {
    const out: ImportNode[] = []
    for (const [i, n] of nodes.entries()) {
      if (!n.notePath) {
        const targets = new Map<number, HeadingTarget>()
        const converted = await finishPage(openPage(n.sourceId, n.title, null, parse(''), new Map(), targets), targets)
        out.push({
          sourceRef: { type: FLAVOR, id: n.sourceId },
          title: n.title,
          markdown: converted.markdown,
          tags: [],
          children: await build(n.children),
          media: converted.media,
          order: i,
        })
        continue
      }
      const failure = failures.get(n.notePath)
      const p = prepared.get(n.notePath)
      if (failure !== undefined || !p) {
        tree.failed.push({ sourceId: n.sourceId, title: n.title, reason: failure ?? 'not converted' })
        continue
      }
      if (fixedIdTaken.has(n.notePath)) {
        tree.failed.push({
          sourceId: n.sourceId,
          title: n.title,
          reason: `the fixed ID "${word.idPattern}" is already used by another file of this import (add "#" to the pattern or show the title)`,
        })
        continue
      }
      merge(tree.droppedHtml, p.dropped)
      for (const notice of p.notices) tree.mediaSkipped.push({ sourceId: n.sourceId, ...notice })
      for (const t of p.truncated) {
        truncated.push({ sourceId: t.part === null ? n.sourceId : `${n.sourceId}@${t.part + 1}`, sheet: t.sheet, rows: t.rows })
      }
      // Heading tokens are numbered per document: links between its pages
      // resolve once every page of it is open.
      const notePath = n.notePath
      const targets = new Map<number, HeadingTarget>()
      const key = ids.get(n.sourceId) ?? fileName(notePath)
      const openParts = (parts: PreparedPart[]): SubPage[] =>
        parts.map((part, k) => {
          const id = `${n.sourceId}@${part.position}`
          const title = p.text
            ? subTitle({
                subName: word.subName,
                chapter: part.title,
                text: part.text,
                number: part.number,
                position: part.position,
                docTitle: p.title,
                key,
              })
            : part.title
          const page = openPage(id, title, notePath, parse(part.body), p.media, targets, { anchors: part.anchors })
          return { sourceId: id, title, headings: page.headings, order: k, page, children: openParts(part.children) }
        })
      const subs = openParts(p.parts)

      const fileAst = parse(p.fileBody)
      if (p.text && word.toc && subs.length) {
        // After the content, before the footnote definitions.
        const at = fileAst.children.findIndex((c) => c.type === 'footnoteDefinition')
        fileAst.children.splice(at < 0 ? fileAst.children.length : at, 0, ...tableOfContents(subs, word.tocDepth, label('toc', p.lang)))
      }
      if (p.fileTail) fileAst.children.push(...parse(p.fileTail).children)
      // "ID only": the document title is the page's first line.
      const h1 = p.text && word.mainName === 'id' && word.idDisplay === 'id' ? p.title : n.title
      const file = await finishPage(openPage(n.sourceId, h1, notePath, fileAst, p.media, targets, { demote: p.text }), targets)

      const finishParts = async (list: SubPage[]): Promise<ImportNode[]> => {
        const done: ImportNode[] = []
        for (const s of list) {
          const converted = await finishPage(s.page, targets)
          done.push({
            sourceRef: { type: FLAVOR, id: s.sourceId },
            title: s.title,
            markdown: converted.markdown,
            tags: [],
            children: await finishParts(s.children),
            media: converted.media,
            order: s.order,
          })
        }
        return done
      }
      const children = await finishParts(subs)
      out.push({
        sourceRef: { type: FLAVOR, id: n.sourceId },
        title: n.title,
        markdown: file.markdown,
        tags: [],
        children,
        media: file.media,
        order: i,
      })
    }
    return out
  }

  tree.root = await build(plan)
  tree.unreferenced = attachments.filter((a) => !referenced.has(a))
  return tree
}
