import { createHash } from 'node:crypto'
import type { BookStackClient } from '../../adapters/bookstack/client.js'
import { diagramXml } from '../../svg-diagram.js'
import { rasterizeSvg, withMxfileChunk } from './raster.js'

type MediaClient = Pick<
  BookStackClient,
  'listGalleryImages' | 'uploadImage' | 'uploadAttachment' | 'getAttachmentsForPage'
>

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i
const SVG_EXT = /\.svg$/i
const DRAWIO_EXT = /\.drawio\.svg$/i
const HASH_LENGTH = 12

/** `_media/<name>` refs of Markdown images and links, unique, in order of appearance. */
export function mediaRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const m of markdown.matchAll(/\]\(\s*<?((?:\.\/)?_media\/[^)\s>]+)/g)) {
    refs.add(m[1]!.replace(/^\.\//, ''))
  }
  return [...refs]
}

/** Images (incl. `.drawio.svg` / `.excalidraw.svg`) go to the gallery, everything else is an attachment. */
export function isGalleryImage(name: string): boolean {
  return IMAGE_EXT.test(name)
}

function hashPrefix(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH)
}

/** `<sha256 first 12 hex>-<name>`: identical bytes always share the prefix. */
export function galleryName(name: string, bytes: Uint8Array): string {
  return `${hashPrefix(bytes)}-${name}`
}

export interface UploadedImage {
  url: string
  /** BookStack image id when the image is an editable drawing (`type=drawio`). */
  drawingId?: number
}

/** What goes to BookStack for one file: BookStack's gallery takes no SVG, so
 *  an SVG is rasterised; a `.drawio.svg` with an embedded diagram becomes a
 *  BookStack drawing (PNG carrying the diagram XML). */
function prepare(
  name: string,
  bytes: Uint8Array,
  prefix: string,
): { uploadName: string; bytes: Uint8Array; type: 'gallery' | 'drawio' } {
  if (!SVG_EXT.test(name)) return { uploadName: `${prefix}-${name}`, bytes, type: 'gallery' }
  const uploadName = `${prefix}-${name.replace(SVG_EXT, '')}.png`
  const xml = DRAWIO_EXT.test(name) ? diagramXml(bytes) : null
  if (xml !== null) return { uploadName, bytes: withMxfileChunk(rasterizeSvg(bytes), xml), type: 'drawio' }
  return { uploadName, bytes: rasterizeSvg(bytes), type: 'gallery' }
}

/** Uploads images to the gallery, reusing an existing image with the same content hash.
 *  The hash is taken over the original bytes, so a rasterised SVG is found again on
 *  the next run. Returns file name → image URL (and drawing id for draw.io diagrams). */
export async function uploadImages(
  client: MediaClient,
  bsPageId: number,
  files: Array<{ name: string; bytes: Uint8Array }>,
): Promise<Map<string, UploadedImage>> {
  const images = new Map<string, UploadedImage>()
  for (const file of files) {
    const prefix = hashPrefix(file.bytes)
    const existing = (await client.listGalleryImages(prefix)).find((i) => i.name.startsWith(prefix))
    if (existing) {
      images.set(file.name, existing.type === 'drawio' ? { url: existing.url, drawingId: existing.id } : { url: existing.url })
      continue
    }
    const upload = prepare(file.name, file.bytes, prefix)
    const uploaded = await client.uploadImage(
      bsPageId,
      upload.uploadName,
      upload.bytes as Uint8Array<ArrayBuffer>,
      upload.type,
    )
    images.set(file.name, upload.type === 'drawio' ? { url: uploaded.url, drawingId: uploaded.id } : { url: uploaded.url })
  }
  return images
}

/** Uploads attachments, skipping names the page already has. */
export async function uploadAttachments(
  client: MediaClient,
  bsPageId: number,
  files: Array<{ name: string; bytes: Uint8Array; mime: string }>,
  baseUrl: string,
): Promise<Map<string, string>> {
  /** name → BookStack attachment URL, for rewriting links to the file. */
  const urls = new Map<string, string>()
  if (files.length === 0) return urls
  const url = (id: number) => `${baseUrl.replace(/\/+$/, '')}/attachments/${id}`
  const present = new Map((await client.getAttachmentsForPage(bsPageId)).data.map((a) => [a.name, a.id] as const))
  for (const file of files) {
    const existing = present.get(file.name)
    if (existing !== undefined) {
      urls.set(file.name, url(existing))
      continue
    }
    const created = await client.uploadAttachment(bsPageId, file.name, file.bytes, file.mime)
    present.set(file.name, created.id)
    urls.set(file.name, url(created.id))
  }
  return urls
}
