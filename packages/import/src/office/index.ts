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
import type { Heading, Image, Link, Root } from 'mdast'
import { visit } from 'unist-util-visit'
import { htmlToMarkdown } from '../adapters/bookstack/html-to-md.js'
import { mimeFor, slugifyFileName, uniqueName } from '../adapters/bookstack/media.js'
import { isImagePath, rewriteLinksAndMedia, VaultIndex, type LinkContext } from '../adapters/markdown/links.js'
import { baseOf, buildStructure, classifyPaths, stripNoteExt, type PlanNode } from '../adapters/markdown/structure.js'
import { ArchiveRejectedError, type FileSource, type ZipLimits } from '../files/source.js'
import { zipSource } from '../files/zip.js'
import type { ImportMedia, ImportNode, ImportTree } from '../model.js'
import { normalizeMarkdown } from '../normalize.js'
import { applyCharts } from './charts.js'
import type { Converter } from './converter.js'
import { label, type Lang, type OfficeDoc, type OfficePart } from './doc.js'
import { expandSelfClosing, findAll, parseBody, prop } from './hast.js'
import { extensionOf, officeKind } from './kinds.js'
import { attachmentList, avMime, collectAttachments, type Attachment } from './media.js'
import { scanOdf } from './odf.js'
import { sheetsPrepass } from './sheets.js'
import { slidesPrepass } from './slides.js'
import { textPrepass } from './text.js'
import { Tokens } from './tokens.js'

export interface OfficeTreeOptions {
  converter: Converter
  /** Text at H1, one page per slide, one page per sheet. */
  split: boolean
  /** Language of generated names ("Folie n" / "Slide n", chart alt text); default `en`. */
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

interface Prepared {
  title: string
  fileBody: string
  parts: Array<{ title: string; body: string }>
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
  if (!url || EXTERNAL.test(url) || url.startsWith('/')) return url
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

function tryZip(bytes: Uint8Array, limits?: Partial<ZipLimits>): FileSource | null {
  try {
    return zipSource(bytes, limits)
  } catch {
    return null
  }
}

async function prepareFile(path: string, bytes: Uint8Array, opts: OfficeTreeOptions, lang: Lang): Promise<Prepared> {
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

  const bundle = await opts.converter.toHtml(bytes, baseOf(path))
  const scan = scanOdf(bundle.odf)
  const title = scan.title ?? stripNoteExt(baseOf(path), FLAVOR)
  const dropped: Record<string, number> = { ...scan.dropped }
  const notices: Prepared['notices'] = []
  if (pkg && !dropped.macro && (await pkg.list()).some((p) => /(^|\/)vbaProject\.bin$/i.test(p))) dropped.macro = 1

  const html = kind === 'slides' || /^\s*<\?xml/.test(bundle.html) ? expandSelfClosing(bundle.html) : bundle.html
  const body = parseBody(html)

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
    doc = textPrepass(body, { tokens, dropped, lang })
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

  let intro = doc.intro
  let parts: OfficePart[] = doc.parts
  // A document opening with its title as H1: that heading is the file page's,
  // not a first chapter of the same name.
  if (opts.split && kind === 'text' && isBlankHtml(intro) && parts[0] && sameTitle(parts[0].title, title)) {
    intro = parts[0].heading + parts[0].html
    parts = parts.slice(1)
  }

  const toMd = (fragment: string): string => {
    const converted = htmlToMarkdown(fragment, { baseUrl: '', resolveInternalLink: () => null })
    merge(dropped, converted.dropped)
    return tokens.resolve(converted.markdown)
  }
  let fileBody: string
  let partBodies: Prepared['parts'] = []
  if (opts.split) {
    fileBody = toMd(intro)
    partBodies = parts.map((p) => ({ title: p.title, body: toMd(p.html) }))
  } else {
    fileBody = toMd(intro + parts.map((p) => p.heading + p.html).join('\n'))
  }
  if (atEnd.length) fileBody = `${fileBody.trimEnd()}\n\n${attachmentList(atEnd, 2, href)}\n`

  return { title, fileBody, parts: partBodies, media, dropped, notices, truncated }
}

/** Loads Office files (`FileSource` of one file, a folder or a ZIP) into an
 *  `ImportTree`. Conversions run one at a time, in path order. */
export async function loadOfficeTree(src: FileSource, opts: OfficeTreeOptions): Promise<ImportTree> {
  const lang = opts.lang ?? 'en'
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
      prepared.set(path, await prepareFile(path, await src.read(path), opts, lang))
    } catch (e) {
      failures.set(path, e instanceof Error ? e.message : String(e))
    }
  }

  const plan = buildStructure(notes, (p) => prepared.get(p)?.title ?? stripNoteExt(baseOf(p), FLAVOR), FLAVOR)
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

  /** One page: link pass (links relative to `notePath`), media from `lookup`,
   *  the title as H1 unless the body already opens with it. */
  const convert = async (
    sourceId: string,
    title: string,
    notePath: string | null,
    body: string,
    lookup: Map<string, Uint8Array>,
  ): Promise<{ markdown: string; media: ImportMedia[] }> => {
    const ast = processor.parse(body) as Root
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
    if (first && first.type === 'heading' && sameTitle(headingText(first), title)) first.depth = 1
    else ast.children.unshift({ type: 'heading', depth: 1, children: [{ type: 'text', value: title }] })
    const normalized = normalizeMarkdown(processor.stringify(ast))
    merge(tree.droppedHtml, normalized.dropped)

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

  const build = async (nodes: PlanNode[]): Promise<ImportNode[]> => {
    const out: ImportNode[] = []
    for (const [i, n] of nodes.entries()) {
      if (!n.notePath) {
        const converted = await convert(n.sourceId, n.title, null, '', new Map())
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
      merge(tree.droppedHtml, p.dropped)
      for (const notice of p.notices) tree.mediaSkipped.push({ sourceId: n.sourceId, ...notice })
      for (const t of p.truncated) {
        truncated.push({ sourceId: t.part === null ? n.sourceId : `${n.sourceId}@${t.part + 1}`, sheet: t.sheet, rows: t.rows })
      }
      const file = await convert(n.sourceId, n.title, n.notePath, p.fileBody, p.media)
      const children: ImportNode[] = []
      for (const [k, part] of p.parts.entries()) {
        const id = `${n.sourceId}@${k + 1}`
        const converted = await convert(id, part.title, n.notePath, part.body, p.media)
        children.push({
          sourceRef: { type: FLAVOR, id },
          title: part.title,
          markdown: converted.markdown,
          tags: [],
          children: [],
          media: converted.media,
          order: k,
        })
      }
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
