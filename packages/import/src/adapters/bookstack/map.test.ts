import { readFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ImportNode } from '../../model.js'
import { BookStackClient } from './client.js'
import { loadBookStackTree } from './map.js'

// The client allows 3 requests per second, so one load takes a few seconds.
const TIMEOUT = 20_000
const BASE = 'https://b'
const MAX_BYTES = 10 * 1024 * 1024

function fixture(name: string): string {
  return readFileSync(new URL(`../../../test/fixtures/bookstack/${name}`, import.meta.url), 'utf8')
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A PNG skeleton carrying an empty draw.io diagram in a `mxfile` tEXt chunk. */
function drawingPng(): Uint8Array {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('tEXt', Buffer.from('mxfile\0%3Cmxfile%3E%3C%2Fmxfile%3E', 'latin1')),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

const JSON_ROUTES: Record<string, string> = {
  '/api/books/7': 'book-7.json',
  '/api/chapters/3': 'chapter-3.json',
  '/api/pages/12': 'page-12.json',
  '/api/pages/13': 'page-13.json',
  '/api/shelves/2': 'shelf-2.json',
}

function binary(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
}

const fetchImpl = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const path = decodeURIComponent(url.pathname)
  const file = JSON_ROUTES[path]
  if (file) return new Response(fixture(file), { status: 200, headers: { 'Content-Type': 'application/json' } })
  if (path === '/api/attachments') return Response.json({ data: [], total: 0 })
  if (path === '/uploads/images/gallery/2026/a b.png') return binary(new Uint8Array([1, 2, 3, 4]))
  if (path === '/uploads/images/drawio/d.png') return binary(drawingPng())
  return new Response('{}', { status: 404 })
}) as typeof fetch

function client(): BookStackClient {
  return new BookStackClient(BASE, 'id', 'secret', fetchImpl)
}

function shape(node: ImportNode): unknown {
  return { id: node.sourceRef.id, children: node.children.map(shape) }
}

function search(nodes: ImportNode[], id: string): ImportNode | null {
  for (const n of nodes) {
    if (n.sourceRef.id === id) return n
    const hit = search(n.children, id)
    if (hit) return hit
  }
  return null
}

function find(nodes: ImportNode[], id: string): ImportNode {
  const hit = search(nodes, id)
  if (!hit) throw new Error(`node ${id} not in tree`)
  return hit
}

describe('loadBookStackTree', () => {
  it(
    'maps a book with a renderer: tree, links, tags, images and drawings',
    async () => {
      const tree = await loadBookStackTree(client(), { book: '7' }, {
        baseUrl: BASE,
        drawio: { render: async () => '<svg content="x"/>' },
        maxBytes: MAX_BYTES,
      })

      expect(tree.root.map(shape)).toEqual([
        { id: 'book:7', children: [{ id: 'chapter:3', children: [{ id: '13', children: [] }] }, { id: '12', children: [] }] },
      ])

      const book = find(tree.root, 'book:7')
      expect(book.markdown).toContain('# Guide')
      expect(book.markdown).toContain('The guide')
      expect(book.sourceRef).toEqual({ type: 'bookstack', id: 'book:7', url: 'https://b/books/guide' })

      const p12 = find(tree.root, '12')
      expect(p12.markdown).toContain('[Next](source:13|https://b/books/guide/page/next)')
      expect(p12.tags).toContain('area:ops')
      expect(p12.tags).not.toContain('f451-id:p-old')
      expect(p12.knownF451Id).toBe('p-old')
      expect(p12.markdown).toContain('![x](_media/a-b.png)')
      expect(p12.media).toHaveLength(1)
      expect(p12.media[0]).toMatchObject({ name: 'a-b.png', kind: 'image', mime: 'image/png', ref: '_media/a-b.png' })
      expect(p12.sourceRef).toEqual({ type: 'bookstack', id: '12', url: 'https://b/books/guide/page/start' })

      const p13 = find(tree.root, '13')
      expect(p13.markdown).toContain('_media/d.drawio.svg')
      expect(p13.media).toHaveLength(1)
      expect(p13.media[0]).toMatchObject({ name: 'd.drawio.svg', kind: 'drawio', mime: 'image/svg+xml' })
      expect(new TextDecoder().decode(p13.media[0]!.bytes)).toBe('<svg content="x"/>')
      expect(tree.drawingsAsPng).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'keeps a drawing as PNG without a renderer',
    async () => {
      const tree = await loadBookStackTree(client(), { book: '7' }, { baseUrl: BASE, drawio: null, maxBytes: MAX_BYTES })
      const p13 = find(tree.root, '13')
      expect(p13.markdown).toContain('_media/d.png')
      expect(p13.media).toHaveLength(1)
      expect(p13.media[0]).toMatchObject({ name: 'd.png', kind: 'image' })
      expect(tree.drawingsAsPng).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    'skips media over the size limit and keeps the absolute URL',
    async () => {
      const tree = await loadBookStackTree(client(), { book: '7' }, { baseUrl: BASE, drawio: null, maxBytes: 2 })
      const p12 = find(tree.root, '12')
      expect(p12.media).toEqual([])
      expect(p12.markdown).toContain('https://b/uploads/images/gallery/2026/a%20b.png')
    },
    TIMEOUT,
  )

  it(
    'puts a shelf above its books',
    async () => {
      const tree = await loadBookStackTree(client(), { shelf: '2' }, { baseUrl: BASE, drawio: null, maxBytes: MAX_BYTES })
      expect(tree.root.map((n) => n.sourceRef.id)).toEqual(['shelf:2'])
      expect(tree.root[0]!.children.map((n) => n.sourceRef.id)).toEqual(['book:7'])
    },
    TIMEOUT,
  )

  it('rejects an unknown book', async () => {
    await expect(
      loadBookStackTree(client(), { book: '99' }, { baseUrl: BASE, drawio: null, maxBytes: MAX_BYTES }),
    ).rejects.toThrow('book not found: 99')
  })
})
