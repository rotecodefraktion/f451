import { describe, expect, it } from 'vitest'
import { caretScrollDelta } from './caret-scroll.js'

// Band with the defaults: [0 + 16, 600 − 44 − 16] = [16, 540].
const view = { top: 0, visibleBottom: 600 }
const toolbar = 44

describe('caretScrollDelta', () => {
  it('scrolls down exactly to the lower band edge when the caret is below it', () => {
    expect(caretScrollDelta({ top: 560, bottom: 580 }, view, toolbar)).toBe(40)
  })

  it('returns 0 when the caret is inside the band', () => {
    expect(caretScrollDelta({ top: 200, bottom: 220 }, view, toolbar)).toBe(0)
    expect(caretScrollDelta({ top: 16, bottom: 540 }, view, toolbar)).toBe(0)
  })

  it('scrolls up (negative) when the caret is above the band', () => {
    expect(caretScrollDelta({ top: 4, bottom: 24 }, view, toolbar)).toBe(-12)
  })

  it('counts the view top (e.g. a sticky header)', () => {
    expect(caretScrollDelta({ top: 50, bottom: 70 }, { top: 44, visibleBottom: 600 }, toolbar)).toBe(-10)
  })

  it('honours a custom margin', () => {
    // Band [0 + 32, 600 − 44 − 32] = [32, 524].
    expect(caretScrollDelta({ top: 510, bottom: 530 }, view, toolbar, 32)).toBe(6)
    expect(caretScrollDelta({ top: 20, bottom: 40 }, view, toolbar, 32)).toBe(-12)
    expect(caretScrollDelta({ top: 510, bottom: 530 }, view, toolbar, 0)).toBe(0)
  })
})
