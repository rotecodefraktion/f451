import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, F451Error } from '../src/client.js'

/** Antwort-Attrappe der f451-API. */
function respond(status: number, body: unknown, contentType = 'application/json', extraHeaders: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers({ 'content-type': contentType, ...extraHeaders }),
  } as unknown as Response
}

function mockFetch(response: Response) {
  const spy = vi.fn(async () => response)
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('apiRequest', () => {
  it('hängt den Nutzer-Token als Bearer an und liefert JSON zurück', async () => {
    const spy = mockFetch(respond(200, [{ id: 'handbuch' }]))
    const result = await apiRequest('f451_pat_x', '/api/spaces')

    expect(result).toEqual([{ id: 'handbuch' }])
    const [url, init] = spy.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/api/spaces')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer f451_pat_x')
  })

  it('lässt leere Query-Parameter weg, statt sie als Leerstring zu senden', async () => {
    const spy = mockFetch(respond(200, []))
    await apiRequest('f451_pat_x', '/api/search', { query: { q: 'test', space: undefined, tag: '' } })

    const [url] = spy.mock.calls[0] as unknown as [URL]
    expect(url.searchParams.get('q')).toBe('test')
    expect(url.searchParams.has('space')).toBe(false)
    expect(url.searchParams.has('tag')).toBe(false)
  })

  it('liefert bei accept=text den Rohtext (für die Markdown-Quelle)', async () => {
    mockFetch(respond(200, '# Titel', 'text/markdown'))
    expect(await apiRequest('f451_pat_x', '/api/pages/p-1/raw', { accept: 'text' })).toBe('# Titel')
  })

  it('gibt bei 204 undefined zurück, statt am leeren Körper zu scheitern', async () => {
    mockFetch(respond(204, ''))
    expect(await apiRequest('f451_pat_x', '/api/pages/p-1/draft', { method: 'DELETE' })).toBeUndefined()
  })
})

describe('Fehler-Mapping', () => {
  const failing = async (status: number, body: unknown) => {
    mockFetch(respond(status, body))
    return apiRequest('f451_pat_x', '/api/spaces').catch((error: unknown) => error as F451Error)
  }

  it('erklärt bei 401 den Weg zu einem neuen Token', async () => {
    const error = await failing(401, { status: 'unauthorized' })
    expect(error).toBeInstanceOf(F451Error)
    expect(error.message).toMatch(/Token ungültig, abgelaufen oder widerrufen/)
  })

  it('erkennt das fehlende Provider-Konto an action=connect', async () => {
    // Der für Agenten folgenreichste 403: nur ein Mensch kann ihn beheben.
    const error = await failing(403, { error: 'kein Provider-Konto', action: 'connect' })
    expect(error.message).toMatch(/Forgejo-\/GitHub-Konto/)
    expect(error.message).toMatch(/Einstellungen/)
  })

  it('erkennt den read-Scope-Fall am Grund der API', async () => {
    const error = await failing(403, { reason: 'Token hat nur Lesezugriff.' })
    expect(error.message).toMatch(/nur Lese-Rechte/)
    expect(error.message).toMatch(/"write"/)
  })

  it('unterscheidet die beiden 409-Fälle: bestehende Seite vs. überholter Draft', async () => {
    const existing = await failing(409, { error: 'existiert', pageId: 'p-7' })
    expect(existing.message).toMatch(/existiert bereits eine Seite \(ID p-7\)/)

    const stale = await failing(409, { error: 'geändert', currentSha: 'abc', currentContent: '# neu' })
    expect(stale.message).toMatch(/zwischenzeitlich geändert/)
    // Der Rohkörper muss erhalten bleiben — der Agent braucht currentSha/currentContent.
    expect(stale.data).toMatchObject({ currentSha: 'abc', currentContent: '# neu' })
  })

  it('gibt die Existenz-Unschärfe der API bei 404 unaufgelöst weiter', async () => {
    const error = await failing(404, { status: 'not_found' })
    expect(error.message).toMatch(/nicht gefunden — oder kein Lesezugriff/)
  })

  it('meldet einen nicht erreichbaren Provider bei 502 als solchen', async () => {
    expect((await failing(502, { reason: 'upstream' })).message).toMatch(/Forgejo\) ist nicht erreichbar/)
  })

  it('trennt Netzwerkfehler von HTTP-Fehlern', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const error = (await apiRequest('f451_pat_x', '/api/spaces').catch((e: unknown) => e)) as F451Error
    expect(error.status).toBe(0)
    expect(error.message).toMatch(/nicht erreichbar/)
  })

  it('bleibt bei nicht-JSON-Fehlerantworten (z.B. Proxy-Fehlerseiten) funktionsfähig', async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('kein JSON')
      },
      text: async () => '<html>Bad Gateway</html>',
      headers: new Headers(),
    } as unknown as Response)
    const error = (await apiRequest('f451_pat_x', '/api/spaces').catch((e: unknown) => e)) as F451Error
    expect(error.status).toBe(500)
  })
})

describe('apiRequest bei 429 (Issue #73)', () => {
  const limited = (retryAfter: string) =>
    respond(429, { status: 'rate_limited', reason: 'Zu viele Anfragen' }, 'application/json', { 'retry-after': retryAfter })

  it('wartet eine kurze Sperre ab und wiederholt einmal', async () => {
    vi.useFakeTimers()
    try {
      const spy = vi.fn().mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(respond(200, { ok: true }))
      vi.stubGlobal('fetch', spy)

      const pending = apiRequest('f451_pat_x', '/api/spaces')
      await vi.advanceTimersByTimeAsync(1000)

      await expect(pending).resolves.toEqual({ ok: true })
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gibt eine lange Sperre mit der Wartezeit an den Agenten weiter, ohne zu wiederholen', async () => {
    const spy = mockFetch(limited('42'))

    await expect(apiRequest('f451_pat_x', '/api/spaces')).rejects.toThrow(/in 42 s erneut/)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
