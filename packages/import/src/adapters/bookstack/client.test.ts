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
      data: [{ id: 7, type: 'page', name: 'A', slug: 'a', book_id: 1 }],
      total: 1,
    })
    const hits = await client.searchByTag('f451-id', 'p-a')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://bs.example/api/search?query=%5Bf451-id%3Dp-a%5D&count=100')
    expect(init?.method).toBe('GET')
    expect(hits).toEqual([{ id: 7, type: 'page', name: 'A' }])
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
})
