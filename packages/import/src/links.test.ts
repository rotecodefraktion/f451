import { describe, expect, it } from 'vitest'
import { rewriteLinks } from './links.js'

describe('rewriteLinks', () => {
  const ids = new Map([['12', 'p-abc'], ['7', 'p-def']])
  it('turns known placeholders into wikilinks with alias', () => {
    expect(rewriteLinks('see [Setup](source:12|https://b/x)', ids)).toBe('see [[p-abc|Setup]]')
  })
  it('falls back to the source URL for unknown targets', () => {
    expect(rewriteLinks('[Old](source:99|https://b/old)', ids)).toBe('[Old](https://b/old)')
  })
  it('leaves ordinary links alone', () => {
    expect(rewriteLinks('[x](https://e.com) ![i](_media/a.png)', ids)).toBe('[x](https://e.com) ![i](_media/a.png)')
  })
})
