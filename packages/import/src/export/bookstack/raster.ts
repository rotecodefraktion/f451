import { crc32 } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'

/** One CSS argument: plain characters or a parenthesised group (one level deep, e.g. `rgb(…)`). */
const ARG = String.raw`(?:[^(),]|\([^()]*\))+`
const LIGHT_DARK = new RegExp(String.raw`light-dark\(\s*(${ARG}),\s*(${ARG})\)`, 'g')

/** Replaces every CSS `light-dark(a, b)` with `a`. draw.io writes colours that
 *  way; resvg does not know the function and would render them black. */
export function lightColours(svg: string): string {
  return svg.replace(LIGHT_DARK, (_, light: string) => light.trim())
}

/** Renders an SVG as PNG at twice its size on a white background. */
export function rasterizeSvg(svg: Uint8Array): Uint8Array {
  const source = lightColours(Buffer.from(svg).toString('utf8'))
  return new Resvg(source, { fitTo: { mode: 'zoom', value: 2 }, background: 'white' }).render().asPng()
}

/** Inserts a `tEXt` chunk `mxfile` with the URL-encoded diagram XML before
 *  IEND, the way draw.io (and BookStack's drawing editor) stores a diagram in a PNG. */
export function withMxfileChunk(png: Uint8Array, xml: string): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const latin1 = new TextDecoder('latin1')
  let iend = -1
  for (let pos = 8; pos + 8 <= png.byteLength; ) {
    const length = view.getUint32(pos)
    if (latin1.decode(png.subarray(pos + 4, pos + 8)) === 'IEND') {
      iend = pos
      break
    }
    pos += 12 + length
  }
  if (iend < 0) throw new Error('PNG without IEND chunk')

  const type = Buffer.from('tEXt', 'latin1')
  const data = Buffer.from(`mxfile\0${encodeURIComponent(xml)}`, 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(data, crc32(type)), 8 + data.length)

  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)])
}
