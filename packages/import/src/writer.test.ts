import { describe, expect, it, vi } from 'vitest'
import { F451ApiError, type TreeNode } from './api.js'
import type { ImportEvent, ImportNode, ImportOptions, ImportTree } from './model.js'
import { importTree, MAX_UPLOAD, type WriterApi } from './writer.js'

function fakeApi() {
  return {
    tree: vi.fn<WriterApi['tree']>(async () => []),
    raw: vi.fn<WriterApi['raw']>(async () => ''),
    createPage: vi.fn<WriterApi['createPage']>(async (p) => {
      const id = `p-${p.title.toLowerCase()}`
      return { id, path: `${id}.md`, baseSha: `sha-${id}`, content: '' }
    }),
    getDraft: vi.fn<WriterApi['getDraft']>(async () => null),
    openDraft: vi.fn<WriterApi['openDraft']>(async () => ({ baseSha: 'sha-open', content: '' })),
    putDraft: vi.fn<WriterApi['putDraft']>(async () => ({ newSha: 'sha-new' })),
    uploadMedia: vi.fn<WriterApi['uploadMedia']>(async (_id, name) => ({ path: `_media/${name}`, markdown: '', kind: 'image' })),
    requestReview: vi.fn<WriterApi['requestReview']>(async () => ({ number: 1, url: 'https://pr/1' })),
    release: vi.fn<WriterApi['release']>(async () => ({ mergeSha: 'sha-merge' })),
    reorder: vi.fn<WriterApi['reorder']>(async () => undefined),
    media: vi.fn<WriterApi['media']>(async () => null),
    discardDraft: vi.fn<WriterApi['discardDraft']>(async () => undefined),
  }
}

function node(id: string, title: string, extra: Partial<ImportNode> = {}): ImportNode {
  return {
    sourceRef: { type: 'bookstack', id, url: `https://b/${id}` },
    title,
    markdown: `body ${id}`,
    tags: [],
    children: [],
    media: [],
    order: 0,
    ...extra,
  }
}

function tree(root: ImportNode[]): ImportTree {
  return { root, droppedHtml: {}, drawingsAsPng: [], failed: [], mediaSkipped: [] }
}

const OPTS: ImportOptions = { update: false, release: false, dryRun: false }
const TARGET = { space: 's' }

function putFor(api: ReturnType<typeof fakeApi>, pageId: string): string | undefined {
  return api.putDraft.mock.calls.find((c) => c[0] === pageId)?.[1]
}

describe('importTree', () => {
  it('creates parents before children and resolves links', async () => {
    const api = fakeApi()
    const child = node('2', 'Child', { markdown: 'See [Up](source:1|https://b/1).' })
    const parent = node('1', 'Parent', { children: [child] })

    const report = await importTree(tree([parent]), TARGET, api, OPTS, () => {})

    expect(api.createPage).toHaveBeenCalledTimes(2)
    expect(api.createPage).toHaveBeenNthCalledWith(1, { space: 's', title: 'Parent' })
    expect(api.createPage).toHaveBeenNthCalledWith(2, { space: 's', title: 'Child', parentId: 'p-parent' })
    expect(putFor(api, 'p-child')).toContain('[[p-parent|Up]]')
    expect(api.requestReview).toHaveBeenCalledTimes(2)
    expect(api.requestReview).toHaveBeenCalledWith('p-parent')
    expect(api.requestReview).toHaveBeenCalledWith('p-child')
    expect(api.release).not.toHaveBeenCalled()
    expect(api.reorder).not.toHaveBeenCalled()
    expect(report.created.map((r) => r.pageId)).toEqual(['p-parent', 'p-child'])
  })

  it('releases and reorders siblings when asked to', async () => {
    const api = fakeApi()
    const a = node('1', 'A', { order: 1 })
    const b = node('2', 'B', { order: 0 })

    await importTree(tree([a, b]), TARGET, api, { ...OPTS, release: true }, () => {})

    expect(api.release).toHaveBeenCalledTimes(2)
    expect(api.release).toHaveBeenCalledWith('p-a', expect.objectContaining({ bump: 'major' }))
    expect(api.release).toHaveBeenCalledWith('p-b', expect.objectContaining({ bump: 'major' }))
    expect(api.reorder).toHaveBeenCalledTimes(1)
    expect(api.reorder).toHaveBeenCalledWith('s', null, ['p-b', 'p-a'])
  })

  it('records a 400 on create as failed and continues', async () => {
    const api = fakeApi()
    const createImpl = api.createPage.getMockImplementation()!
    api.createPage.mockImplementation(async (p) => {
      if (p.title === '???') throw new F451ApiError('bad', 400, { error: 'empty slug' })
      return createImpl(p)
    })
    const events: ImportEvent[] = []

    const report = await importTree(
      tree([node('1', '???', { order: 0 }), node('2', 'Good', { order: 1 })]),
      TARGET,
      api,
      OPTS,
      (e) => events.push(e),
    )

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].sourceId).toBe('1')
    expect(report.failed[0].reason).toContain('400')
    expect(report.created.map((r) => r.sourceId)).toEqual(['2'])
    expect(api.putDraft).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'page', sourceId: '1', status: 'failed' }))
  })

  describe('update of an imported page', () => {
    const published = '---\nid: p-a\ntitle: A\nsource:\n  type: bookstack\n  id: "1"\nversion: 1.0.0\n---\n\n# A\n\n![x](_media/x.png)\n'
    const media = (bytes: number[]) => [{ name: 'x.png', bytes: new Uint8Array(bytes), mime: 'image/png', kind: 'image' as const, ref: '_media/x.png' }]
    const setup = () => {
      const api = fakeApi()
      api.tree.mockResolvedValue([{ id: 'p-a', title: 'A', path: 'a/index.md', archived: false, children: [] }])
      api.raw.mockResolvedValue(published)
      api.openDraft.mockResolvedValue({ baseSha: 'sha-a', content: published })
      api.media.mockResolvedValue(new Uint8Array([1, 2, 3]))
      return api
    }

    it('discards the draft when body, tags and media are unchanged', async () => {
      const api = setup()
      const report = await importTree(
        tree([node('1', 'A', { markdown: '# A\n\n![x](_media/x.png)\n', media: media([1, 2, 3]) })]),
        TARGET, api, { ...OPTS, update: true }, () => {},
      )
      expect(report.skipped).toEqual([expect.objectContaining({ sourceId: '1', reason: 'unchanged' })])
      expect(api.uploadMedia).not.toHaveBeenCalled()
      expect(api.discardDraft).toHaveBeenCalledWith('p-a')
      expect(api.requestReview).not.toHaveBeenCalled()
    })

    it('reuses a stored diagram whose embedded XML is the same', async () => {
      const api = setup()
      const rendered = '<svg id="ge-svg-AAA" content="&lt;mxfile&gt;&lt;diagram id=&quot;a&quot;/&gt;&lt;/mxfile&gt;"><g/></svg>'
      const stored = '<svg xmlns="http://www.w3.org/2000/svg" id="ge-svg-BBB" content="&lt;mxfile&gt;&lt;diagram id=&#x22;a&#x22;/&gt;&lt;/mxfile&gt;"><g></g></svg>'
      api.media.mockResolvedValue(new TextEncoder().encode(stored))
      const drawing = [{ name: 'f.drawio.svg', bytes: new TextEncoder().encode(rendered), mime: 'image/svg+xml', kind: 'drawio' as const, ref: '_media/f.drawio.svg' }]
      api.raw.mockResolvedValue(published.replace('x.png', 'f.drawio.svg'))
      api.openDraft.mockResolvedValue({ baseSha: 'sha-a', content: published.replace('x.png', 'f.drawio.svg') })
      const report = await importTree(
        tree([node('1', 'A', { markdown: '# A\n\n![x](_media/f.drawio.svg)\n', media: drawing })]),
        TARGET, api, { ...OPTS, update: true }, () => {},
      )
      expect(api.uploadMedia).not.toHaveBeenCalled()
      expect(report.skipped).toEqual([expect.objectContaining({ reason: 'unchanged' })])
    })

    it('uploads only a changed file and opens a review', async () => {
      const api = setup()
      const report = await importTree(
        tree([node('1', 'A', { markdown: '# A\n\n![x](_media/x.png)\n', media: media([9, 9]) })]),
        TARGET, api, { ...OPTS, update: true }, () => {},
      )
      expect(api.uploadMedia).toHaveBeenCalledTimes(1)
      expect(api.discardDraft).not.toHaveBeenCalled()
      expect(report.updated.map((r) => r.sourceId)).toEqual(['1'])
    })
  })

  it('treats a 409 whose draft has the same origin as imported with an open review', async () => {
    const api = fakeApi()
    api.createPage.mockImplementation(async (p) => {
      if (p.title === 'Book') throw new F451ApiError('conflict', 409, { error: 'exists', pageId: 'p-book' })
      throw new F451ApiError('conflict', 409, { error: 'exists', pageId: 'p-child' })
    })
    api.getDraft.mockImplementation(async (id) => ({
      baseSha: 's',
      content: `---\nid: ${id}\nsource:\n  type: bookstack\n  id: "${id === 'p-book' ? 'book:1' : '2'}"\n---\n\nx\n`,
    }))

    const report = await importTree(tree([node('book:1', 'Book', { children: [node('2', 'Child')] })]), TARGET, api, OPTS, () => {})

    expect(report.failed).toEqual([])
    expect(report.skipped.map((r) => [r.sourceId, r.pageId, r.reason])).toEqual([
      ['book:1', 'p-book', 'already imported, review still open'],
      ['2', 'p-child', 'already imported, review still open'],
    ])
    expect(api.createPage.mock.calls[1]?.[0]).toMatchObject({ parentId: 'p-book' })
    expect(api.putDraft).not.toHaveBeenCalled()
  })

  it('keeps a 409 as failed when the conflicting draft has another origin', async () => {
    const api = fakeApi()
    api.createPage.mockRejectedValue(new F451ApiError('conflict', 409, { error: 'exists', pageId: 'p-other' }))
    api.getDraft.mockResolvedValue({ baseSha: 's', content: '---\nid: p-other\n---\n\nmine\n' })

    const report = await importTree(tree([node('1', 'Same')]), TARGET, api, OPTS, () => {})

    expect(report.failed.map((r) => r.sourceId)).toEqual(['1'])
    expect(report.skipped).toEqual([])
  })

  it('records a 409 on create as failed and does not reuse the other page', async () => {
    const api = fakeApi()
    let calls = 0
    api.createPage.mockImplementation(async () => {
      calls++
      if (calls === 2) throw new F451ApiError('conflict', 409, { error: 'exists', pageId: 'p-x' })
      return { id: 'p-same', path: 'same.md', baseSha: 'sha-same', content: '' }
    })

    const report = await importTree(
      tree([node('1', 'Same', { order: 0 }), node('2', 'Same', { order: 1 })]),
      TARGET,
      api,
      OPTS,
      () => {},
    )

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].sourceId).toBe('2')
    expect(report.failed[0].reason).toContain('p-x')
    expect(report.created.map((r) => r.sourceId)).toEqual(['1'])
    expect(api.putDraft.mock.calls.map((c) => c[0])).toEqual(['p-same'])
    expect(api.openDraft).not.toHaveBeenCalled()
  })

  describe('existing page', () => {
    const existingRaw = [
      '---',
      'id: p-old',
      'title: A',
      'classification: internal',
      'source:',
      '  type: bookstack',
      "  id: 'A'",
      '---',
      '',
      'old body',
      '',
    ].join('\n')

    function existingApi() {
      const api = fakeApi()
      const treeNodes: TreeNode[] = [{ id: 'p-old', title: 'A', path: 'a.md', archived: false, children: [] }]
      api.tree.mockResolvedValue(treeNodes)
      api.raw.mockResolvedValue(existingRaw)
      api.openDraft.mockResolvedValue({ baseSha: 'sha-old', content: existingRaw })
      return api
    }
    const entry = () => tree([node('A', 'A', { markdown: 'new body' })])

    it('skips it without update', async () => {
      const api = existingApi()
      const report = await importTree(entry(), TARGET, api, OPTS, () => {})

      expect(api.createPage).not.toHaveBeenCalled()
      expect(api.putDraft).not.toHaveBeenCalled()
      expect(report.skipped).toHaveLength(1)
      expect(report.skipped[0]).toMatchObject({ sourceId: 'A', pageId: 'p-old', reason: 'already imported' })
    })

    it('skips it with update when a draft is already open', async () => {
      const api = existingApi()
      api.getDraft.mockResolvedValue({ baseSha: 'sha-draft', content: 'draft' })

      const report = await importTree(entry(), TARGET, api, { ...OPTS, update: true }, () => {})

      expect(api.openDraft).not.toHaveBeenCalled()
      expect(api.putDraft).not.toHaveBeenCalled()
      expect(report.skipped[0]).toMatchObject({ sourceId: 'A', reason: 'draft already open' })
    })

    it('updates it through a draft, keeping the f451 frontmatter', async () => {
      const api = existingApi()

      const report = await importTree(entry(), TARGET, api, { ...OPTS, update: true }, () => {})

      expect(api.createPage).not.toHaveBeenCalled()
      expect(api.openDraft).toHaveBeenCalledWith('p-old')
      expect(api.putDraft).toHaveBeenCalledTimes(1)
      const [pageId, content, baseSha] = api.putDraft.mock.calls[0]
      expect(pageId).toBe('p-old')
      expect(baseSha).toBe('sha-old')
      expect(content).toContain('classification: internal')
      expect(content).toContain('new body')
      expect(content).not.toContain('old body')
      expect(api.requestReview).toHaveBeenCalledWith('p-old')
      expect(report.updated).toEqual([{ sourceId: 'A', title: 'A', pageId: 'p-old' }])
    })
  })

  it('skips media over the limit and follows renamed media paths', async () => {
    const api = fakeApi()
    api.uploadMedia.mockResolvedValue({ path: '_media/a-1.png', markdown: '', kind: 'image' })
    const page = node('1', 'X', {
      markdown: '![a](_media/a.png)\n\n![big](_media/big.png)',
      media: [
        { name: 'big.png', bytes: new Uint8Array(MAX_UPLOAD + 1), mime: 'image/png', kind: 'image', ref: '_media/big.png' },
        { name: 'a.png', bytes: new Uint8Array(4), mime: 'image/png', kind: 'image', ref: '_media/a.png' },
      ],
    })

    const report = await importTree(tree([page]), TARGET, api, OPTS, () => {})

    expect(api.uploadMedia).toHaveBeenCalledTimes(1)
    expect(api.uploadMedia.mock.calls[0][1]).toBe('a.png')
    expect(report.mediaSkipped).toEqual([{ sourceId: '1', name: 'big.png', reason: 'too large' }])
    expect(putFor(api, 'p-x')).toContain('![a](_media/a-1.png)')
  })

  it('calls no writing method on a dry run', async () => {
    const api = fakeApi()
    const child = node('2', 'Child')
    const parent = node('1', 'Parent', { children: [child] })

    const report = await importTree(tree([parent]), TARGET, api, { ...OPTS, dryRun: true, release: true }, () => {})

    expect(api.tree).toHaveBeenCalled()
    for (const m of ['createPage', 'getDraft', 'openDraft', 'putDraft', 'uploadMedia', 'requestReview', 'release', 'reorder'] as const) {
      expect(api[m]).not.toHaveBeenCalled()
    }
    expect(report.created.map((r) => r.sourceId)).toEqual(['1', '2'])
  })
})
