import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerWriteTools } from '../src/tools/write.js'
import { authExtra, bodyOf, callOf, fakeServer, mockFetch, respond } from './naht.js'

/**
 * Test für Schreib-Tools: Verifies, dass `bump` und `note` in release_page
 * tatsächlich im HTTP-Request-Body an `POST /api/pages/:id/release` ankommen.
 *
 * Der vorherige Test hat nur ein selbst nachgebautes zod-Schema gegen
 * `safeParse` geprüft — das belegt lediglich, dass zod funktioniert, nicht
 * dass `release_page` seine Parameter überhaupt weiterreicht. Dieser Test
 * registriert die ECHTEN Tools aus `write.ts` an einer Attrappen-Server-
 * Instanz (Weg 2 aus dem Auftrag: keine eigene Nachbildung der Logik),
 * ruft den echten Handler auf und prüft, was `apiRequest` (ebenfalls echt,
 * nur `fetch` global gemockt — Muster aus `client.test.ts`) tatsächlich
 * über die Leitung schickt.
 *
 * Die Attrappe selbst steht seit den Anhang-Werkzeugen in `naht.ts`: EINE
 * Prüfnaht für alle Tool-Tests, statt sie je Datei nachzubauen.
 */

function releaseTool() {
  const { server, handlers } = fakeServer()
  registerWriteTools(server as never)
  return handlers.get('release_page')!
}

afterEach(() => vi.unstubAllGlobals())

describe('release_page tool', () => {
  it('reicht bump, note und comment unverändert im Request-Body an POST /api/pages/:id/release weiter', async () => {
    const spy = mockFetch([respond(200, { status: 'released' })])
    await releaseTool()({ id: 'p-1', bump: 'minor', note: 'Typo behoben', comment: 'LGTM' }, authExtra)

    expect(spy).toHaveBeenCalledTimes(1)
    const { url, init } = callOf(spy)
    expect(url.pathname).toBe('/api/pages/p-1/release')
    expect(init.method).toBe('POST')
    // comment behält seine eigene Bedeutung (Review-Kommentar) neben bump/note (Versionierung).
    expect(bodyOf(spy)).toEqual({ bump: 'minor', note: 'Typo behoben', comment: 'LGTM' })
  })

  it('lässt weggelassene bump/note NICHT als undefined-Feld oder Leerstring im Body auftauchen', async () => {
    const spy = mockFetch([respond(200, { status: 'released' })])
    await releaseTool()({ id: 'p-1' }, authExtra)

    // JSON.stringify lässt Objektfelder mit Wert `undefined` komplett weg —
    // genau das erwarten wir hier: Die API soll bump/note gar nicht erst
    // sehen (→ ihr eigener Default greift), statt sie als "bump":null oder
    // "note":"" fehlzuinterpretieren.
    const body = bodyOf(spy)
    expect(body).toEqual({})
    expect('bump' in body).toBe(false)
    expect('note' in body).toBe(false)
  })

  it('übernimmt nur bump ohne note unverändert', async () => {
    const spy = mockFetch([respond(200, { status: 'released' })])
    await releaseTool()({ id: 'p-1', bump: 'major' }, authExtra)

    const body = bodyOf(spy)
    expect(body).toEqual({ bump: 'major' })
    expect('note' in body).toBe(false)
  })
})
