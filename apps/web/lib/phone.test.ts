import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPhoneLayout, PHONE_QUERY } from './phone.js'

describe('isPhoneLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false without window', () => {
    expect(typeof window).toBe('undefined')
    expect(isPhoneLayout()).toBe(false)
  })

  it('asks matchMedia with PHONE_QUERY and returns its answer', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true })
    vi.stubGlobal('window', { matchMedia })
    expect(isPhoneLayout()).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith(PHONE_QUERY)
  })

  it('is false when the query does not match', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false })
    vi.stubGlobal('window', { matchMedia })
    expect(isPhoneLayout()).toBe(false)
    expect(matchMedia).toHaveBeenCalledWith(PHONE_QUERY)
  })
})
