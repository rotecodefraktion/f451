import { describe, expect, it, vi } from 'vitest'
import { BookStackClient } from './client.js'

function stub(body: unknown) {
  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
  const client = new BookStackClient('https://bs.example/', 'id', 'secret', fetchImpl as unknown as typeof fetch)
  return { client, fetchImpl }
}

describe('BookStackClient write methods', () => {
  it('searchByTag sends an encoded tag query and maps the hits', async () => {
    const { client, fetchImpl } = stub({
      data: [
        { id: 7, type: 'page', name: 'A', slug: 'a', book_id: 1 },
        { id: 1, type: 'book', name: 'B', slug: 'b' },
      ],
      total: 2,
    })
    const hits = await client.searchByTag('f451-id', 'p-a')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://bs.example/api/search?query=%5Bf451-id%3Dp-a%5D&page=1&count=100')
    expect(init?.method).toBe('GET')
    // A short first page ends the paging.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // The exporter matches pages and chapters only inside the target book.
    expect(hits).toEqual([{ id: 7, type: 'page', name: 'A', book_id: 1 }, { id: 1, type: 'book', name: 'B' }])
  })

  it('searchByTag pages through results beyond 100 hits', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, type: 'page', name: `P${i + 1}`, book_id: 1 }))
    const page2 = [
      { id: 101, type: 'page', name: 'P101', book_id: 1 },
      { id: 102, type: 'chapter', name: 'C102', book_id: 1 },
    ]
    const bodies = [{ data: page1, total: 102 }, { data: page2, total: 102 }]
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const client = new BookStackClient('https://bs.example/', 'id', 'secret', fetchImpl as unknown as typeof fetch)
    const hits = await client.searchByTag('f451-id', 'p-a')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]![0]).toBe('https://bs.example/api/search?query=%5Bf451-id%3Dp-a%5D&page=2&count=100')
    expect(hits).toHaveLength(102)
    expect(hits[101]).toEqual({ id: 102, type: 'chapter', name: 'C102', book_id: 1 })
  })

  it('createChapter posts JSON with book_id', async () => {
    const { client, fetchImpl } = stub({ id: 3, name: 'Ch' })
    await client.createChapter({ book_id: 5, name: 'Ch', priority: 10, tags: [{ name: 'f451-id', value: 'x' }] })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://bs.example/api/chapters')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({
      book_id: 5,
      name: 'Ch',
      priority: 10,
      tags: [{ name: 'f451-id', value: 'x' }],
    })
  })

  it('uploadAttachment sends multipart FormData with uploaded_to, name and file', async () => {
    const { client, fetchImpl } = stub({ id: 9, name: 'doc.pdf' })
    await client.uploadAttachment(4, 'doc.pdf', new Uint8Array([1, 2, 3]), 'application/pdf')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://bs.example/api/attachments')
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('uploaded_to')).toBe('4')
    expect(form.get('name')).toBe('doc.pdf')
    const file = form.get('file') as File
    expect(file.name).toBe('doc.pdf')
    expect(file.type).toBe('application/pdf')
    expect(file.size).toBe(3)
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('does not retry a POST whose fetch fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const client = new BookStackClient('https://bs.example/', 'id', 'secret', fetchImpl as unknown as typeof fetch, {
      sleep: async () => {},
    })
    await expect(client.createChapter({ book_id: 5, name: 'Ch' })).rejects.toThrow(TypeError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a GET whose fetch fails once', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 3, name: 'Ch' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
    const client = new BookStackClient('https://bs.example/', 'id', 'secret', fetchImpl as unknown as typeof fetch, {
      sleep: async () => {},
    })
    expect(await client.getChapter(3)).toEqual({ id: 3, name: 'Ch' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('downloadUrl refuses other hosts and does not follow redirects', async () => {
    const { client, fetchImpl } = stub({})
    await expect(client.downloadUrl('http://10.0.0.5/admin')).rejects.toThrow(/refused/)
    expect(fetchImpl).not.toHaveBeenCalled()
    await client.downloadUrl('/uploads/a.png')
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
  })
})
