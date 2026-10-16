// Office export (spec 2026-10-16-office-export): published pages → bundle →
// convert service → docx, pdf, pptx or xlsx.

import { strToU8, zipSync } from 'fflate'
import { pageResolver } from '../../export/bookstack/html.js'
import { isGalleryImage, mediaRefs } from '../../export/bookstack/media.js'
import type { Converter } from '../converter.js'
import type { ExportTarget } from '../soffice.js'
import { buildHtmlBundle } from './bundle.js'
import { renderFodp } from './fodp.js'
import { buildFods } from './fods.js'
import { pageMedia, type ExportContext } from './links.js'
import { loadExportPages, type ExportF451Reader, type ExportPageSource } from './load.js'

export interface OfficeExportReport {
  pages: number
  /** Titles of slides with overflow risk (pptx only). */
  overfullSlides: string[]
  /** Images the pages show but whose file is missing (`<page title>: _media/<name>`). */
  droppedMedia: string[]
}

export interface OfficeExportOptions {
  space: string
  pageId: string
  subpages: boolean
  format: ExportTarget
  /** Absolute f451 base URL for links that leave the export. */
  publicBaseUrl: string
  maxPages?: number
  /** Per-conversion timeout passed to the convert service. */
  timeoutS?: number
  /** Diagrams as PNG instead of SVG (default false). */
  rasterDiagrams?: boolean
  /** Checked between pages and before the conversion. */
  signal?: AbortSignal
}

const MEDIA_PREFIX = '_media/'

/** Images referenced by the pages that did not load. */
function droppedMedia(pages: ExportPageSource[]): string[] {
  const out: string[] = []
  for (const p of pages) {
    for (const ref of mediaRefs(p.markdown)) {
      const name = ref.slice(MEDIA_PREFIX.length)
      if (isGalleryImage(name) && !pageMedia(p, name)) out.push(`${p.title}: ${ref}`)
    }
  }
  return out
}

/** The start page title as a file name: characters invalid on common file systems
 *  replaced by `_`, plus the extension. */
export function exportFileName(title: string, format: ExportTarget): string {
  const stem = [...title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim()]
    .slice(0, 150)
    .join('')
    .replace(/[. ]+$/, '')
  return `${stem || 'export'}.${format}`
}

export async function exportOffice(
  f451: ExportF451Reader,
  converter: Pick<Converter, 'fromBundle'>,
  opts: OfficeExportOptions,
): Promise<{ file: Uint8Array; fileName: string; report: OfficeExportReport }> {
  const roots = await f451.tree(opts.space)
  const pages = await loadExportPages(f451, {
    space: opts.space,
    pageId: opts.pageId,
    subpages: opts.subpages,
    maxPages: opts.maxPages,
    roots,
    signal: opts.signal,
  })
  const ctx: ExportContext = {
    space: opts.space,
    publicBaseUrl: opts.publicBaseUrl,
    resolvePage: pageResolver(roots),
    rasterDiagrams: opts.rasterDiagrams ?? false,
  }
  const report: OfficeExportReport = { pages: pages.length, overfullSlides: [], droppedMedia: droppedMedia(pages) }

  let bundle: Uint8Array
  switch (opts.format) {
    case 'docx':
    case 'pdf':
      bundle = buildHtmlBundle(pages, ctx)
      break
    case 'pptx': {
      // Images are inline (`office:binary-data`), so the bundle holds only the document.
      const fodp = renderFodp(pages, ctx)
      report.overfullSlides = fodp.overfullSlides
      bundle = zipSync({ 'document.fodp': strToU8(fodp.xml) })
      break
    }
    case 'xlsx':
      bundle = zipSync({ 'document.fods': strToU8(buildFods(pages)) })
      break
    default:
      throw new Error(`unknown export format "${String(opts.format)}"`)
  }

  opts.signal?.throwIfAborted()
  const file = await converter.fromBundle(bundle, opts.format, opts.timeoutS !== undefined ? { timeoutS: opts.timeoutS } : undefined)
  return { file, fileName: exportFileName(pages[0]!.title, opts.format), report }
}

export { buildHtmlBundle, renderExportHtml } from './bundle.js'
export { buildFodp, renderFodp } from './fodp.js'
export { buildFods, classifyCell, sheetName, NoTablesError } from './fods.js'
export { loadExportPages, TooManyPagesError, ExportPageNotFoundError } from './load.js'
export type { ExportPageSource, ExportF451Reader } from './load.js'
export type { ExportContext } from './links.js'
