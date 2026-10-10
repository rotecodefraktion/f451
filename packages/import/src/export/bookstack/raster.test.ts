import { describe, expect, it } from 'vitest'
import { extractMxfile } from '../../adapters/bookstack/drawings.js'
import { lightColours, rasterizeSvg, withMxfileChunk } from './raster.js'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const svg = (s: string) => new TextEncoder().encode(s)

describe('lightColours', () => {
  it('keeps the light argument of light-dark()', () => {
    expect(lightColours('fill="light-dark(#5a6b85,#8a94a6)"')).toBe('fill="#5a6b85"')
    expect(lightColours('color: light-dark(rgb(1, 2, 3), #000);')).toBe('color: rgb(1, 2, 3);')
    expect(lightColours('a light-dark(#fff, rgb(0,0,0)) b light-dark(red,blue)')).toBe('a #fff b red')
  })

  it('leaves other content alone', () => {
    expect(lightColours('<rect fill="#ff0000"/>')).toBe('<rect fill="#ff0000"/>')
  })
})

describe('rasterizeSvg', () => {
  it('renders a PNG', () => {
    const png = rasterizeSvg(
      svg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
          '<rect width="10" height="10" fill="light-dark(#ff0000,#000000)"/></svg>',
      ),
    )
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
  })
})

describe('withMxfileChunk', () => {
  it('round-trips the diagram through extractMxfile', () => {
    const png = rasterizeSvg(svg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'))
    const xml = '<mxfile><diagram name="Seite 1 – ä">&lt;x&gt;</diagram></mxfile>'
    const out = withMxfileChunk(png, xml)
    expect([...out.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
    expect(extractMxfile(out)).toBe(xml)
    expect(extractMxfile(png)).toBeNull()
  })
})
