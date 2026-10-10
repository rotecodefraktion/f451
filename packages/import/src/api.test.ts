import { describe, expect, it, vi } from 'vitest'
import { F451Api, F451ApiError } from './api.js'

function stub(responses: Array<{ status: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift() ?? { status: 500 }
    const text = r.text ?? JSON.stringify(r.body ?? {})
    return new Response(text, { status: r.status, headers: { 'content-type': r.text ? 'text/markdown' : 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('F451Api', () => {
  it('sends the bearer token and parses JSON', async () => {
    const { fetchImpl, calls } = stub([{ status: 201, body: { id: 'p-1', path: 'a/index.md', baseSha: 's', content: '' } }])
    const api = new F451Api('http://x', 'f451_pat_t', fetchImpl)
    const r = await api.createPage({ space: 's', title: 'A' })
    expect(r.id).toBe('p-1')
    expect(calls[0].url).toBe('http://x/api/pages')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer f451_pat_t')
  })

  it('returns null for a missing draft', async () => {
    const { fetchImpl } = stub([{ status: 404, body: { error: 'none' } }])
    expect(await new F451Api('http://x', 't', fetchImpl).getDraft('p-1')).toBeNull()
  })

  it('retries 5xx three times then throws F451ApiError', async () => {
    const { fetchImpl, calls } = stub([{ status: 502 }, { status: 502 }, { status: 502 }])
    const api = new F451Api('http://x', 't', fetchImpl, { retryDelayMs: 0 })
    await expect(api.raw('p-1')).rejects.toBeInstanceOf(F451ApiError)
    expect(calls).toHaveLength(3)
  })

  it('does not retry a 409 and exposes the body', async () => {
    const { fetchImpl, calls } = stub([{ status: 409, body: { error: 'conflict', pageId: 'p-9' } }])
    const api = new F451Api('http://x', 't', fetchImpl)
    const err = await api.createPage({ space: 's', title: 'A' }).catch((e) => e)
    expect(err).toBeInstanceOf(F451ApiError)
    expect(err.status).toBe(409)
    expect((err.body as { pageId: string }).pageId).toBe('p-9')
    expect(calls).toHaveLength(1)
  })

  it('uploads media as multipart', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { path: '_media/a.png', markdown: '![](_media/a.png)', kind: 'image' } }])
    const api = new F451Api('http://x', 't', fetchImpl)
    await api.uploadMedia('p-1', 'a.png', new Uint8Array([1, 2]), 'image/png')
    expect(calls[0].init.body).toBeInstanceOf(FormData)
    expect((calls[0].init.body as FormData).get('file')).toBeInstanceOf(File)
  })
})
