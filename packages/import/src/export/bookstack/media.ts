import { createHash } from 'node:crypto'
import type { BookStackClient } from '../../adapters/bookstack/client.js'

type MediaClient = Pick<
  BookStackClient,
  'listGalleryImages' | 'uploadImage' | 'uploadAttachment' | 'getAttachmentsForPage'
>

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i
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

/** Uploads images to the gallery, reusing an existing image with the same content hash.
 *  Returns file name → image URL. */
export async function uploadImages(
  client: MediaClient,
  bsPageId: number,
  files: Array<{ name: string; bytes: Uint8Array }>,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  for (const file of files) {
    const prefix = hashPrefix(file.bytes)
    const existing = (await client.listGalleryImages(prefix)).find((i) => i.name.startsWith(prefix))
    if (existing) {
      urls.set(file.name, existing.url)
      continue
    }
    const uploaded = await client.uploadImage(
      bsPageId,
      `${prefix}-${file.name}`,
      file.bytes as Uint8Array<ArrayBuffer>,
    )
    urls.set(file.name, uploaded.url)
  }
  return urls
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
