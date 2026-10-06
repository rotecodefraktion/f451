import { readFileSync } from 'node:fs'
import { fromHtml } from 'hast-util-from-html'
import { describe, expect, it } from 'vitest'
import { placeFootnotes, renderHtml } from '../src/index.js'

interface N {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: N[]
  value?: string
}

function render(md: string): string {
  return renderHtml(md, { resolveLink: () => null })
}

function tree(html: string): N {
  return fromHtml(html, { fragment: true }) as unknown as N
}

function findAll(node: N, pred: (n: N) => boolean): N[] {
  const out: N[] = []
  for (const child of node.children ?? []) {
    if (child.type === 'element' && pred(child)) out.push(child)
    out.push(...findAll(child, pred))
  }
  return out
}

function classes(n: N): string[] {
  return (n.properties?.className as string[] | undefined) ?? []
}

function text(n: N): string {
  if (typeof n.value === 'string') return n.value
  return (n.children ?? []).map(text).join('')
}

function elements(n: N): N[] {
  return (n.children ?? []).filter((c) => c.type === 'element')
}

const has = (n: N, prop: string) => n.properties?.[prop] !== undefined
const isSection = (n: N) => n.tagName === 'section' && has(n, 'dataFootnotes')
const isRef = (n: N) => n.tagName === 'a' && has(n, 'dataFootnoteRef')
const isAside = (n: N) => n.tagName === 'aside' && classes(n).includes('note')
const isHost = (n: N) => n.tagName === 'div' && classes(n).includes('note-host')

describe('renderHtml: GFM footnote section', () => {
  const fixture = readFileSync(new URL('./fixtures/canonical/footnotes.md', import.meta.url), 'utf8')
  const root = tree(render(fixture))

  it('renders an empty p.footnotes-title inside section[data-footnotes] and no h2', () => {
    const [section] = findAll(root, isSection)
    expect(section).toBeDefined()
    const titles = findAll(section, (n) => n.tagName === 'p' && classes(n).includes('footnotes-title'))
    expect(titles).toHaveLength(1)
    expect(text(titles[0])).toBe('')
    expect(findAll(section, (n) => n.tagName === 'h2')).toHaveLength(0)
  })

  it('keeps the label id untouched, so aria-describedby on refs points at an existing id', () => {
    const refs = findAll(root, isRef)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const describedBy = [ref.properties?.ariaDescribedBy].flat().join(' ')
      expect(describedBy).toBe('footnote-label')
      expect(findAll(root, (n) => n.properties?.id === describedBy)).toHaveLength(1)
    }
  })
})

describe('placeFootnotes', () => {
  it('moves a single-paragraph footnote next to its reference and removes the section', () => {
    const root = tree(placeFootnotes(render('Text with a note.[^1]\n\n[^1]: The note.\n')))
    const [host] = elements(root)
    expect(isHost(host)).toBe(true)
    const [aside, p] = elements(host)
    expect(isAside(aside)).toBe(true)
    expect(aside.properties?.id).toBe('user-content-fn-1')
    expect(aside.properties?.role).toBe('note')
    expect(p.tagName).toBe('p')

    const [label] = elements(aside)
    expect(label.tagName).toBe('a')
    expect(classes(label)).toEqual(['note__label'])
    expect(label.properties?.href).toBe('#user-content-fnref-1')
    expect(text(label)).toBe('1')
    expect(text(aside)).toBe('1 The note.')

    expect(findAll(root, isSection)).toHaveLength(0)
    expect(findAll(root, (n) => has(n, 'ariaDescribedBy'))).toHaveLength(0)
    expect(findAll(root, (n) => has(n, 'dataFootnoteBackref'))).toHaveLength(0)
  })

  it('leaves a block-content footnote in the list while the paragraph one moves', () => {
    const md = 'One.[^a] Two.[^b]\n\n[^a]: Short.\n\n[^b]: First.\n\n    Second.\n'
    const root = tree(placeFootnotes(render(md)))
    const asides = findAll(root, isAside)
    expect(asides.map((a) => a.properties?.id)).toEqual(['user-content-fn-a'])

    const [section] = findAll(root, isSection)
    expect(section).toBeDefined()
    expect(findAll(section, (n) => classes(n).includes('footnotes-title'))).toHaveLength(1)
    const items = findAll(section, (n) => n.tagName === 'li')
    expect(items.map((li) => li.properties?.id)).toEqual(['user-content-fn-b'])
    // The label still exists, so the refs keep describing it.
    expect(findAll(root, isRef).every((ref) => has(ref, 'ariaDescribedBy'))).toBe(true)
  })

  it('keeps the original number on a note that stays in the list (li value)', () => {
    const html = render('A[^x] B[^1] C[^y]\n\n[^x]: short.\n[^1]: first.\n\n    second.\n[^y]: short too.\n')
    const out = placeFootnotes(html)
    expect(out).toContain('<li id="user-content-fn-1" value="2">')
    expect(out).not.toContain('value="1"')
    expect(out).not.toContain('value="3"')
  })

  it('creates one aside for two references to the same note; both refs keep their href', () => {
    const root = tree(placeFootnotes(render('First.[^1]\n\nSecond.[^1]\n\n[^1]: Shared.\n')))
    expect(findAll(root, isAside)).toHaveLength(1)
    const refs = findAll(root, isRef)
    expect(refs).toHaveLength(2)
    expect(refs.map((r) => r.properties?.href)).toEqual(['#user-content-fn-1', '#user-content-fn-1'])
    const [host] = elements(root)
    expect(isHost(host)).toBe(true)
    expect(text(elements(host)[1])).toContain('First.')
  })

  it('uses the whole list as host when the reference sits in a list item', () => {
    const root = tree(placeFootnotes(render('- Item with a note.[^1]\n- Other item\n\n[^1]: Note.\n')))
    const [host] = elements(root)
    expect(isHost(host)).toBe(true)
    expect(elements(host).map((n) => n.tagName)).toEqual(['aside', 'ul'])
  })

  it('uses the heading as host when the reference sits in a heading', () => {
    const root = tree(placeFootnotes(render('## Heading[^1]\n\n[^1]: Note.\n')))
    const [host] = elements(root)
    expect(isHost(host)).toBe(true)
    expect(elements(host).map((n) => n.tagName)).toEqual(['aside', 'h2'])
  })

  it('returns input without footnotes unchanged', () => {
    const html = render('# Title\n\nPlain text.\n')
    expect(placeFootnotes(html)).toBe(html)
  })

  it('still relocates notes in the pre-release markup (h2#footnote-label)', () => {
    const legacy =
      '<p>Text.<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref="" aria-describedby="footnote-label">1</a></sup></p>\n'
      + '<section data-footnotes="" class="footnotes"><h2 id="footnote-label" class="sr-only">Footnotes</h2>\n'
      + '<ol>\n<li id="user-content-fn-1">\n'
      + '<p>Old note. <a href="#user-content-fnref-1" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">↩</a></p>\n'
      + '</li>\n</ol>\n</section>'
    const root = tree(placeFootnotes(legacy))
    const asides = findAll(root, isAside)
    expect(asides).toHaveLength(1)
    expect(text(asides[0])).toBe('1 Old note.')
    expect(findAll(root, isSection)).toHaveLength(0)
    expect(findAll(root, (n) => n.tagName === 'h2')).toHaveLength(0)
  })
})
