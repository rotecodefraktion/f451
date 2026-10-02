import { describe, expect, it } from 'vitest'
import { checkValue } from '../src/grammar.js'

describe('checkValue', () => {
  it('hex: accepts 3 digits and alpha, normalises to lower case, rejects rgb() and names', () => {
    expect(checkValue({ kind: 'hex' }, '#FFF')).toEqual({ ok: true, value: '#fff' })
    expect(checkValue({ kind: 'hex' }, ' #FFFFFF80 ')).toEqual({ ok: true, value: '#ffffff80' })
    expect(checkValue({ kind: 'hex' }, '#ffffff80')).toEqual({ ok: true, value: '#ffffff80' })
    expect(checkValue({ kind: 'hex' }, 'rgb(0,0,0)').ok).toBe(false)
    expect(checkValue({ kind: 'hex' }, 'red').ok).toBe(false)
    expect(checkValue({ kind: 'hex' }, '#ggg').ok).toBe(false)
  })

  it('length: enforces unit and inclusive bounds', () => {
    const r = { kind: 'length', units: ['ch'], min: 60, max: 80 } as const
    expect(checkValue(r, '72ch')).toEqual({ ok: true, value: '72ch' })
    expect(checkValue(r, '60ch').ok).toBe(true)
    expect(checkValue(r, '80ch').ok).toBe(true)
    expect(checkValue(r, '90ch')).toEqual({ ok: false, reason: 'length: 90ch above max 80ch' })
    expect(checkValue(r, '50ch').ok).toBe(false)
    expect(checkValue(r, '72px').ok).toBe(false)
    expect(checkValue(r, 'calc(70ch)').ok).toBe(false)
  })

  it('number: bounds are inclusive, integer rejects fractions', () => {
    const r = { kind: 'number', min: 100, max: 900, integer: true } as const
    expect(checkValue(r, '400').ok).toBe(true)
    expect(checkValue(r, '100').ok).toBe(true)
    expect(checkValue(r, '900').ok).toBe(true)
    expect(checkValue(r, '450.5').ok).toBe(false)
    expect(checkValue(r, '901').ok).toBe(false)
    expect(checkValue(r, 'abc').ok).toBe(false)
    expect(checkValue({ kind: 'number', min: 0.5, max: 0.85 }, '0.7').ok).toBe(true)
  })

  it('duration: accepts ms within bounds, 0ms and bare 0', () => {
    const r = { kind: 'duration', min: 0, max: 400 } as const
    expect(checkValue(r, '0ms').ok).toBe(true)
    expect(checkValue(r, '0').ok).toBe(true)
    expect(checkValue(r, '400ms').ok).toBe(true)
    expect(checkValue(r, '401ms').ok).toBe(false)
    expect(checkValue(r, '1s').ok).toBe(false)
  })

  it('font-stack: accepts quoted families and generic keywords, rejects url( and @import', () => {
    const r = { kind: 'font-stack' } as const
    expect(checkValue(r, '"Source Serif 4", Georgia, serif').ok).toBe(true)
    expect(checkValue(r, "'Inter', system-ui, -apple-system, sans-serif").ok).toBe(true)
    expect(checkValue(r, 'url(https://x.test/f.woff2)').ok).toBe(false)
    expect(checkValue(r, '"A", url(x)').ok).toBe(false)
    expect(checkValue(r, '@import "x"').ok).toBe(false)
    expect(checkValue(r, 'serif; color: red').ok).toBe(false)
  })

  it('easing: accepts keywords and cubic-bezier, rejects linear(...)', () => {
    const r = { kind: 'easing' } as const
    expect(checkValue(r, 'ease-in-out').ok).toBe(true)
    expect(checkValue(r, 'cubic-bezier(0.2,0,0,1)').ok).toBe(true)
    expect(checkValue(r, 'cubic-bezier(1.2,0,0,1)').ok).toBe(false)
    expect(checkValue(r, 'linear(0, 0.5, 1)').ok).toBe(false)
  })

  it('shadow: accepts hex-coloured layers and inset, rejects url(', () => {
    const r = { kind: 'shadow' } as const
    expect(checkValue(r, '0 18px 48px #1c1a171f')).toEqual({ ok: true, value: '0 18px 48px #1c1a171f' })
    expect(checkValue(r, 'inset 0 1px 0 #FFF, 0 2px 4px #00000040')).toEqual({
      ok: true,
      value: 'inset 0 1px 0 #fff, 0 2px 4px #00000040',
    })
    expect(checkValue(r, '0 0 0 url(x)').ok).toBe(false)
    expect(checkValue(r, '0 18px 48px red').ok).toBe(false)
  })

  it('text-size: accepts rem and the restricted clamp(), rejects calc inside clamp()', () => {
    const r = { kind: 'text-size' } as const
    expect(checkValue(r, '1.125rem').ok).toBe(true)
    expect(checkValue(r, 'clamp(1rem, 0.9rem + 0.5vw, 1.25rem)').ok).toBe(true)
    expect(checkValue(r, 'clamp(1rem, calc(0.9rem + 0.5vw), 1.25rem)').ok).toBe(false)
    expect(checkValue(r, '7rem').ok).toBe(false)
    expect(checkValue(r, '16px').ok).toBe(false)
  })

  it('choice: exact match only', () => {
    const r = { kind: 'choice', values: ['decimal', 'none'] } as const
    expect(checkValue(r, 'decimal').ok).toBe(true)
    expect(checkValue(r, 'Decimal').ok).toBe(false)
    expect(checkValue(r, 'decimal none').ok).toBe(false)
  })
})
