import { describe, expect, it } from 'vitest'
import { trimTrailingSlashes } from './url.js'

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('http://x:6875///')).toBe('http://x:6875')
    expect(trimTrailingSlashes('http://x/a/b')).toBe('http://x/a/b')
    expect(trimTrailingSlashes('///')).toBe('')
    expect(trimTrailingSlashes('')).toBe('')
  })

  it('stays linear on long runs of slashes', () => {
    const s = 'a' + '/'.repeat(200_000) + 'b'
    expect(trimTrailingSlashes(s)).toBe(s)
  })
})
