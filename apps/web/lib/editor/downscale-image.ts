/** Downscaling of phone photos in the browser before upload (f451#2).
 *
 *  `downscaleTarget` is the pure decision (tested); `downscaleImage` does the
 *  browser work (createImageBitmap + canvas) and falls back to the original
 *  file whenever anything goes wrong. */

/** Upload limit of `POST /api/pages/:id/draft/media`. The web client does not
 *  know the configured value: this mirrors the API default
 *  (`F451_MAX_UPLOAD_MB`, default 10 MiB — `apps/api/src/drafts/upload.ts#DEFAULT_MAX_UPLOAD_MB`).
 *  An operator who lowers the limit gets a 413 for large files as before. */
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024

/** Longest edge of a downscaled photo, in pixels. */
export const MAX_EDGE = 2560

const JPEG_QUALITY = 0.85

const PHOTO_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/heic', 'image/heif'])
const OTHER_RASTER_TYPES = new Set(['image/png', 'image/webp', 'image/gif'])

export interface DownscaleTarget {
  width: number
  height: number
  type: 'image/jpeg'
  quality: number
}

function scaledTo(width: number, height: number, maxEdge: number): DownscaleTarget {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    type: 'image/jpeg',
    quality: JPEG_QUALITY,
  }
}

/** null = upload as is. JPEG/HEIC/HEIF: resized when the long edge > maxEdge or
 *  bytes > limit (then to maxEdge, keeping aspect, never upscaling) and
 *  re-encoded as JPEG — HEIC/HEIF are always re-encoded, since few browsers
 *  display them. PNG/WebP/GIF: only when bytes > limit (to maxEdge, as JPEG).
 *  Other types: null. Quality 0.85. Dimensions rounded. */
export function downscaleTarget(
  info: { type: string; width: number; height: number; bytes: number },
  limitBytes: number,
  maxEdge = MAX_EDGE,
): DownscaleTarget | null {
  const type = info.type.toLowerCase()
  if (!(info.width > 0 && info.height > 0)) return null
  const tooLarge = info.bytes > limitBytes
  if (PHOTO_TYPES.has(type)) {
    const isHeic = type === 'image/heic' || type === 'image/heif'
    const tooWide = Math.max(info.width, info.height) > maxEdge
    if (!isHeic && !tooWide && !tooLarge) return null
    return scaledTo(info.width, info.height, maxEdge)
  }
  if (OTHER_RASTER_TYPES.has(type)) {
    return tooLarge ? scaledTo(info.width, info.height, maxEdge) : null
  }
  return null
}

/** MIME type of the file; some browsers report HEIC photos with an empty type,
 *  so the extension decides then. */
function effectiveType(file: File): string {
  if (file.type) return file.type.toLowerCase()
  const name = file.name.toLowerCase()
  if (name.endsWith('.heic')) return 'image/heic'
  if (name.endsWith('.heif')) return 'image/heif'
  return ''
}

function jpegName(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return `${base || 'image'}.jpg`
}

async function encodeJpeg(bitmap: ImageBitmap, target: DownscaleTarget): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(target.width, target.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)
    return canvas.convertToBlob({ type: target.type, quality: target.quality })
  }
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, target.width, target.height)
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target.type, target.quality))
}

/** Decodes with createImageBitmap (imageOrientation: 'from-image'), draws to a
 *  canvas (OffscreenCanvas when available) at the target size, encodes JPEG;
 *  returns a new File named like the original with extension .jpg. Returns the
 *  original file when no target, when decoding fails (e.g. HEIC unsupported by
 *  the browser), or when the result is not smaller than the original. */
export async function downscaleImage(file: File, limitBytes: number): Promise<File> {
  const type = effectiveType(file)
  // Decide what we can without decoding: unknown types and small PNG/WebP/GIF
  // never change, so they skip the (expensive) decode.
  if (!PHOTO_TYPES.has(type) && !(OTHER_RASTER_TYPES.has(type) && file.size > limitBytes)) return file
  if (typeof createImageBitmap !== 'function') return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  try {
    const target = downscaleTarget(
      { type, width: bitmap.width, height: bitmap.height, bytes: file.size },
      limitBytes,
    )
    if (!target) return file
    const blob = await encodeJpeg(bitmap, target)
    if (!blob || blob.size >= file.size) return file
    return new File([blob], jpegName(file.name), { type: target.type, lastModified: file.lastModified })
  } catch {
    return file
  } finally {
    bitmap.close()
  }
}
