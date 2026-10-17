import { describe, expect, it } from 'vitest'
import { ExportPageNotFoundError, TooManyPagesError, loadExportPages, type ExportF451Reader } from './load.js'
import { node } from './test-helpers.js'

const roots = [
  node('start', 'Start', [node('a', 'A', [node('a1', 'A1')]), node('old', 'Old', [], true), node('b', 'B')]),
  node('other', 'Other'),
]

function fake(markdown: Record<string, string>, files: Record<string, Uint8Array> = {}) {
  const mediaCalls: string[] = []
  const f451: ExportF451Reader = {
    tree: async () => roots,
    raw: async (id) => markdown[id] ?? '',
    media: async (pageId, name, ref) => {
      mediaCalls.push(`${pageId}/${name}@${ref}`)
      return files[`${pageId}/${name}`] ?? null
    },
  }
  return { f451, mediaCalls }
}

describe('loadExportPages', () => {
  it('loads the start page and its non-archived descendants in tree order with depth', async () => {
    const { f451 } = fake({ start: '---\ntitle: Start page\n---\nx', a: '# A title\n\ny' })
    const pages = await loadExportPages(f451, { space: 'space', pageId: 'start', subpages: true })
    expect(pages.map((p) => [p.id, p.depth, p.title])).toEqual([
      ['start', 0, 'Start page'],
      ['a', 1, 'A title'],
      ['a1', 2, 'A1'],
      ['b', 1, 'B'],
    ])
  })

  it('loads only the start page without subpages', async () => {
    const { f451 } = fake({})
    const pages = await loadExportPages(f451, { space: 'space', pageId: 'a', subpages: false })
    expect(pages.map((p) => p.id)).toEqual(['a'])
  })

  it('reads images of the published version only and skips other attachments', async () => {
    const png = new Uint8Array([1])
    const { f451, mediaCalls } = fake(
      { start: '![x](_media/x.png) [f](_media/file.pdf) ![m](_media/missing.png)' },
      { 'start/x.png': png },
    )
    const [p] = await loadExportPages(f451, { space: 'space', pageId: 'start', subpages: false })
    expect(mediaCalls).toEqual(['start/x.png@main', 'start/missing.png@main'])
    expect([...p!.media.keys()]).toEqual(['x.png'])
  })

  it('throws beyond maxPages and for an unknown start page', async () => {
    const { f451 } = fake({})
    await expect(loadExportPages(f451, { space: 'space', pageId: 'start', subpages: true, maxPages: 3 })).rejects.toBeInstanceOf(
      TooManyPagesError,
    )
    await expect(loadExportPages(f451, { space: 'space', pageId: 'nope', subpages: false })).rejects.toBeInstanceOf(
      ExportPageNotFoundError,
    )
  })
})
