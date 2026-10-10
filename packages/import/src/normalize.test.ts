import { describe, expect, it } from 'vitest'
import { normalizeMarkdown } from './normalize.js'

describe('normalizeMarkdown', () => {
  it('keeps GFM tables, task lists and alerts', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n> [!NOTE]\n> hint\n'
    const { markdown, dropped } = normalizeMarkdown(src)
    expect(markdown).toContain('| a | b |')
    expect(markdown).toContain('- [x] done')
    expect(markdown).toContain('> [!NOTE]')
    expect(dropped).toEqual({})
  })

  it('turns raw HTML into its text and counts the tag', () => {
    const { markdown, dropped } = normalizeMarkdown('before <span style="color:red">red</span> after\n')
    expect(markdown).toBe('before red after\n')
    expect(dropped).toEqual({ span: 1 })
  })

  it('drops an HTML comment without a trace in the text', () => {
    const { markdown, dropped } = normalizeMarkdown('a\n\n<!-- note -->\n\nb\n')
    expect(markdown).toBe('a\n\nb\n')
    expect(dropped).toEqual({ '!--': 1 })
  })

  it('normalises bullets and fences', () => {
    const { markdown } = normalizeMarkdown('* one\n* two\n\n~~~js\nx\n~~~\n')
    expect(markdown).toBe('- one\n- two\n\n```js\nx\n```\n')
  })

  it('keeps link placeholders untouched', () => {
    const { markdown } = normalizeMarkdown('see [that](source:12|https://b/x)\n')
    expect(markdown).toBe('see [that](source:12|https://b/x)\n')
  })
})
