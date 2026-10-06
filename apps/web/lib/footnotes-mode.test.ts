import { describe, expect, it } from 'vitest'
import { placesFootnotes } from './footnotes-mode.js'

describe('placesFootnotes', () => {
  it('missing switches → Editorial default margin', () => {
    expect(placesFootnotes(undefined)).toBe(true)
    expect(placesFootnotes({})).toBe(true)
  })

  it('unknown value → Editorial default margin', () => {
    expect(placesFootnotes({ marginalia: 'sidebar' })).toBe(true)
    expect(placesFootnotes({ marginalia: 'margin' })).toBe(true)
  })

  it('list → end list, no placement', () => {
    expect(placesFootnotes({ marginalia: 'list' })).toBe(false)
  })
})
