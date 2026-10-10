import type { TreeNode } from '../../api.js'
import { describe, expect, it } from 'vitest'
import { pageResolver, renderForBookStack, type HtmlContext } from './html.js'

const ctx: HtmlContext = {
  bookstackUrls: new Map(),
  f451Url: 'https://f451.example',
  space: 'docs',
  imageUrls: new Map(),
  attachmentUrls: new Map(),
  resolvePage: () => null,
}

describe('renderForBookStack', () => {
  it('turns alerts into BookStack callouts', () => {
    const { html } = renderForBookStack('> [!TIP]\n> good\n', 'p-a', ctx)
    expect(html).toContain('<p class="callout success">good</p>')
    expect(html).not.toContain('alert')
  })

  it('maps every alert kind to a callout type', () => {
    const cases: Array<[string, string]> = [
      ['NOTE', 'info'],
      ['TIP', 'success'],
      ['IMPORTANT', 'warning'],
      ['WARNING', 'warning'],
      ['CAUTION', 'danger'],
    ]
    for (const [marker, type] of cases) {
      const { html } = renderForBookStack(`> [!${marker}]\n> x\n`, 'p-a', ctx)
      expect(html).toContain(`<p class="callout ${type}">x</p>`)
    }
  })

  it('joins callout paragraphs with <br> and keeps inline markup', () => {
    const { html } = renderForBookStack('> [!NOTE]\n> one **bold**\n>\n> two\n', 'p-a', ctx)
    expect(html).toContain('<p class="callout info">one <strong>bold</strong><br>two</p>')
  })

  it('links exported pages to BookStack and others to f451', () => {
    const ctx2 = {
      ...ctx,
      bookstackUrls: new Map([['p-b', 'https://bs/books/x/page/b']]),
      resolvePage: (t: string) => (['p-b', 'p-c'] as string[]).includes(t) ? t : null,
    }
    const { html, brokenLinks } = renderForBookStack('[[p-b|B]] and [[p-c|C]]', 'p-a', ctx2)
    expect(html).toContain('href="https://bs/books/x/page/b"')
    expect(html).toContain(`href="${ctx.f451Url}/`)
    expect(html).toContain('href="https://f451.example/wiki/docs/p-c"')
    expect(brokenLinks).toBe(0)
  })

  it('drops the fragment of a page link', () => {
    const ctx2 = { ...ctx, resolvePage: (t: string) => (['p-c'] as string[]).includes(t) ? t : null }
    const { html } = renderForBookStack('[[p-c#section|C]]', 'p-a', ctx2)
    expect(html).toContain('href="https://f451.example/wiki/docs/p-c"')
  })

  it('flattens broken links to text and counts them', () => {
    const r = renderForBookStack('[[p-nope|gone]]', 'p-a', ctx)
    expect(r.html).not.toContain('broken-link')
    expect(r.html).toContain('gone')
    expect(r.brokenLinks).toBe(1)
  })

  it('counts broken links inside callouts too', () => {
    const r = renderForBookStack('> [!NOTE]\n> see [[Some Title]] and [[p-x|X]]\n', 'p-a', ctx)
    expect(r.html).toContain('<p class="callout info">see Some Title and X</p>')
    expect(r.brokenLinks).toBe(2)
  })

  it('rewrites images to gallery URLs', () => {
    const ctx2 = { ...ctx, imageUrls: new Map([['_media/a.png', 'https://bs/uploads/images/gallery/a.png']]) }
    const { html } = renderForBookStack('![alt](_media/a.png)', 'p-a', ctx2)
    expect(html).toContain('src="https://bs/uploads/images/gallery/a.png"')
  })

  it('rewrites ./_media images and leaves unknown images unchanged', () => {
    const ctx2 = { ...ctx, imageUrls: new Map([['_media/a.png', 'https://bs/a.png']]) }
    const { html } = renderForBookStack('![a](./_media/a.png) ![b](_media/b.png)', 'p-a', ctx2)
    expect(html).toContain('src="https://bs/a.png"')
    expect(html).toContain('src="_media/b.png"')
  })

  it('ignores the frontmatter', () => {
    const { html } = renderForBookStack('---\ntitle: T\n---\n\nbody\n', 'p-a', ctx)
    expect(html).not.toContain('title: T')
    expect(html).toContain('body')
  })
})

describe('links to files', () => {
  it('point at the BookStack attachment, and a missing file counts as broken', () => {
    const ctx2 = { ...ctx, attachmentUrls: new Map([['_media/d.pdf', 'https://bs/attachments/4']]) }
    const r = renderForBookStack('[report](_media/d.pdf) and [gone](_media/x.zip)', 'p-a', ctx2)
    expect(r.html).toContain('href="https://bs/attachments/4"')
    expect(r.html).not.toContain('_media/x.zip')
    expect(r.brokenLinks).toBe(1)
  })
})

describe('pageResolver', () => {
  const node = (id: string, title: string, path: string, children: TreeNode[] = []): TreeNode => ({ id, title, path, archived: false, children })
  const resolve = pageResolver([
    node('root', 'Home', 'index.md', [
      node('sign-in-options', 'Sign-in options', 'sign-in-options/index.md'),
      node('p-x', 'Setup', 'ops/setup/index.md'),
      node('p-y', 'Setup', 'setup/index.md'),
    ]),
  ])
  it('resolves ids without the p- prefix', () => expect(resolve('sign-in-options')).toBe('sign-in-options'))
  it('resolves a path', () => expect(resolve('ops/setup')).toBe('p-x'))
  it('resolves a title case-insensitively, shortest path first', () => expect(resolve('setup')).toBe('p-y'))
  it('returns null for an unknown target', () => expect(resolve('nope')).toBeNull())
})
