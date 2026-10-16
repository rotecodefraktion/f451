// Video and audio embedded in an Office file become attachments (spec
// 2026-10-16-office-import §3 "Charts, SmartArt, media"): entries of the
// package (OOXML `*/media/*`, ODF `Pictures/` and `Media/`) with a video or
// audio extension. For presentations they are placed with their slide when
// the package says which slide uses them.

import type { FileSource } from '../files/source.js'
import { baseOf, dirOf } from '../adapters/markdown/structure.js'
import { normalizePath } from '../adapters/markdown/links.js'
import { extensionOf } from './kinds.js'
import type { OdfPage } from './odf.js'
import { xmlEvents } from './xml.js'

const AV_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
}

export function avMime(name: string): string | null {
  return AV_MIME[extensionOf(name)] ?? null
}

export interface Attachment {
  /** Entry path inside the Office package. */
  path: string
  name: string
  bytes: Uint8Array
  /** 0-based slide index, or null for "end of the page". */
  slide: number | null
}

function isEmbeddedMedia(path: string): boolean {
  return (/(^|\/)media\/[^/]+$/i.test(path) || /^(Pictures|Media)\/[^/]+$/.test(path)) && avMime(path) !== null
}

async function readText(pkg: FileSource, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await pkg.read(path))
  } catch {
    return null
  }
}

/** `rels` targets of a part: relationship id → package path. */
async function relationships(pkg: FileSource, part: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const xml = await readText(pkg, `${dirOf(part) ? `${dirOf(part)}/` : ''}_rels/${baseOf(part)}.rels`)
  if (!xml) return out
  for (const ev of xmlEvents(xml)) {
    if (ev.type !== 'open' || ev.name !== 'Relationship' || ev.attrs.TargetMode === 'External') continue
    const target = ev.attrs.Target ?? ''
    const path = target.startsWith('/') ? normalizePath(target.slice(1)) : normalizePath(`${dirOf(part)}/${target}`)
    if (ev.attrs.Id && path) out.set(ev.attrs.Id, path)
  }
  return out
}

/** PowerPoint: media path → index of the first slide that references it. */
async function pptxSlides(pkg: FileSource): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const presentation = 'ppt/presentation.xml'
  const xml = await readText(pkg, presentation)
  if (!xml) return out
  const rels = await relationships(pkg, presentation)
  const slides: string[] = []
  for (const ev of xmlEvents(xml)) {
    if (ev.type === 'open' && ev.name === 'p:sldId') {
      const target = rels.get(ev.attrs['r:id'] ?? '')
      if (target) slides.push(target)
    }
  }
  for (const [i, slide] of slides.entries()) {
    for (const target of (await relationships(pkg, slide)).values()) if (!out.has(target)) out.set(target, i)
  }
  return out
}

/** ODF: media path → index of the slide whose `draw:plugin` uses it. */
function odfSlides(pages: OdfPage[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const [i, page] of pages.entries()) {
    for (const href of page.media) {
      const path = normalizePath(href.replace(/^\.\//, ''))
      if (path && !out.has(path)) out.set(path, i)
    }
  }
  return out
}

/** Collects the video and audio entries of `pkg`, the Office file as a ZIP. */
export async function collectAttachments(pkg: FileSource, opts: { pptx: boolean; pages: OdfPage[] }): Promise<Attachment[]> {
  const paths = (await pkg.list()).filter(isEmbeddedMedia)
  if (paths.length === 0) return []
  const slides = opts.pptx ? await pptxSlides(pkg) : odfSlides(opts.pages)
  const out: Attachment[] = []
  for (const path of paths) {
    try {
      out.push({ path, name: baseOf(path), bytes: await pkg.read(path), slide: slides.get(path) ?? null })
    } catch {
      // An unreadable entry was already accepted by the ZIP check; skip it.
    }
  }
  return out
}

function escapeLinkText(s: string): string {
  return s.replace(/[\\[\]*_`<>]/g, (c) => `\\${c}`)
}

/** The "Anhänge" list (fixed heading, client 2026-10-16); `href` maps an
 *  attachment to the destination the media pass resolves. */
export function attachmentList(items: Attachment[], depth: number, href: (a: Attachment) => string): string {
  const lines = items.map((a) => `- [${escapeLinkText(a.name)}](${href(a)})`)
  return `${'#'.repeat(depth)} Anhänge\n\n${lines.join('\n')}`
}
