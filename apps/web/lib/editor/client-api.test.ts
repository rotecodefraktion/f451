import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetadataSchema } from '@f451/markdown'
import {
  ClientApiError,
  SessionExpiredError,
  UploadError,
  createDraft,
  createPage,
  deletePage,
  discardDraft,
  getMetadataSchema,
  getReview,
  heartbeatLock,
  listTemplates,
  loadDiagram,
  movePage,
  releaseLock,
  releasePage,
  reorderChildren,
  requestChanges,
  requestReview,
  saveAsTemplate,
  saveDiagram,
  saveDraft,
  saveMetadataSchema,
  searchPages,
  updateDraft,
  uploadMedia,
} from './client-api.js'

/** Erzeugt einen fetch-Mock mit korrekter Signatur, damit `.mock.calls` typisiert sind
 *  (Muster: `apps/web/lib/api.test.ts`). */
function mockFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return vi.fn(impl)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDraft', () => {
  it('ruft POST /api/pages/:id/draft relativ mit credentials same-origin auf und liefert den Draft zurück', async () => {
    const draft = { branch: 'draft/home', baseSha: 'abc123', content: '# Home', lock: null }
    const fetchMock = mockFetch(async () => jsonResponse(200, draft))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createDraft('home')

    expect(result).toEqual(draft)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/draft')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).credentials).toBe('same-origin')
  })

  it('kodiert die pageId im Pfad', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(200, { branch: 'draft/path:demo/a.md', baseSha: 's', content: '', lock: null }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createDraft('path:demo/a.md')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/path%3Ademo%2Fa.md/draft')
  })
})

describe('saveDraft', () => {
  it('liefert bei 200 ein ok:true-Ergebnis mit newSha/savedAt', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { newSha: 'def456', savedAt: '2026-07-11T10:00:00Z' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveDraft('home', { content: '# Home v2', baseSha: 'abc123' })

    expect(result).toEqual({ ok: true, newSha: 'def456', savedAt: '2026-07-11T10:00:00Z' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/draft')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ content: '# Home v2', baseSha: 'abc123' })
  })

  it('liefert bei 409 ein ok:false-Ergebnis mit dem aktuellen Stand statt zu werfen (erwarteter Vertragsfall)', async () => {
    const conflictBody = {
      error: 'Entwurf "home" wurde seit dem geladenen Stand bereits geändert.',
      currentSha: 'zzz999',
      currentContent: '# Home (fremder Stand)',
    }
    const fetchMock = mockFetch(async () => jsonResponse(409, conflictBody))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveDraft('home', { content: '# Home v2', baseSha: 'abc123' })

    expect(result).toEqual({
      ok: false,
      conflict: { currentSha: 'zzz999', currentContent: '# Home (fremder Stand)' },
    })
  })

  it('wirft ClientApiError bei einem anderen Fehlerstatus (z. B. 502)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await saveDraft('home', { content: 'x', baseSha: 'abc' }).catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
    expect((err as ClientApiError).body).toEqual({ status: 'error', reason: 'Provider-Fehler: timeout' })
  })

  it('reicht opts.keepalive an fetch durch (Review-Fund 3 — pagehide/beforeunload-Pfad)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { newSha: 'def456', savedAt: '2026-07-11T10:00:00Z' }))
    vi.stubGlobal('fetch', fetchMock)

    await saveDraft('home', { content: '# Home v2', baseSha: 'abc123' }, { keepalive: true })

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).keepalive).toBe(true)
  })

  it('ohne opts (Normalfall) ist keepalive nicht gesetzt', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { newSha: 'def456', savedAt: '2026-07-11T10:00:00Z' }))
    vi.stubGlobal('fetch', fetchMock)

    await saveDraft('home', { content: '# Home v2', baseSha: 'abc123' })

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).keepalive).toBeUndefined()
  })
})

describe('discardDraft', () => {
  it('ruft DELETE /api/pages/:id/draft auf und löst bei 204 ohne Rückgabewert auf', async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(discardDraft('home')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/draft')
    expect((init as RequestInit).method).toBe('DELETE')
  })
})

describe('deletePage', () => {
  it('ruft DELETE /api/pages/:id auf und löst bei 200 {ok:true} ohne Rückgabewert auf', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deletePage('home')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home')
    expect((init as RequestInit).method).toBe('DELETE')
    expect((init as RequestInit).credentials).toBe('same-origin')
  })

  it('kodiert die pageId (Fallback-Id mit Slash/Doppelpunkt)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await deletePage('path:demo/a/b.md')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/path%3Ademo%2Fa%2Fb.md')
  })

  it('403 (kein Schreibrecht) wirft ClientApiError', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { error: 'Kein Schreibrecht.' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deletePage('home')).rejects.toBeInstanceOf(ClientApiError)
  })
})

describe('uploadMedia', () => {
  const file = new File(['pngbytes'], 'diagram.png', { type: 'image/png' })

  it('lädt eine Datei als multipart/form-data hoch und liefert path/markdown/kind', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(200, { path: '_media/diagram.png', markdown: '![](_media/diagram.png)', kind: 'image' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await uploadMedia('home', file)

    expect(result).toEqual({ path: '_media/diagram.png', markdown: '![](_media/diagram.png)', kind: 'image' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/draft/media')
    expect((init as RequestInit).method).toBe('POST')
    const body = (init as RequestInit).body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('file')).toBe(file)
  })

  it.each([
    [413, 'Datei überschreitet das Größenlimit von 10485760 Bytes.'],
    [415, 'Dateityp nicht erlaubt.'],
    [422, 'SVG nach dem Sanitizing leer/ungültig.'],
  ])('wirft bei %i eine UploadError mit der präzisen Server-Meldung aus dem "reason"-Feld', async (status, reason) => {
    const fetchMock = mockFetch(async () => jsonResponse(status, { status: 'x', reason }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await uploadMedia('home', file).catch((e) => e)

    expect(err).toBeInstanceOf(UploadError)
    expect((err as UploadError).status).toBe(status)
    expect((err as UploadError).message).toBe(reason)
  })
})

describe('saveDiagram', () => {
  it('ruft PUT /api/pages/:id/draft/diagram mit dem Body auf und liefert bei 200 ok:true mit path', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { path: '_media/fluss.drawio.svg' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveDiagram('home', { path: '_media/fluss.drawio.svg', content: '<svg/>', ifAbsent: true })

    expect(result).toEqual({ ok: true, path: '_media/fluss.drawio.svg' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/draft/diagram')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      path: '_media/fluss.drawio.svg',
      content: '<svg/>',
      ifAbsent: true,
    })
  })

  it('liefert bei 409 ein ok:false-Ergebnis mit reason:"exists" statt zu werfen (erwarteter Vertragsfall)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { status: 'conflict', reason: 'Diagramm existiert bereits.' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveDiagram('home', { path: '_media/fluss.drawio.svg', content: '<svg/>', ifAbsent: true })

    expect(result).toEqual({ ok: false, reason: 'exists' })
  })

  it.each([413, 415, 422])('wirft bei %i eine ClientApiError', async (status) => {
    const fetchMock = mockFetch(async () => jsonResponse(status, { status: 'x', reason: 'kaputt' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await saveDiagram('home', { path: '_media/fluss.drawio.svg', content: '<svg/>' }).catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(status)
  })
})

describe('loadDiagram', () => {
  it('lädt den Draft-Stand einer Diagrammdatei als Text über die Media-Route', async () => {
    const fetchMock = mockFetch(async () => new Response('<svg>x</svg>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const text = await loadDiagram('home', '_media/fluss.drawio.svg')

    expect(text).toBe('<svg>x</svg>')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/media/home/fluss.drawio.svg?ref=draft')
  })

  it('wirft eine ClientApiError bei 404', async () => {
    const fetchMock = mockFetch(async () => new Response('not found', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await loadDiagram('home', '_media/fluss.drawio.svg').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(404)
  })

  it('leitet bei 401 zur Login-Seite weiter und wirft SessionExpiredError statt ClientApiError', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(401, { status: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)
    const locationStub = { pathname: '/wiki/demo/home/edit', search: '', href: '' }
    vi.stubGlobal('window', { location: locationStub })

    const err = await loadDiagram('home', '_media/fluss.drawio.svg').catch((e) => e)

    expect(err).toBeInstanceOf(SessionExpiredError)
    expect(err).not.toBeInstanceOf(ClientApiError)
    expect(locationStub.href).toBe('/?next=%2Fwiki%2Fdemo%2Fhome%2Fedit')
  })
})

describe('heartbeatLock', () => {
  it('ruft PUT /api/locks/:pageId auf und liefert die Lock-Info', async () => {
    const lock = { heldBy: 'Anna Nowak', expiresAt: '2026-07-11T10:02:00Z', mine: true }
    const fetchMock = mockFetch(async () => jsonResponse(200, lock))
    vi.stubGlobal('fetch', fetchMock)

    const result = await heartbeatLock('home')

    expect(result).toEqual(lock)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/locks/home')
    expect((init as RequestInit).method).toBe('PUT')
  })
})

describe('releaseLock', () => {
  it('ruft DELETE /api/locks/:pageId mit keepalive:true auf (Unmount-Pfad)', async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await releaseLock('home')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/locks/home')
    expect((init as RequestInit).method).toBe('DELETE')
    expect((init as RequestInit).keepalive).toBe(true)
  })
})

describe('searchPages', () => {
  it('baut die Query nur mit q, wenn space/ref fehlen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await searchPages('deploy')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/search?q=deploy')
  })

  it('hängt space und ref an und kodiert Sonderzeichen im Suchbegriff', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await searchPages('a b&c', { space: 'demo/sub', ref: 'draft' })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/search?q=a%20b%26c&space=demo%2Fsub&ref=draft')
  })

  it('liefert die Trefferliste typisiert (id/title/space/path/snippet)', async () => {
    const hits = [{ id: 'home', title: 'Home', space: 'demo', path: 'demo/index.md', snippet: '<b>Home</b>' }]
    const fetchMock = mockFetch(async () => jsonResponse(200, hits))
    vi.stubGlobal('fetch', fetchMock)

    const result = await searchPages('home')

    expect(result).toEqual(hits)
  })

  it('hängt prefix=true an, wenn Präfix-Suche gewünscht ist (Phase 3a)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await searchPages('deplo', { space: 'demo', prefix: true })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/search?q=deplo&space=demo&prefix=true')
  })
})

describe('requestReview', () => {
  it('ruft POST /api/pages/:id/review auf und liefert bei 200 ok:true mit dem Review-Stand', async () => {
    const review = { number: 42, url: 'https://forgejo.example/f451/repo/pulls/42', state: 'review', mergeable: true }
    const fetchMock = mockFetch(async () => jsonResponse(200, review))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestReview('home')

    expect(result).toEqual({ ok: true, review })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/review')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('mergeable:false ist Teil des normalen Erfolgsergebnisses, kein Fehlerfall', async () => {
    const review = { number: 1, url: 'https://x', state: 'review', mergeable: false }
    const fetchMock = mockFetch(async () => jsonResponse(200, review))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestReview('home')

    expect(result).toEqual({ ok: true, review })
  })

  it('hängt reviewers an, wenn übergeben', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { number: 1, url: 'x', state: 'review', mergeable: null }))
    vi.stubGlobal('fetch', fetchMock)

    await requestReview('home', ['anna', 'bob'])

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ reviewers: ['anna', 'bob'] })
  })

  it('liefert bei 409 (kein Entwurf vorhanden) ein ok:false-Ergebnis statt zu werfen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'kein Entwurf vorhanden' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestReview('home')

    expect(result).toEqual({ ok: false, reason: 'no-draft' })
  })

  it('liefert bei 422 (Fix #11: Draft ohne Commits gegenüber main) ein ok:false-Ergebnis statt zu werfen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(422, { error: 'Draft has no changes', reason: 'no_changes' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestReview('home')

    expect(result).toEqual({ ok: false, reason: 'no-changes' })
  })

  it('wirft ClientApiError bei 422 OHNE reason:"no_changes" (anderer Provider-Fehler)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(422, { error: 'irgendein anderer Fehler' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await requestReview('home').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(422)
  })

  it('wirft ClientApiError bei einem anderen Fehlerstatus (z. B. 502)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await requestReview('home').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
  })
})

describe('releasePage', () => {
  it('liefert bei 200 ok:true mit mergeSha (+ approveWarning, falls gesetzt)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { mergeSha: 'abc', approveWarning: 'Approve fehlgeschlagen' }))
    vi.stubGlobal('fetch', fetchMock)

    // Signaturänderung (Task 9): der zweite Parameter ist jetzt ein
    // Optionsobjekt statt eines nackten Kommentar-Strings — s.
    // `ReleaseOptions` in client-api.ts.
    const result = await releasePage('home', { comment: 'Sieht gut aus' })

    expect(result).toEqual({ ok: true, result: { mergeSha: 'abc', approveWarning: 'Approve fehlgeschlagen' } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/release')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ comment: 'Sieht gut aus' })
  })

  // Task 9: `bump`/`note` sind nur in versionierten Spaces wirksam, aber
  // client-api.ts kennt diese Unterscheidung nicht — sie reicht einfach
  // durch, was übergeben wird. Leere/fehlende Felder werden weggelassen
  // (nicht als `undefined`/`''` mitgeschickt), damit der Server-Vertrag
  // schlank bleibt (identisch zum bestehenden `comment`-Verhalten oben).
  it('sendet bump und note im Body', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { mergeSha: 'abc', version: '1.2.0' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await releasePage('home', { bump: 'minor', note: 'Rate-Limits ergänzt' })

    expect(result.ok).toBe(true)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ bump: 'minor', note: 'Rate-Limits ergänzt' })
  })

  it('lässt leere Felder weg', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { mergeSha: 'abc' }))
    vi.stubGlobal('fetch', fetchMock)

    await releasePage('home')

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('liefert bei 403 (kein Freigabe-Recht) ein ok:false-Ergebnis statt zu werfen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { error: 'Kein Freigabe-Recht auf dieses Repository' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await releasePage('home')

    expect(result).toEqual({ ok: false, status: 403, error: 'Kein Freigabe-Recht auf dieses Repository' })
  })

  it('liest bei 403 im {status,reason}-Format (CSRF-Origin-Check, Phase 4a Task 3) das reason-Feld', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { status: 'forbidden', reason: 'Ungültige Origin.' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await releasePage('home')

    expect(result).toEqual({ ok: false, status: 403, error: 'Ungültige Origin.' })
  })

  it('liefert bei 409 mit reason:"conflict" (nicht mergebar) das Reason-Feld mit', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'Merge-Konflikt', reason: 'conflict' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await releasePage('home')

    expect(result).toEqual({ ok: false, status: 409, error: 'Merge-Konflikt', reason: 'conflict' })
  })

  it('liefert bei 409 ohne reason (kein offener PR) reason:undefined', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'kein offener Pull Request vorhanden' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await releasePage('home')

    expect(result).toEqual({ ok: false, status: 409, error: 'kein offener Pull Request vorhanden', reason: undefined })
  })

  it('liefert bei 422 (Fix #11: offener PR ohne Commits gegenüber main) ein ok:false-Ergebnis statt zu werfen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(422, { error: 'Draft has no changes', reason: 'no_changes' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await releasePage('home')

    expect(result).toEqual({ ok: false, status: 422, reason: 'no_changes' })
  })

  it('wirft ClientApiError bei 422 OHNE reason:"no_changes" (anderer Fehler)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(422, { error: 'irgendein anderer Fehler' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await releasePage('home').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(422)
  })
})

describe('requestChanges', () => {
  it('liefert bei 204 ok:true', async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestChanges('home', 'Bitte Abschnitt X überarbeiten')

    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/review/request-changes')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ comment: 'Bitte Abschnitt X überarbeiten' })
  })

  it('liefert bei 409 (kein offener PR) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'kein offener Pull Request vorhanden' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestChanges('home', 'x')

    expect(result).toEqual({ ok: false, status: 409, error: 'kein offener Pull Request vorhanden' })
  })

  it('liefert bei 422 (Provider-Fehler, z. B. Self-Request) ein ok:false-Ergebnis mit der Server-Meldung', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(422, { error: 'Poster of PR can not request changes on own PR' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestChanges('home', 'x')

    expect(result).toEqual({ ok: false, status: 422, error: 'Poster of PR can not request changes on own PR' })
  })
})

describe('updateDraft', () => {
  it('liefert bei 200 ok:true mit dem neuen Draft-Stand', async () => {
    const info = { baseSha: 'newsha', content: '# Home', state: 'working', pr: null }
    const fetchMock = mockFetch(async () => jsonResponse(200, info))
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateDraft('home', 'take-main')

    expect(result).toEqual({ ok: true, info })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/draft/update')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ strategy: 'take-main' })
  })

  it('reicht `pr`/`warning` durch, wenn gesetzt (Randfall: war ein PR offen)', async () => {
    const info = { baseSha: 's', content: 'x', state: 'review', pr: { number: 3, url: 'https://x' }, warning: 'Bild verloren: _media/a.png' }
    const fetchMock = mockFetch(async () => jsonResponse(200, info))
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateDraft('home', 'keep-mine')

    expect(result).toEqual({ ok: true, info })
  })

  it('liefert bei 502 NACH dem Verwerfen ein ok:false-Ergebnis mit preservedContent (kein stiller Verlust)', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout', preservedContent: '# Meine Änderungen' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateDraft('home', 'take-main')

    expect(result).toEqual({ ok: false, message: 'Provider-Fehler: timeout', preservedContent: '# Meine Änderungen' })
  })

  it('liefert bei 502 VOR dem Verwerfen ein ok:false-Ergebnis OHNE preservedContent', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateDraft('home', 'take-main')

    expect(result).toEqual({ ok: false, message: 'Provider-Fehler: timeout', preservedContent: undefined })
  })

  it('wirft ClientApiError bei 404 (kein Draft vorhanden)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(404, { status: 'not_found', reason: 'Kein Entwurf' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await updateDraft('home', 'take-main').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(404)
  })
})

describe('createPage', () => {
  it('ruft POST /api/pages auf und liefert bei 201 ok:true (parentId nur, wenn übergeben)', async () => {
    const page = { id: 'p-neu', space: 'demo', path: 'demo/neu/index.md', branch: 'draft/p-neu', baseSha: 's', content: '# Neu' }
    const fetchMock = mockFetch(async () => jsonResponse(201, page))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPage('demo', 'Neu')

    expect(result).toEqual({ ok: true, page })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ space: 'demo', title: 'Neu' })
  })

  it('hängt parentId an, wenn übergeben', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(201, { id: 'p', space: 'demo', path: 'demo/eltern/neu/index.md', branch: 'draft/p', baseSha: 's', content: 'x' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createPage('demo', 'Neu', 'p-eltern')

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ space: 'demo', title: 'Neu', parentId: 'p-eltern' })
  })

  it('liefert bei 409 (Kollision) ein ok:false-Ergebnis mit der pageId der bestehenden Seite', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(409, { error: 'Unter diesem Pfad existiert bereits eine Seite', pageId: 'p-bestehend' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPage('demo', 'Doppelt')

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'Unter diesem Pfad existiert bereits eine Seite',
      pageId: 'p-bestehend',
    })
  })

  it('wirft ClientApiError bei 409 ohne pageId (defekter Body) statt zu crashen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'Kollision' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await createPage('demo', 'Doppelt').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(409)
  })

  it('liefert bei 400 (ungültiger Titel-Slug) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(400, { status: 'bad_request', reason: 'Titel ergibt keinen gültigen Namen' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPage('demo', '???')

    expect(result).toEqual({ ok: false, status: 400, error: 'Titel ergibt keinen gültigen Namen' })
  })

  it('liefert bei 403 (kein Schreibrecht) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { error: 'Kein Schreibrecht für diesen Space', action: 'connect' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPage('demo', 'Neu')

    expect(result).toEqual({ ok: false, status: 403, error: 'Kein Schreibrecht für diesen Space' })
  })

  it('liest bei 403 im {status,reason}-Format (CSRF-Origin-Check, Phase 4a Task 3) das reason-Feld', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { status: 'forbidden', reason: 'Ungültige Origin.' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPage('demo', 'Neu')

    expect(result).toEqual({ ok: false, status: 403, error: 'Ungültige Origin.' })
  })

  it('kodiert nichts im Pfad zusätzlich — space/title/parentId reisen ausschließlich im Body', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(201, { id: 'p', space: 'demo/sub', path: 'x', branch: 'draft/p', baseSha: 's', content: 'x' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createPage('demo/sub', 'Ü Titel #1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ space: 'demo/sub', title: 'Ü Titel #1' })
  })

  it('hängt templateId an den Body an, wenn gesetzt', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(201, { id: 'x', space: 'demo', path: 'x/index.md', branch: 'draft/x', baseSha: 's', content: '' }))
    vi.stubGlobal('fetch', fetchMock)

    await createPage('demo', 'Team-Sync', undefined, 'space:notiz')

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ space: 'demo', title: 'Team-Sync', templateId: 'space:notiz' })
  })
})

describe('movePage', () => {
  it('ruft POST /api/pages/:id/move mit dem Body 1:1 auf (title/parentId werden NICHT normalisiert) und liefert bei 200 ok:true', async () => {
    const page = { id: 'p-x', space: 'demo', path: 'ziel/p-x/index.md', movedCount: 1 }
    const fetchMock = mockFetch(async () => jsonResponse(200, page))
    vi.stubGlobal('fetch', fetchMock)

    const result = await movePage('p-x', { title: 'Neuer Titel', parentId: 'p-eltern' })

    expect(result).toEqual({ ok: true, page })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/p-x/move')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: 'Neuer Titel', parentId: 'p-eltern' })
  })

  it('kodiert die pageId im Pfad', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { id: 'x', space: 'demo', path: 'x/index.md', movedCount: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    await movePage('path:demo/a/b.md', {})

    expect(fetchMock.mock.calls[0][0]).toBe('/api/pages/path%3Ademo%2Fa%2Fb.md/move')
  })

  it('sendet parentId:null unverändert (Ziel = Space-Wurzel) statt es wegzulassen wie undefined', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { id: 'x', space: 'demo', path: 'x/index.md', movedCount: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await movePage('x', { parentId: null })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ parentId: null })
  })

  it('lässt fehlende Felder aus dem Body weg (kein title/parentId → leerer Body)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { id: 'x', space: 'demo', path: 'x/index.md', movedCount: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    await movePage('x', {})

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('liefert bei 409 (Pfad-Kollision) ein ok:false-Ergebnis mit der pageId der bestehenden Seite', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'Kollision', pageId: 'p-bestehend' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await movePage('x', { title: 'Doppelt' })

    expect(result).toEqual({ ok: false, status: 409, error: 'Kollision', pageId: 'p-bestehend', blockedPageIds: undefined })
  })

  it('liefert bei 409 (Draft/Lock-Blockade) ein ok:false-Ergebnis mit blockedPageIds', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(409, { status: 'conflict', reason: 'Offener Entwurf', blockedPageIds: ['a', 'b'] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await movePage('x', { title: 'Y' })

    expect(result).toEqual({ ok: false, status: 409, error: 'Offener Entwurf', pageId: undefined, blockedPageIds: ['a', 'b'] })
  })

  it('liefert bei 400 (ungültiger Titel/Zyklus) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(400, { status: 'bad_request', reason: 'Ungültiges Ziel' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await movePage('x', { parentId: 'x-kind' })

    expect(result).toEqual({ ok: false, status: 400, error: 'Ungültiges Ziel' })
  })

  it('liefert bei 404 (unbekannte Seite/parentId) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(404, { status: 'not_found', reason: 'unbekannt' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await movePage('x', { parentId: 'gibt-es-nicht' })

    expect(result).toEqual({ ok: false, status: 404, error: 'unbekannt' })
  })

  it('liefert bei 403 (kein Schreibrecht) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { error: 'Kein Schreibrecht für diesen Space' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await movePage('x', { title: 'Y' })

    expect(result).toEqual({ ok: false, status: 403, error: 'Kein Schreibrecht für diesen Space' })
  })

  it('wirft ClientApiError bei 502 (Provider-Fehler)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await movePage('x', { title: 'Y' }).catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
  })
})

describe('reorderChildren', () => {
  it('ruft PUT /api/spaces/:space/order mit {parentId, orderedIds} auf und liefert bei 200 ok:true', async () => {
    const result1 = { parentId: 'p-eltern', path: 'eltern/.order', orderedIds: ['p-b', 'p-a'] }
    const fetchMock = mockFetch(async () => jsonResponse(200, result1))
    vi.stubGlobal('fetch', fetchMock)

    const result = await reorderChildren('demo', 'p-eltern', ['p-b', 'p-a'])

    expect(result).toEqual({ ok: true, result: result1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/spaces/demo/order')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ parentId: 'p-eltern', orderedIds: ['p-b', 'p-a'] })
  })

  it('kodiert die Space-Id im Pfad', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { parentId: null, path: '.order', orderedIds: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await reorderChildren('a/b', null, [])

    expect(fetchMock.mock.calls[0][0]).toBe('/api/spaces/a%2Fb/order')
  })

  it('sendet parentId:null unverändert (Space-Wurzel)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, { parentId: null, path: '.order', orderedIds: ['x'] }))
    vi.stubGlobal('fetch', fetchMock)

    await reorderChildren('demo', null, ['x'])

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ parentId: null, orderedIds: ['x'] })
  })

  it('liefert bei 400 (Fremd-Id/Duplikat) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(400, { status: 'bad_request', reason: 'Fremd-Id' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await reorderChildren('demo', 'p-eltern', ['fremd'])

    expect(result).toEqual({ ok: false, status: 400, error: 'Fremd-Id' })
  })

  it('liefert bei 404 (Space/parentId unbekannt) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(404, { status: 'not_found', reason: 'unbekannt' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await reorderChildren('demo', 'gibt-es-nicht', [])

    expect(result).toEqual({ ok: false, status: 404, error: 'unbekannt' })
  })

  it('liefert bei 403 (kein Schreibrecht) ein ok:false-Ergebnis', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { error: 'Kein Schreibrecht für diesen Space' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await reorderChildren('demo', null, [])

    expect(result).toEqual({ ok: false, status: 403, error: 'Kein Schreibrecht für diesen Space' })
  })

  it('wirft ClientApiError bei 502 (Provider-Fehler)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await reorderChildren('demo', null, []).catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
  })
})

describe('listTemplates', () => {
  it('ruft GET /api/spaces/:space/templates auf und liefert die Liste typisiert', async () => {
    const templates = [{ id: 'space:notiz', name: 'Notiz', description: '', source: 'space' }]
    const fetchMock = mockFetch(async () => jsonResponse(200, templates))
    vi.stubGlobal('fetch', fetchMock)

    expect(await listTemplates('demo/sub')).toEqual(templates)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/spaces/demo%2Fsub/templates')
  })
})

describe('getReview', () => {
  it('ruft GET /api/pages/:id/review auf und liefert bei 200 ok:true', async () => {
    const review = {
      pr: { number: 5, url: 'https://x', state: 'open', mergeable: true, title: 'Deployment' },
      authorName: 'Anna Nowak',
      diff: { blocks: [] },
      page: { id: 'home', space: 'demo', title: 'Deployment' },
    }
    const fetchMock = mockFetch(async () => jsonResponse(200, review))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getReview('home')

    expect(result).toEqual({ ok: true, review })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pages/home/review')
    expect((init as RequestInit).method ?? 'GET').toBe('GET')
  })

  it('liefert bei 404 (kein offenes Review) ein ok:false-Ergebnis statt zu werfen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(404, { status: 'not_found', reason: 'kein offenes Review' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getReview('home')

    expect(result).toEqual({ ok: false, reason: 'not-open' })
  })

  it('wirft ClientApiError bei einem anderen Fehlerstatus (z. B. 502)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await getReview('home').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
  })
})

describe('saveAsTemplate', () => {
  it('POSTet Name/Beschreibung/Content und liefert ok:true mit file/path', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(201, { file: 'runbook', path: '_templates/runbook.md' }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await saveAsTemplate('demo', { name: 'Runbook', content: '# X\n' })
    expect(result).toEqual({ ok: true, file: 'runbook', path: '_templates/runbook.md' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/spaces/demo/templates')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('409 (existiert) wird als diskriminiertes Ergebnis geliefert, nicht geworfen', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(409, { error: 'Vorlage existiert bereits.', file: 'runbook' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await saveAsTemplate('demo', { name: 'Runbook', content: '' })).toEqual({ ok: false, status: 409, error: 'Vorlage existiert bereits.' })
  })

  it('400 (ungültiger Name) wird als diskriminiertes Ergebnis geliefert', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(400, { status: 'bad_request', reason: 'name darf nicht leer sein.' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await saveAsTemplate('demo', { name: '', content: '' })).toEqual({ ok: false, status: 400, error: 'name darf nicht leer sein.' })
  })

  it('403 (kein Schreibrecht) wird als diskriminiertes Ergebnis geliefert', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { error: 'Kein Recht, Templates in diesem Space anzulegen.' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await saveAsTemplate('demo', { name: 'Runbook', content: '' })).toEqual({
      ok: false,
      status: 403,
      error: 'Kein Recht, Templates in diesem Space anzulegen.',
    })
  })

  it('liest bei 403 im {status,reason}-Format (CSRF-Origin-Check, Phase 4a Task 3) das reason-Feld', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { status: 'forbidden', reason: 'Ungültige Origin.' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await saveAsTemplate('demo', { name: 'Runbook', content: '' })).toEqual({
      ok: false,
      status: 403,
      error: 'Ungültige Origin.',
    })
  })

  it('wirft ClientApiError bei einem anderen Fehlerstatus (z. B. 502)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout' }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await saveAsTemplate('demo', { name: 'Runbook', content: '' }).catch((e) => e)
    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
  })
})

describe('getMetadataSchema', () => {
  it('ruft GET /api/spaces/:space/metadata-schema auf und liefert das Schema typisiert', async () => {
    const schema: MetadataSchema = {
      fields: [{ key: 'process_id', label: 'Process ID', type: 'text' }],
      versioning: false,
    }
    const fetchMock = mockFetch(async () => jsonResponse(200, schema))
    vi.stubGlobal('fetch', fetchMock)

    expect(await getMetadataSchema('demo/sub')).toEqual(schema)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/spaces/demo%2Fsub/metadata-schema')
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
  })

  it('wirft ClientApiError bei einem Fehlerstatus (z. B. 404)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(404, { status: 'not_found', reason: 'nicht konfiguriert' }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await getMetadataSchema('demo').catch((e) => e)
    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(404)
  })
})

describe('saveMetadataSchema', () => {
  const schema: MetadataSchema = {
    fields: [{ key: 'status', label: 'Status', type: 'enum', options: ['a', 'b'] }],
    versioning: false,
  }

  it('PUTet das Schema und liefert bei 200 ok:true mit dem (ggf. server-normalisierten) Schema', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, schema))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveMetadataSchema('demo', schema)

    expect(result).toEqual({ ok: true, schema })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/spaces/demo/metadata-schema')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(schema)
  })

  it('400 (Validierungsfehler) wird als diskriminiertes Ergebnis MIT errors-Liste geliefert', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(400, {
        status: 'bad_request',
        reason: 'Das Metadaten-Schema ist ungültig — s. "errors" für Details.',
        errors: ['fields[0]: "key" ("dup") ist bereits vergeben'],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await saveMetadataSchema('demo', schema)).toEqual({
      ok: false,
      status: 400,
      error: 'Das Metadaten-Schema ist ungültig — s. "errors" für Details.',
      errors: ['fields[0]: "key" ("dup") ist bereits vergeben'],
    })
  })

  it('403 (kein Schreibrecht) wird als diskriminiertes Ergebnis geliefert', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(403, { error: 'Kein Recht, das Metadaten-Schema in diesem Space zu ändern.' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await saveMetadataSchema('demo', schema)).toEqual({
      ok: false,
      status: 403,
      error: 'Kein Recht, das Metadaten-Schema in diesem Space zu ändern.',
    })
  })

  it('liest bei 403 im {status,reason}-Format (CSRF-Origin-Check) das reason-Feld', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(403, { status: 'forbidden', reason: 'Ungültige Origin.' }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await saveMetadataSchema('demo', schema)).toEqual({ ok: false, status: 403, error: 'Ungültige Origin.' })
  })

  it('wirft ClientApiError bei einem anderen Fehlerstatus (z. B. 404/502)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(502, { status: 'error', reason: 'Provider-Fehler: timeout' }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await saveMetadataSchema('demo', schema).catch((e) => e)
    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(502)
  })
})

describe('401-Behandlung (Redirect-Signal statt ClientApiError)', () => {
  it('leitet zur Login-Seite mit next=<aktueller Pfad> weiter und wirft SessionExpiredError statt ClientApiError', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(401, { status: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)
    const locationStub = { pathname: '/wiki/demo/home/edit', search: '', href: '' }
    vi.stubGlobal('window', { location: locationStub })

    const err = await createDraft('home').catch((e) => e)

    expect(err).toBeInstanceOf(SessionExpiredError)
    expect(err).not.toBeInstanceOf(ClientApiError)
    expect(locationStub.href).toBe('/?next=%2Fwiki%2Fdemo%2Fhome%2Fedit')
  })
})

describe('Netzwerkfehler', () => {
  it('wirft ClientApiError mit status=0 bei einem Netzwerkfehler', async () => {
    const fetchMock = mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    const err = await createDraft('home').catch((e) => e)

    expect(err).toBeInstanceOf(ClientApiError)
    expect((err as ClientApiError).status).toBe(0)
  })
})
