// Adapted from BookBridge (github.com/rotecodefraktion/bookbridge)

import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, type ConversionContext } from './html-to-md.js'

const ctx: ConversionContext = {
  baseUrl: 'http://bookstack.local:6875',
  resolveInternalLink: () => null,
}

const md = (html: string, context: ConversionContext = ctx) => htmlToMarkdown(html, context).markdown

describe('htmlToMarkdown', () => {
  it('converts basic paragraph', () => {
    expect(md('<p>Hello world</p>').trim()).toBe('Hello world')
  })

  it('converts heading', () => {
    expect(md('<h2>Title</h2>').trim()).toBe('## Title')
  })

  it('converts callout outside table', () => {
    const result = md('<p class="callout danger">Important warning</p>')
    expect(result).toContain('> [!CAUTION]')
    expect(result).toContain('> Important warning')
  })

  it('maps the four callouts', () => {
    const html = '<p class="callout info">a</p><p class="callout success">b</p><p class="callout warning">c</p><p class="callout danger">d</p>'
    const { markdown } = htmlToMarkdown(html, ctx)
    expect(markdown).toContain('> [!NOTE]\n> a')
    expect(markdown).toContain('> [!TIP]\n> b')
    expect(markdown).toContain('> [!WARNING]\n> c')
    expect(markdown).toContain('> [!CAUTION]\n> d')
  })

  it('converts callout INSIDE table cell to a plain-text label', () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Status</th></tr>
        <tr><td>Item 1</td><td><p class="callout danger">open</p></td></tr>
      </table>
    `
    const result = md(html)
    expect(result).not.toContain('> [!')
    expect(result).toContain('Caution: open')
    expect(result).not.toContain('🔴')
  })

  it('converts code block with language', () => {
    const result = md('<pre><code class="language-typescript">const x = 1;</code></pre>')
    expect(result).toContain('```typescript')
    expect(result).toContain('const x = 1;')
  })

  it('converts linked image to plain image (strips <a> wrapper)', () => {
    const html = '<a href="http://bookstack.local:6875/uploads/images/gallery/img.png"><img src="http://bookstack.local:6875/uploads/images/gallery/img.png" alt="photo"></a>'
    const result = md(html)
    expect(result).toContain('![photo](http://bookstack.local:6875/uploads/images/gallery/img.png)')
    expect(result).not.toContain('[![')
  })

  it('turns a resolved internal link into a placeholder', () => {
    const ctx2 = { baseUrl: 'https://b', resolveInternalLink: () => ({ id: '12', url: 'https://b/books/a/page/x' }) }
    expect(htmlToMarkdown('<a href="/books/a/page/x">Go</a>', ctx2).markdown.trim()).toBe('[Go](source:12|https://b/books/a/page/x)')
  })

  it('passes the original href to the resolver for all link forms', () => {
    const seen: string[] = []
    const ctx2: ConversionContext = {
      baseUrl: 'https://b/',
      resolveInternalLink: (href) => {
        seen.push(href)
        return null
      },
    }
    md('<a href="/books/a/page/x">1</a> <a href="https://b/books/a/page/y">2</a> <a href="/link/7">3</a> <a href="https://b/link/8">4</a> <a href="https://elsewhere/books/a/page/z">5</a>', ctx2)
    expect(seen).toEqual(['/books/a/page/x', 'https://b/books/a/page/y', '/link/7', 'https://b/link/8'])
  })

  it('keeps an unresolved internal link as absolute URL', () => {
    const result = md('<a href="/books/my-book/page/unknown-page">Click here</a>')
    expect(result.trim()).toBe('[Click here](http://bookstack.local:6875/books/my-book/page/unknown-page)')
    expect(md('<a href="/link/42">x</a>').trim()).toBe('[x](http://bookstack.local:6875/link/42)')
  })

  it('returns empty for empty input', () => {
    expect(htmlToMarkdown('', ctx)).toEqual({ markdown: '', drawings: [], dropped: {} })
    expect(md('   ')).toBe('')
    expect(md(null as unknown as string)).toBe('')
  })

  it('throws on conversion failure instead of embedding HTML', () => {
    const failing: ConversionContext = {
      baseUrl: 'https://b',
      resolveInternalLink: () => {
        throw new Error('boom')
      },
    }
    expect(() => htmlToMarkdown('<a href="/books/a/page/x">Go</a>', failing)).toThrow(/HTML conversion failed: boom/)
  })

  it('converts YouTube iframe to thumbnail link', () => {
    const result = md('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>')
    expect(result).toContain('[![YouTube]')
    expect(result).toContain('img.youtube.com/vi/dQw4w9WgXcQ')
    expect(result).toContain('youtube.com/watch?v=dQw4w9WgXcQ')
  })

  it('converts YouTube nocookie iframe to thumbnail link', () => {
    const result = md('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>')
    expect(result).toContain('[![YouTube]')
    expect(result).toContain('img.youtube.com/vi/dQw4w9WgXcQ')
  })

  it('converts details/summary to a NOTE alert with bold title', () => {
    const result = md('<details><summary>Click me</summary><p>Hidden content</p></details>')
    expect(result).toContain('> [!NOTE] **Click me**\n> Hidden content')
    expect(result).not.toContain('[!example]')
  })

  it('collects drawings and keeps the image', () => {
    const r = htmlToMarkdown('<div drawio-diagram="5"><img src="/uploads/images/drawio/d.png" alt="flow"></div>', ctx)
    expect(r.drawings).toEqual([{ id: '5', src: '/uploads/images/drawio/d.png', alt: 'flow' }])
    expect(r.markdown.trim()).toBe('![flow](/uploads/images/drawio/d.png)')
  })

  it('counts a drawing without image as dropped', () => {
    const r = htmlToMarkdown('<div drawio-diagram="281"><span>drawing</span></div>', ctx)
    expect(r.drawings).toEqual([])
    expect(r.markdown.trim()).toBe('')
    expect(r.dropped).toEqual({ drawing: 1 })
  })

  it('expands a colspan header into a valid table and counts it', () => {
    const r = htmlToMarkdown('<table><tr><th colspan="2">h</th></tr><tr><td>1</td><td>2</td></tr></table>', ctx)
    const lines = tableLines(r.markdown)
    expect(lines).toHaveLength(3)
    expect(cellCount(lines[0]!)).toBe(2)
    expect(cellCount(lines[1]!)).toBe(2)
    expect(lines[1]).toMatch(/^\|\s*---\s*\|\s*---\s*\|$/)
    expect(lines[2]).toMatch(/^\|\s*1\s*\|\s*2\s*\|$/)
    expect(r.markdown).not.toContain('<')
    expect(r.dropped).toEqual({ colspan: 1 })
  })

  it('expands a rowspan cell into an empty cell in the following row', () => {
    const html = '<table><tr><th>a</th><th>b</th></tr><tr><td rowspan="2">x</td><td>1</td></tr><tr><td>2</td></tr></table>'
    const r = htmlToMarkdown(html, ctx)
    const lines = tableLines(r.markdown)
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(cellCount(line)).toBe(2)
    expect(lines[2]).toMatch(/^\|\s*x\s*\|\s*1\s*\|$/)
    expect(lines[3]).toMatch(/^\|\s*\|\s*2\s*\|$/)
    expect(r.markdown).not.toContain('<')
    expect(r.dropped).toEqual({ rowspan: 1 })
  })

  it('keeps one header row for a two-row thead with a rowspan header cell', () => {
    const html =
      '<table><thead><tr><th rowspan="2">a</th><th>b</th></tr><tr><th>c</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    const r = htmlToMarkdown(html, ctx)
    const lines = tableLines(r.markdown)
    expect(lines).toHaveLength(4)
    expect(lines.filter((line) => /^\|(\s*:?-{3,}:?\s*\|)+$/.test(line))).toHaveLength(1)
    for (const line of lines) expect(cellCount(line)).toBe(2)
    expect(lines[0]).toMatch(/^\|\s*a\s*\|\s*b\s*\|$/)
    expect(lines[2]).toMatch(/^\|\s*\|\s*c\s*\|$/)
    expect(lines[3]).toMatch(/^\|\s*1\s*\|\s*2\s*\|$/)
    expect(r.markdown).not.toContain('<')
    expect(r.dropped).toEqual({ rowspan: 1 })
  })

  it('flattens a list in a cell to items joined with "; "', () => {
    const html = '<table><tr><th>k</th><th>v</th></tr><tr><td>list</td><td><ul><li>a</li><li>b</li></ul></td></tr></table>'
    const r = htmlToMarkdown(html, ctx)
    expect(r.markdown).toMatch(/^\|\s*list\s*\|\s*a; b\s*\|$/m)
    expect(r.markdown).not.toContain('<')
    expect(r.markdown).not.toContain('joplin-table-wrapper')
    expect(r.dropped).toEqual({ tableBlock: 1 })
  })

  it('flattens a code block in a cell to inline code', () => {
    const html = '<table><tr><th>k</th><th>v</th></tr><tr><td>code</td><td><pre><code>x\ny</code></pre></td></tr></table>'
    const r = htmlToMarkdown(html, ctx)
    expect(r.markdown).toContain('`x y`')
    expect(r.markdown).not.toContain('```')
    expect(r.markdown).not.toContain('<')
    expect(r.dropped).toEqual({ tableBlock: 1 })
  })
})

/** The lines of the GFM table in `markdown`. */
function tableLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
}

/** Cells in a table line that starts and ends with a pipe (no escaped pipes). */
function cellCount(line: string): number {
  return line.split('|').length - 2
}
