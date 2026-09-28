import { describe, expect, it } from 'vitest'
import { cookiePrefix } from '../src/auth/sessions.js'

describe('cookiePrefix (F451_COOKIE_PREFIX)', () => {
  it('defaults to f451 when unset or empty', () => {
    expect(cookiePrefix(undefined)).toBe('f451')
    expect(cookiePrefix('')).toBe('f451')
  })

  it('accepts letters, digits, "_" and "-"', () => {
    expect(cookiePrefix('f451-demo_2')).toBe('f451-demo_2')
  })

  it('rejects characters that are not valid in a cookie name', () => {
    expect(() => cookiePrefix('f451 demo')).toThrow(/F451_COOKIE_PREFIX/)
    expect(() => cookiePrefix('f451;x')).toThrow(/F451_COOKIE_PREFIX/)
  })
})
