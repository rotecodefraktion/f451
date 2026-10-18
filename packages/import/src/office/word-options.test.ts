import { describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '../api.js'
import type { ExistingScan, ImportNode, ImportTree } from '../model.js'
import { duplicateIdWarnings, parseWordOptions } from './word-options.js'

describe('parseWordOptions', () => {
  it('rejects an idPattern made only of "#"', () => {
    expect(parseWordOptions({ mainName: 'id', idPattern: '###' }, false)).toEqual({
      ok: false,
      error: 'idPattern needs at least one character besides "#".',
    })
    expect(parseWordOptions({ mainName: 'id', idPattern: 'DOC-###' }, false)).toEqual({
      ok: true,
      text: { mainName: 'id', idPattern: 'DOC-###' },
    })
  })
})

describe('duplicateIdWarnings', () => {
  const page = (id: string, title: string, children: TreeNode[] = []): TreeNode =>
    ({ id, title, path: `${id}.md`, archived: false, children }) as TreeNode
  const main = (sourceId: string, title: string, children: ImportNode[] = []): ImportNode => ({
    sourceRef: { type: 'office', id: sourceId },
    title,
    markdown: '',
    tags: [],
    children,
    media: [],
    order: 0,
  })
  const importTree = (root: ImportNode[]): ImportTree => ({ root, droppedHtml: {}, drawingsAsPng: [], failed: [], mediaSkipped: [] })
  // p-a was imported from a.docx earlier and keeps DOC-011.
  const scan: ExistingScan = {
    pages: [
      { id: 'p-a', title: 'DOC-011 Network Guide', inSubtree: true },
      { id: 'p-old', title: 'DOC-010', inSubtree: true },
    ],
    sources: new Map([
      ['p-a', { type: 'office', id: 'office:a.docx', origin: 'guides.zip' }],
      ['p-old', null],
    ]),
  }

  it('warns for an ID another page took since the scan, not for the page it updates', async () => {
    // Meanwhile a concurrent run created DOC-012.
    const api = { tree: vi.fn(async () => [page('p-a', 'DOC-011 Network Guide'), page('p-old', 'DOC-010', [page('p-new', 'DOC-012 Other')])]) }
    const tree = importTree([
      main('office:a.docx', 'DOC-011 Network Guide'),
      main('office:dir/', 'dir', [main('office:dir/b.docx', 'DOC-012 Access Policy', [main('office:dir/b.docx@1', 'DOC-012 – 1 Scope')])]),
    ])

    const warnings = await duplicateIdWarnings(api, 's', tree, scan, 'DOC-###', 'guides.zip')

    expect(api.tree).toHaveBeenCalledTimes(1)
    expect(warnings).toEqual([
      {
        sourceId: 'office:dir/b.docx',
        title: 'DOC-012 Access Policy',
        kind: 'duplicateId',
        detail: 'the ID DOC-012 is already used by "DOC-012 Other" (p-new)',
      },
    ])
  })

  it('treats a page of another origin as someone else’s', async () => {
    const api = { tree: vi.fn(async () => [page('p-a', 'DOC-011 Network Guide')]) }
    const warnings = await duplicateIdWarnings(api, 's', importTree([main('office:a.docx', 'DOC-011')]), scan, 'DOC-###', 'other.zip')
    expect(warnings.map((w) => w.sourceId)).toEqual(['office:a.docx'])
  })

  it('gives no warnings for a pattern without counter', async () => {
    const api = { tree: vi.fn(async () => [page('p-x', 'DOC-FIXED')]) }
    expect(await duplicateIdWarnings(api, 's', importTree([main('office:a.docx', 'DOC-FIXED')]), scan, 'DOC-FIXED')).toEqual([])
    expect(api.tree).not.toHaveBeenCalled()
  })
})
