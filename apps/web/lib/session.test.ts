import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMe } from './session.js'

/** Erzeugt einen fetch-Mock mit korrekter Signatur, damit `.mock.calls` typisiert sind. */
function mockFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return vi.fn(impl)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getMe', () => {
  it('liefert den Benutzer bei 200', async () => {
    const me = {
      id: 'u1',
      email: 'anna@example.com',
      displayName: 'Anna Nowak',
      connections: { forgejo: true, github: false },
    }
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(me), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getMe('session=abc')).resolves.toEqual(me)
  })

  it('liefert null bei 401 (keine/ungültige Session)', async () => {
    const fetchMock = mockFetch(
      async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getMe(undefined)).resolves.toBeNull()
  })

  it('wirft bei anderen Fehlern weiter (z. B. 500)', async () => {
    const fetchMock = mockFetch(
      async () => new Response(JSON.stringify({ error: 'internal' }), { status: 500 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getMe(undefined)).rejects.toThrow()
  })

  it('wirft bei Netzwerkfehlern weiter', async () => {
    const fetchMock = mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getMe(undefined)).rejects.toThrow()
  })
})
