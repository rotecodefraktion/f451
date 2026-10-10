import type { ImportMedia } from '../../model.js'
import type { BookStackClient } from './client.js'

export interface MediaOptions {
  baseUrl: string
  maxBytes: number
  /** Names already taken inside the page (shared with the drawings). */
  usedNames?: Set<string>
}

export interface MediaResult {
  markdown: string
  media: ImportMedia[]
  skipped: Array<{ name: string; reason: string }>
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** `![alt](dest)` with an optional title; `dest` may contain spaces because
 *  turndown copies the `src` attribute verbatim. */
const IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g

export function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/** Lowercase, everything outside `[a-z0-9._-]` becomes `-`, runs collapsed. */
export function slugifyFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'file'
}

/** Appends `-1`, `-2`, … before the extension until the name is free, then
 *  marks it as taken. `.drawio.svg` counts as one extension. */
export function uniqueName(name: string, used: Set<string>): string {
  const ext = name.endsWith('.drawio.svg') ? '.drawio.svg' : /\.[^.]+$/.exec(name)?.[0] ?? ''
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let n = 1; used.has(candidate); n++) candidate = `${stem}-${n}${ext}`
  used.add(candidate)
  return candidate
}

/** Last path segment of a URL, without query or fragment, percent-decoded. */
export function baseName(src: string): string {
  const path = src.split(/[?#]/)[0] ?? ''
  const last = path.split('/').pop() ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** Splits a Markdown link destination into the URL (without `<>` and title). */
function destinationUrl(dest: string): string {
  const d = dest.trim()
  if (d.startsWith('<')) {
    const end = d.indexOf('>')
    return end > 0 ? d.slice(1, end) : d.slice(1)
  }
  return d.replace(/\s+"[^"]*"$/, '').replace(/\s+'[^']*'$/, '')
}

function absoluteUrl(src: string, baseUrl: string): string {
  return new URL(src, `${baseUrl}/`).href
}

function isBookStackMedia(src: string, baseUrl: string): boolean {
  return src.startsWith('/uploads/') || src.startsWith(`${baseUrl}/uploads/`) || src.startsWith('/api/')
}

/** Downloads the images and attachments of a page. Image refs are rewritten
 *  to `_media/<name>`; attachments are appended as an `## Attachments` list.
 *  Files over `maxBytes` or failing to download are skipped and keep their
 *  absolute BookStack URL. */
export async function collectMedia(
  markdown: string,
  client: BookStackClient,
  pageId: number,
  opts: MediaOptions,
): Promise<MediaResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const used = opts.usedNames ?? new Set<string>()
  const media: ImportMedia[] = []
  const skipped: MediaResult['skipped'] = []

  // One download per distinct source; value is the new destination.
  const targets = new Map<string, string>()
  for (const match of markdown.matchAll(IMAGE)) {
    const src = destinationUrl(match[2] ?? '')
    if (!isBookStackMedia(src, baseUrl) || targets.has(src)) continue
    const absolute = absoluteUrl(src, baseUrl)
    const original = slugifyFileName(baseName(src))
    try {
      const bytes = await client.downloadUrl(absolute)
      if (bytes.byteLength > opts.maxBytes) {
        skipped.push({ name: original, reason: `too large (${bytes.byteLength} bytes)` })
        targets.set(src, absolute)
        continue
      }
      const name = uniqueName(original, used)
      const ref = `_media/${name}`
      media.push({ name, bytes, mime: mimeFor(name), kind: 'image', ref })
      targets.set(src, ref)
    } catch (error) {
      skipped.push({ name: original, reason: error instanceof Error ? error.message : String(error) })
      targets.set(src, absolute)
    }
  }

  let out = markdown.replace(IMAGE, (whole, alt: string, dest: string) => {
    const target = targets.get(destinationUrl(dest))
    return target === undefined ? whole : `![${alt}](${target})`
  })

  const lines: string[] = []
  const attachments = await client.getAttachmentsForPage(pageId)
  for (const a of [...attachments.data].sort((x, y) => x.order - y.order)) {
    const label = a.name || `attachment-${a.id}`
    if (a.external) {
      try {
        const detail = await client.getAttachment(a.id)
        lines.push(`- [${label}](${linkDestination(detail.content)})`)
      } catch (error) {
        skipped.push({ name: label, reason: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    const fileName = /\.[^./]+$/.test(a.name) || !a.extension ? a.name : `${a.name}.${a.extension}`
    const original = slugifyFileName(fileName)
    const sourceUrl = `${baseUrl}/attachments/${a.id}`
    try {
      const bytes = await client.getAttachmentContent(a.id)
      if (bytes.byteLength > opts.maxBytes) {
        skipped.push({ name: original, reason: `too large (${bytes.byteLength} bytes)` })
        lines.push(`- [${label}](${sourceUrl})`)
        continue
      }
      const name = uniqueName(original, used)
      const ref = `_media/${name}`
      media.push({ name, bytes, mime: mimeFor(name), kind: 'file', ref })
      lines.push(`- [${label}](${ref})`)
    } catch (error) {
      skipped.push({ name: original, reason: error instanceof Error ? error.message : String(error) })
      lines.push(`- [${label}](${sourceUrl})`)
    }
  }
  if (lines.length > 0) out = `${out.trimEnd()}\n\n## Attachments\n\n${lines.join('\n')}\n`

  return { markdown: out, media, skipped }
}

/** Wraps a destination in `<>` when it would otherwise end the link early. */
function linkDestination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url
}
