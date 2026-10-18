import { describe, expect, it } from 'vitest'
import { buildPageContent, importUnchanged, mergeIntoExisting, readSource } from './frontmatter.js'

const source = { type: 'bookstack', id: '12', url: 'https://b/books/a/page/x' }

describe('buildPageContent', () => {
  it('writes id, title, tags and source, then the body', () => {
    const out = buildPageContent({ id: 'p-abc', title: 'Setup: Part 1', tags: ['ops'], source, body: '# Setup: Part 1\n\ntext\n' })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('id: p-abc')
    expect(out).toContain('title: "Setup: Part 1"')
    expect(out).toContain('tags:\n  - ops')
    expect(out).toContain('source:\n  type: bookstack\n  id: "12"\n  url: https://b/books/a/page/x')
    expect(out.endsWith('---\n\n# Setup: Part 1\n\ntext\n')).toBe(true)
  })
})

describe('readSource', () => {
  it('reads the source block back', () => {
    const content = buildPageContent({ id: 'p-abc', title: 'T', tags: [], source, body: 'x\n' })
    expect(readSource(content)).toEqual(source)
  })
  it('returns null without a source block', () => {
    expect(readSource('---\nid: p-1\ntitle: T\n---\nx\n')).toBeNull()
  })
})

describe('mergeIntoExisting', () => {
  it('keeps the f451 frontmatter, replaces tags and body', () => {
    const existing = '---\nid: p-abc\ntitle: T\ntags:\n  - old\nclassification: internal\nsource:\n  type: bookstack\n  id: "12"\n---\n\nold body\n'
    const out = mergeIntoExisting(existing, { title: 'T', tags: ['new'], body: 'new body\n' })
    expect(out).toContain('id: p-abc')
    expect(out).toContain('title: T')
    expect(out).toContain('classification: internal')
    expect(out).toContain('tags:\n  - new')
    expect(out).not.toContain('old')
    expect(out.endsWith('---\n\nnew body\n')).toBe(true)
  })
  it('writes a changed title', () => {
    const existing = '---\nid: p-abc\ntitle: Old\n---\n\nbody\n'
    const out = mergeIntoExisting(existing, { title: 'New name', tags: [], body: 'body\n' })
    expect(out).toContain('title: New name')
    expect(out).not.toContain('Old')
  })
})

describe('importUnchanged', () => {
  const existing = '---\nid: p-abc\ntitle: T\ntags:\n  - a\nversion: 1.0.0\n---\n\nbody\n'
  it('ignores front matter the import does not own', () => {
    expect(importUnchanged(existing, { title: 'T', tags: ['a'], body: 'body\n' })).toBe(true)
  })
  it('sees a changed body or tag list', () => {
    expect(importUnchanged(existing, { title: 'T', tags: ['a'], body: 'other\n' })).toBe(false)
    expect(importUnchanged(existing, { title: 'T', tags: ['a', 'b'], body: 'body\n' })).toBe(false)
  })
  it('sees a changed title', () => {
    expect(importUnchanged(existing, { title: 'T2', tags: ['a'], body: 'body\n' })).toBe(false)
  })
})
