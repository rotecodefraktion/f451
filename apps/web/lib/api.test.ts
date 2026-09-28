import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from './api.js'

const OLD_ENV = process.env.API_URL

/** Erzeugt einen fetch-Mock mit korrekter Signatur, damit `.mock.calls` typisiert sind. */
function mockFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return vi.fn(impl)
}

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.API_URL = OLD_ENV
})

describe('apiFetch', () => {
  it('gibt den JSON-Body bei 200 zurück und ruft die richtige URL auf', async () => {
    process.env.API_URL = 'http://api.test:3001'
    const fetchMock = mockFetch(async () =>
      new Response(JSON.stringify({ id: 'p1', title: 'Deployment' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const data = await apiFetch<{ id: string; title: string }>('/api/pages/p1')

    expect(data).toEqual({ id: 'p1', title: 'Deployment' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test:3001/api/pages/p1')
  })

  it('reicht den Cookie-Header an die API weiter', async () => {
    const fetchMock = mockFetch(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/me', { cookie: 'session=abc123' })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('cookie')).toBe('session=abc123')
  })

  it('wirft ApiError mit status=404 bei nicht gefundener Ressource', async () => {
    const fetchMock = mockFetch(async () =>
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const err = await apiFetch('/api/pages/missing').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).body).toEqual({ error: 'not_found' })
  })

  it('wirft ApiError mit status=0 bei Netzwerkfehler', async () => {
    const fetchMock = mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    const err = await apiFetch('/api/me').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('verwendet localhost:3001 als Fallback ohne API_URL', async () => {
    delete process.env.API_URL
    const fetchMock = mockFetch(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/me')

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/me')
  })
})
