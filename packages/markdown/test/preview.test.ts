import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render.js'
import { previewText } from '../src/preview.js'

const render = (markdown: string): string => renderHtml(markdown, { resolveLink: () => null })

describe('previewText', () => {
  it('returns the first paragraph of the page; a leading h1 is no boundary', () => {
    const html = render('# Title\n\nFirst   paragraph\nwith a line break.\n\n## Setup\n\nSetup text.')
    expect(previewText(html)).toEqual({ text: 'First paragraph with a line break.', section: null })
  })

  it('returns the first paragraph after the heading of the section', () => {
    const html = render('# Title\n\nIntro.\n\n## Setup\n\nSetup text.\n\n## Usage\n\nUsage text.')
    expect(previewText(html, 'usage')).toEqual({ text: 'Usage text.', section: 'usage' })
  })

  it('falls back to the page start with section null for an unknown section', () => {
    const html = render('# Title\n\nIntro.\n\n## Setup\n\nSetup text.')
    expect(previewText(html, 'does-not-exist')).toEqual({ text: 'Intro.', section: null })
  })

  it('returns empty text when the section is directly followed by a heading of the same level', () => {
    const html = render('# Title\n\nIntro.\n\n## Empty\n\n## Next\n\nNext text.')
    expect(previewText(html, 'empty')).toEqual({ text: '', section: 'empty' })
  })

  it('cuts a long paragraph at a word boundary with an ellipsis', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`)
    const paragraph = words.join(' ')
    const { text } = previewText(render(paragraph))
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith('…')).toBe(true)
    const kept = text.slice(0, -1)
    expect(paragraph.startsWith(kept)).toBe(true)
    expect(paragraph.charAt(kept.length)).toBe(' ')
  })

  it('leaves out footnote reference numbers and footnote text', () => {
    const html = render('Text with a note[^1].\n\n[^1]: The note body.')
    expect(previewText(html)).toEqual({ text: 'Text with a note.', section: null })
  })

  it('returns empty text for a page without a paragraph', () => {
    const html = render('# Title\n\n## Only headings\n\n```\ncode\n```')
    expect(previewText(html)).toEqual({ text: '', section: null })
  })
})
