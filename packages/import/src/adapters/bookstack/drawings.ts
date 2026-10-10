import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ImportMedia } from '../../model.js'
import type { BookStackClient } from './client.js'
import type { DrawingRef } from './html-to-md.js'
import { baseName, slugifyFileName, uniqueName } from './media.js'

export interface DrawioRenderer {
  /** draw.io XML in, SVG with the diagram embedded in `content` out. */
  render(xml: string): Promise<string>
}

/** Runs a program; rejects on a non-zero exit. Injectable so tests never
 *  spawn processes. */
export type Exec = (file: string, args: string[]) => Promise<unknown>

const IMAGE = 'rlespinasse/drawio-desktop-headless'
const RENDER_TIMEOUT_MS = 120_000

const execFileAsync = promisify(execFile)
const defaultExec: Exec = (file, args) => execFileAsync(file, args, { timeout: RENDER_TIMEOUT_MS })

/** Looks for `docker` or `podman`; returns a renderer that runs
 *  rlespinasse/drawio-desktop-headless, or null. Never throws. */
export async function detectDrawioRenderer(exec: Exec = defaultExec): Promise<DrawioRenderer | null> {
  for (const engine of ['docker', 'podman']) {
    try {
      await exec(engine, ['version'])
      return containerRenderer(engine, exec)
    } catch {
      /* not installed or not running; try the next one */
    }
  }
  return null
}

function containerRenderer(engine: string, exec: Exec): DrawioRenderer {
  return {
    async render(xml: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'f451-drawio-'))
      try {
        await writeFile(join(dir, 'in.drawio'), xml, 'utf8')
        await exec(engine, [
          'run', '--rm',
          '-v', `${dir}:/data`,
          IMAGE,
          '-x', '-f', 'svg', '--embed-diagram',
          '-o', '/data/out.svg',
          '/data/in.drawio',
        ])
        return await readFile(join(dir, 'out.svg'), 'utf8')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** draw.io PNGs carry the diagram in a tEXt chunk `mxfile` (URL-encoded). */
export function extractMxfile(png: Uint8Array): string | null {
  if (png.byteLength < 8 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const latin1 = new TextDecoder('latin1')
  let pos = 8
  while (pos + 8 <= png.byteLength) {
    const length = view.getUint32(pos)
    const type = latin1.decode(png.subarray(pos + 4, pos + 8))
    const start = pos + 8
    const end = start + length
    if (end + 4 > png.byteLength) return null
    if (type === 'tEXt') {
      const data = png.subarray(start, end)
      const sep = data.indexOf(0)
      if (sep > 0 && latin1.decode(data.subarray(0, sep)) === 'mxfile') {
        try {
          return decodeURIComponent(latin1.decode(data.subarray(sep + 1)))
        } catch {
          return null
        }
      }
    }
    if (type === 'IEND') return null
    pos = end + 4 // skip the CRC
  }
  return null
}

export interface DrawingsResult {
  markdown: string
  media: ImportMedia[]
  /** Drawings that stayed PNG (alt text, or the source URL without one). */
  asPng: string[]
}

/** Downloads each drawing's PNG. With a renderer and an embedded diagram it
 *  becomes an editable `<slug>.drawio.svg`; otherwise the PNG is kept as an
 *  image. Refs in the Markdown are rewritten to `_media/<name>`. A failed
 *  download leaves the ref untouched (media collection reports it later). */
export async function convertDrawings(
  drawings: DrawingRef[],
  markdown: string,
  client: BookStackClient,
  opts: { baseUrl: string; drawio: DrawioRenderer | null; usedNames?: Set<string> },
): Promise<DrawingsResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const used = opts.usedNames ?? new Set<string>()
  const media: ImportMedia[] = []
  const asPng: string[] = []
  const seen = new Set<string>()
  let out = markdown

  for (const drawing of drawings) {
    if (seen.has(drawing.src)) continue
    seen.add(drawing.src)

    let png: Uint8Array
    try {
      png = await client.downloadUrl(new URL(drawing.src, `${baseUrl}/`).href)
    } catch {
      continue
    }

    const pngName = slugifyFileName(baseName(drawing.src))
    const stem = pngName.replace(/\.png$/i, '') || 'drawing'
    const xml = opts.drawio ? extractMxfile(png) : null

    let item: ImportMedia | null = null
    if (xml !== null && opts.drawio) {
      try {
        const svg = await opts.drawio.render(xml)
        const name = uniqueName(`${stem}.drawio.svg`, used)
        item = { name, bytes: new TextEncoder().encode(svg), mime: 'image/svg+xml', kind: 'drawio', ref: `_media/${name}` }
      } catch {
        item = null // fall back to the PNG
      }
    }
    if (!item) {
      const name = uniqueName(pngName, used)
      item = { name, bytes: png, mime: 'image/png', kind: 'image', ref: `_media/${name}` }
      asPng.push(drawing.alt || drawing.src)
    }

    media.push(item)
    out = out.split(`![${drawing.alt}](${drawing.src})`).join(`![${drawing.alt}](${item.ref})`)
  }

  return { markdown: out, media, asPng }
}
