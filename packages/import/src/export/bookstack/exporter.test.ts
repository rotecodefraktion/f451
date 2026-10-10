import { describe, expect, it, vi } from 'vitest'
import { F451ApiError, type TreeNode } from '../../api.js'
import type { BookStackTag } from '../../adapters/bookstack/types.js'
import { exportToBookStack, type ExportBookStack, type ExportF451, type ExportOptions } from './exporter.js'

interface Entity {
  id: number
  type: 'book' | 'chapter' | 'page'
  name: string
  slug: string
  book_id: number
  chapter_id: number
  priority: number
  html: string
  tags: BookStackTag[]
}

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

/** In-memory BookStack: every entity lives in one list, search goes by tag. */
function fakeBookStack() {
  const store: Entity[] = []
  let nextId = 1
  const add = (e: Omit<Entity, 'id' | 'slug'>): Entity => {
    const entity = { ...e, id: nextId++, slug: slugify(e.name) }
    store.push(entity)
    return entity
  }
  const get = (id: number, type: Entity['type']) => {
    const e = store.find((x) => x.id === id && x.type === type)
    if (!e) throw new Error(`no ${type} ${id}`)
    return e
  }
  const asAny = <T>(e: Entity) => e as unknown as T
  const bs = {
    searchByTag: vi.fn<ExportBookStack['searchByTag']>(async (name, value) =>
      store
        .filter((e) => e.tags.some((t) => t.name === name && t.value === value))
        .map((e) => ({ id: e.id, type: e.type, name: e.name })),
    ),
    getBookContents: vi.fn<ExportBookStack['getBookContents']>(async (id) => asAny(get(id, 'book'))),
    createBook: vi.fn<ExportBookStack['createBook']>(async (p) =>
      asAny(add({ type: 'book', name: p.name, book_id: 0, chapter_id: 0, priority: 0, html: '', tags: p.tags ?? [] })),
    ),
    updateBook: vi.fn<ExportBookStack['updateBook']>(async (id, p) => {
      const e = get(id, 'book')
      if (p.name) Object.assign(e, { name: p.name, slug: slugify(p.name) })
      return asAny(e)
    }),
    createChapter: vi.fn<ExportBookStack['createChapter']>(async (p) =>
      asAny(
        add({ type: 'chapter', name: p.name, book_id: p.book_id, chapter_id: 0, priority: p.priority ?? 0, html: '', tags: p.tags ?? [] }),
      ),
    ),
    updateChapter: vi.fn<ExportBookStack['updateChapter']>(async (id, p) => {
      const e = get(id, 'chapter')
      if (p.name) Object.assign(e, { name: p.name, slug: slugify(p.name) })
      if (p.priority !== undefined) e.priority = p.priority
      return asAny(e)
    }),
    getPage: vi.fn<ExportBookStack['getPage']>(async (id) => asAny(get(id, 'page'))),
    createPage: vi.fn<ExportBookStack['createPage']>(async (p) => {
      const bookId = p.chapter_id ? get(p.chapter_id, 'chapter').book_id : p.book_id!
      return asAny(
        add({
          type: 'page',
          name: p.name,
          book_id: bookId,
          chapter_id: p.chapter_id ?? 0,
          priority: p.priority ?? 0,
          html: p.html,
          tags: p.tags ?? [],
        }),
      )
    }),
    updatePage: vi.fn<ExportBookStack['updatePage']>(async (id, p) => {
      const e = get(id, 'page')
      if (p.name) Object.assign(e, { name: p.name, slug: slugify(p.name) })
      if (p.html !== undefined) e.html = p.html
      if (p.priority !== undefined) e.priority = p.priority
      if (p.chapter_id !== undefined) Object.assign(e, { chapter_id: p.chapter_id, book_id: get(p.chapter_id, 'chapter').book_id })
      else if (p.book_id !== undefined) Object.assign(e, { book_id: p.book_id, chapter_id: 0 })
      return asAny(e)
    }),
    listGalleryImages: vi.fn<ExportBookStack['listGalleryImages']>(async () => []),
    uploadImage: vi.fn<ExportBookStack['uploadImage']>(),
    uploadAttachment: vi.fn<ExportBookStack['uploadAttachment']>(),
    getAttachmentsForPage: vi.fn<ExportBookStack['getAttachmentsForPage']>(async () => ({ data: [], total: 0 })),
    deletePage: vi.fn(),
  }
  return { bs: bs satisfies ExportBookStack, store, add }
}

const node = (id: string, title: string, children: TreeNode[] = [], path = `${id}/index.md`): TreeNode => ({
  id,
  title,
  path,
  archived: false,
  children,
})

const page = (title: string, body = '') => `---\ntitle: ${title}\n---\n\n${body}\n`

/** Space root, one chapter `Ch` with a child page `X`: one book page, a chapter with two pages. */
function fakeF451(xTitle = 'X') {
  const raw = new Map<string, string>([
    ['p-root', page('Space')],
    ['p-ch', page('Ch', 'See [[p-x|X]].')],
    ['p-x', page(xTitle)],
  ])
  const missing = new Set<string>()
  const f451: ExportF451 = {
    tree: vi.fn(async () => [node('p-root', 'Space', [], 'index.md'), node('p-ch', 'Ch', [node('p-x', xTitle)])]),
    raw: vi.fn(async (id: string) => {
      if (missing.has(id) || !raw.has(id)) throw new F451ApiError(`/api/pages/${id}/raw failed with 404`, 404, null)
      return raw.get(id)!
    }),
    media: vi.fn(async () => null),
  }
  return { f451, missing }
}

const opts: ExportOptions = {
  space: 'docs',
  dryRun: false,
  f451Url: 'https://wiki.example',
  bookstackUrl: 'https://bs.example',
}

const tag = (e: Entity, name: string) => e.tags.find((t) => t.name === name)?.value

describe('exportToBookStack', () => {
  it('creates book, chapter and pages with tags; sibling links point at BookStack', async () => {
    const { bs, store } = fakeBookStack()
    const { f451 } = fakeF451()
    const report = await exportToBookStack(f451, bs, opts, () => {})

    expect(bs.createBook).toHaveBeenCalledTimes(1)
    expect(bs.createBook.mock.calls[0]?.[0]).toMatchObject({ name: 'Space' })
    expect(bs.createChapter).toHaveBeenCalledTimes(1)
    expect(bs.createPage).toHaveBeenCalledTimes(3)
    expect(report.created.map((p) => p.name)).toEqual(['Space', 'Ch', 'X'])
    expect(report.failed).toEqual([])

    for (const e of store) expect(tag(e, 'f451-space')).toBe('docs')
    expect(store.find((e) => e.type === 'book')!.tags).toContainEqual({ name: 'f451-id', value: 'p-root' })
    expect(store.find((e) => e.type === 'chapter')!.tags).toContainEqual({ name: 'f451-id', value: 'p-ch' })

    const book = store.find((e) => e.type === 'book')!
    const chPage = store.find((e) => e.type === 'page' && tag(e, 'f451-id') === 'p-ch')!
    const xPage = store.find((e) => e.type === 'page' && tag(e, 'f451-id') === 'p-x')!
    expect(chPage.html).toContain(`href="https://bs.example/books/${book.slug}/page/${xPage.slug}"`)
  })

  it('updates in place after a rename instead of duplicating', async () => {
    const { bs, store } = fakeBookStack()
    await exportToBookStack(fakeF451().f451, bs, opts, () => {})
    const xId = store.find((e) => e.type === 'page' && tag(e, 'f451-id') === 'p-x')!.id
    vi.clearAllMocks()

    const report = await exportToBookStack(fakeF451('X renamed').f451, bs, opts, () => {})

    expect(bs.createBook).not.toHaveBeenCalled()
    expect(bs.createChapter).not.toHaveBeenCalled()
    expect(bs.createPage).not.toHaveBeenCalled()
    expect(bs.updatePage).toHaveBeenCalledWith(xId, expect.objectContaining({ name: 'X renamed' }))
    expect(report.updated.map((p) => p.name)).toEqual(['Space', 'Ch', 'X renamed'])
    expect(store.filter((e) => e.type === 'page')).toHaveLength(3)
  })

  it('reports a page whose raw fails with 404 and exports the rest', async () => {
    const { bs } = fakeBookStack()
    const { f451, missing } = fakeF451()
    missing.add('p-x')
    const events: string[] = []
    const report = await exportToBookStack(f451, bs, opts, (e) => {
      if (e.kind === 'page') events.push(`${e.pageId}:${e.status}`)
    })

    expect(report.failed.map((f) => f.pageId)).toEqual(['p-x'])
    expect(report.failed[0]!.reason).toContain('404')
    expect(report.created.map((p) => p.pageId)).toEqual(['p-root', 'p-ch'])
    expect(events).toContain('p-x:failed')
    // The link to the failed page falls back to f451.
    expect(report.brokenLinks).toBe(0)
  })

  it('reports a file BookStack refuses and still exports the page', async () => {
    const { bs } = fakeBookStack()
    const { f451 } = fakeF451()
    ;(f451.raw as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === 'p-x' ? page('X', '![a](_media/a.png)') : page(id === 'p-root' ? 'Space' : 'Ch'),
    )
    ;(f451.media as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array([1]))
    bs.uploadImage.mockRejectedValue(new Error('The given data was invalid.'))

    const report = await exportToBookStack(f451, bs, opts, () => {})

    expect(report.failed).toEqual([])
    expect(report.missingMedia).toEqual([{ pageId: 'p-x', ref: '_media/a.png', reason: 'The given data was invalid.' }])
    expect(report.created.map((r) => r.pageId)).toContain('p-x')
  })

  it('lists stale BookStack pages of the space and never deletes them', async () => {
    const { bs, store, add } = fakeBookStack()
    await exportToBookStack(fakeF451().f451, bs, opts, () => {})
    const book = store.find((e) => e.type === 'book')!
    const gone = add({
      type: 'page',
      name: 'Gone',
      book_id: book.id,
      chapter_id: 0,
      priority: 99,
      html: '',
      tags: [
        { name: 'f451-id', value: 'p-gone' },
        { name: 'f451-space', value: 'docs' },
      ],
    })

    const report = await exportToBookStack(fakeF451().f451, bs, opts, () => {})

    expect(report.stale).toEqual([{ bsId: gone.id, name: 'Gone' }])
    expect(bs.deletePage).not.toHaveBeenCalled()
  })
})
