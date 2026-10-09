import { describe, expect, it } from 'vitest'
import { keyboardInset } from './keyboard-inset'

describe('keyboardInset', () => {
  it('is 0 with the keyboard closed', () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0)
  })
  it('is the covered height with the keyboard open (iOS)', () => {
    expect(keyboardInset(844, { height: 500, offsetTop: 0 })).toBe(344)
  })
  it('subtracts the scroll offset of the visual viewport', () => {
    expect(keyboardInset(844, { height: 500, offsetTop: 120 })).toBe(224)
  })
  it('never goes negative', () => {
    expect(keyboardInset(700, { height: 760, offsetTop: 0 })).toBe(0)
  })
  it('rounds fractional viewport sizes', () => {
    expect(keyboardInset(844, { height: 499.6, offsetTop: 0 })).toBe(344)
  })
})
