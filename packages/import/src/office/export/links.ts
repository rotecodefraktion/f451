// Link and media targets shared by the Word/PDF bundle and the Flat ODP.

import { slugify } from '@f451/markdown'
import { trimTrailingSlashes } from '../../url.js'
import type { ExportPageSource } from './load.js'

export interface ExportContext {
  space: string
  /** Absolute f451 base URL (`F451_PUBLIC_BASE_URL`), for links leaving the export. */
  publicBaseUrl: string
  /** Link target (id, path or title, as in a wikilink) → page id, or null. Built from
   *  the space tree (`pageResolver` of the BookStack export). */
  resolvePage(target: string): string | null
  /** `.drawio.svg` / `.excalidraw.svg` go into the file as PNG instead of SVG. */
  rasterDiagrams: boolean
}

const MEDIA_PREFIX = '_media/'
const DIAGRAM = /\.(drawio|excalidraw)\.svg$/i

export function isDiagram(name: string): boolean {
  return DIAGRAM.test(name)
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The file name after `_media/` of a link or image target, or null. */
export function mediaName(target: string): string | null {
  const t = target.replace(/^\.\//, '')
  return t.startsWith(MEDIA_PREFIX) && t.length > MEDIA_PREFIX.length ? t.slice(MEDIA_PREFIX.length) : null
}

/** The page's bytes for a media name as written in the Markdown (raw or decoded). */
export function pageMedia(page: ExportPageSource, name: string): Uint8Array | undefined {
  return page.media.get(name) ?? page.media.get(safeDecode(name))
}

/** An anchor per page (`p-<id>`, made safe for bookmark and slide names, unique). */
export function pageAnchors(pages: ExportPageSource[]): Map<string, string> {
  const anchors = new Map<string, string>()
  const used = new Set<string>()
  for (const p of pages) {
    const base = `p-${p.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
    let anchor = base
    for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`
    used.add(anchor)
    anchors.set(p.id, anchor)
  }
  return anchors
}

export interface ExportLinks {
  anchors: Map<string, string>
  /** A wiki link target (`target#section`): in-export → `#<anchor>` (with
   *  `withSections` → `#<anchor>-<section>`), other pages → absolute page URL,
   *  unknown → null. */
  pageHref(raw: string, withSections: boolean): string | null
  /** Absolute URL of a file in a page's `_media/` (published version). */
  mediaUrl(pageId: string, name: string): string
}

export function exportLinks(pages: ExportPageSource[], ctx: ExportContext): ExportLinks {
  const anchors = pageAnchors(pages)
  const base = trimTrailingSlashes(ctx.publicBaseUrl)
  return {
    anchors,
    pageHref(raw, withSections) {
      const hashAt = raw.indexOf('#')
      const target = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).trim()
      const section = hashAt >= 0 ? raw.slice(hashAt + 1).trim() : ''
      const id = target ? ctx.resolvePage(target) : null
      if (!id) return null
      const anchor = anchors.get(id)
      // A section is heading text or its slug; the heading ids are slugs.
      if (anchor !== undefined) {
        const slug = section ? slugify(safeDecode(section)) : ''
        return withSections && slug ? `#${anchor}-${slug}` : `#${anchor}`
      }
      const url = `${base}/wiki/${encodeURIComponent(ctx.space)}/${encodeURIComponent(id)}`
      return section ? `${url}#${encodeURIComponent(safeDecode(section))}` : url
    },
    mediaUrl(pageId, name) {
      const path = safeDecode(name).split('/').map(encodeURIComponent).join('/')
      return `${base}/media/${encodeURIComponent(pageId)}/${path}?ref=main`
    },
  }
}
