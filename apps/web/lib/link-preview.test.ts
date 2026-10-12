import { describe, expect, it } from 'vitest'
import { previewPosition } from './link-preview.js'

const viewport = { width: 1000, height: 800 }
const box = { width: 300, height: 120 }

describe('previewPosition (#100)', () => {
  it('places the box below the link by default', () => {
    expect(previewPosition({ top: 100, bottom: 120, left: 200 }, box, viewport)).toEqual({
      top: 128,
      left: 200,
      placement: 'below',
    })
  })

  it('flips above when the box would overflow the bottom and there is room above', () => {
    expect(previewPosition({ top: 700, bottom: 720, left: 200 }, box, viewport)).toEqual({
      top: 700 - 8 - 120,
      left: 200,
      placement: 'above',
    })
  })

  it('clamps the box into the viewport on the right', () => {
    expect(previewPosition({ top: 100, bottom: 120, left: 900 }, box, viewport).left).toBe(1000 - 300 - 8)
  })

  it('clamps the box into the viewport on the left', () => {
    expect(previewPosition({ top: 100, bottom: 120, left: 2 }, box, viewport).left).toBe(8)
    expect(previewPosition({ top: 100, bottom: 120, left: 50 }, { width: 2000, height: 120 }, viewport).left).toBe(8)
  })

  it('stays below when there is no room either way', () => {
    const tall = { width: 300, height: 500 }
    const small = { width: 1000, height: 600 }
    expect(previewPosition({ top: 250, bottom: 270, left: 100 }, tall, small)).toEqual({
      top: 278,
      left: 100,
      placement: 'below',
    })
  })
})
