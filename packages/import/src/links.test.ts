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
  it('keeps an escaped separator, so a wikilink in a table cell does not split it', () => {
    expect(rewriteLinks('| [Setup](source:12\\|https://b/x) |', ids)).toBe('| [[p-abc\\|Setup]] |')
    expect(rewriteLinks('| [Old](source:99\\|https://b/old) |', ids)).toBe('| [Old](https://b/old) |')
  })
  it('carries a heading anchor from the placeholder id into the wikilink (#163)', () => {
    expect(rewriteLinks('[Scope](source:12#11-scope|#)', ids)).toBe('[[p-abc#11-scope|Scope]]')
    expect(rewriteLinks('| [Scope](source:12#11-scope\\|#) |', ids)).toBe('| [[p-abc#11-scope\\|Scope]] |')
  })
  it('falls back to the source URL for an unknown id with an anchor', () => {
    expect(rewriteLinks('[Old](source:99#x|https://b/old)', ids)).toBe('[Old](https://b/old)')
  })
  it('matches a source id that itself contains # before splitting off an anchor', () => {
    const withHash = new Map([['office:a#b.docx@1', 'p-hash']])
    expect(rewriteLinks('[A](source:office:a#b.docx@1|#)', withHash)).toBe('[[p-hash|A]]')
    expect(rewriteLinks('[A](source:office:a#b.docx@1#sec|#)', withHash)).toBe('[[p-hash#sec|A]]')
  })
  it('leaves ordinary links alone', () => {
    expect(rewriteLinks('[x](https://e.com) ![i](_media/a.png)', ids)).toBe('[x](https://e.com) ![i](_media/a.png)')
  })
})
