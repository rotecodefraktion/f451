import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 3).toString('base64')
const ADMIN_TOKEN = 'admin-secret-token'

/**
 * Bug (Live-Betrieb, real reproduziert an POST /admin/reindex und
 * GET /admin/status): der Session-Gate-Hook (app.ts, `onRequest`) antwortete
 * bei fehlender Session mit dem alten 1d-Body `{error: '…'}` — kollidiert mit
 * Routen, die `401: errorSchema` = `{status, reason}` (required) deklarieren
 * (admin.ts). fast-json-stringify wirft dann „status is required", Fastify
 * antwortet serverseitig mit 500 statt der beabsichtigten 401. Der Hook läuft
 * VOR dem admin-eigenen Token-Gate (`requireAdminToken`, admin.ts) — eine
 * fehlende Session blockt also schon dort, bevor das Admin-Token überhaupt
 * geprüft wird.
 */
describe.sequential('Session-Gate: 401-Format kollidiert nicht mit Routen-Schemas (Bug-Regression)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      adminToken: ADMIN_TOKEN,
      // Admin-/Lese-Routen werden nur registriert, wenn spaces + providerRegistry
      // gesetzt sind (app.ts) — für diesen Test genügt eine leere Space-Liste,
      // die Provider-Registry wird nie aufgerufen.
      spaces: [],
      providerRegistry: (): GitProvider => {
        throw new Error('unreachable: providerRegistry sollte in diesem Test nie aufgerufen werden')
      },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  it('GET /admin/status ohne Session → 401 {status,reason} (NICHT 500, NICHT {error})', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/status' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })

  it('POST /admin/reindex ohne Session → 401 {status,reason} (NICHT 500, NICHT {error})', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/reindex' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })

  it('Regression: GET /api/spaces (kein 401-Schema) ohne Session → weiterhin 401, kein 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })
})

/**
 * Issue #24 (Ops-Automatisierung): `/admin/*` muss mit einem gültigen
 * Admin-Bearer-Token ALLEIN nutzbar sein — OHNE zusätzliche eingeloggte
 * Browser-Session —, damit `POST /admin/backfill-ids`/`/admin/reindex` per
 * curl/CI/Deploy-Skript automatisierbar sind. Vorher blockte der globale
 * Session-Gate-Hook (`app.ts`) `/admin/*` schon VOR dem admin-eigenen
 * Token-Gate (`requireAdminToken`, `routes/admin.ts`) — ein gültiges Token
 * genügte nicht, es war IMMER zusätzlich eine Session nötig.
 */
describe.sequential('Session-Gate: /admin/* ist per gültigem Admin-Token ALLEIN nutzbar (Issue #24)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      adminToken: ADMIN_TOKEN,
      spaces: [],
      providerRegistry: (): GitProvider => {
        throw new Error('unreachable: providerRegistry sollte in diesem Test nie aufgerufen werden')
      },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  it('POST /admin/reindex mit gültigem Token, OHNE Session → 200 (keine Space-Liste → leerer Report)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reindex',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('POST /admin/backfill-ids mit gültigem Token, OHNE Session → 200 (keine Space-Liste → leeres perSpace)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backfill-ids',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ perSpace: {} })
  })

  it('GET /admin/status mit gültigem Token, OHNE Session → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ counters: expect.any(Object), uptime: expect.any(Number) })
  })

  it('POST /admin/reindex OHNE Token, OHNE Session → weiterhin 401 (Session-Pflicht greift, kein Bypass)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/reindex' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })

  it('POST /admin/reindex mit FALSCHEM Token, OHNE Session → weiterhin 401 (kein Bypass durch ungültiges Token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reindex',
      headers: { authorization: 'Bearer falsches-token' },
    })
    expect(res.statusCode).toBe(401)
    // Der Session-Gate-Hook verlangt bei ungültigem Token weiterhin eine Session
    // (`www-authenticate: session`) — das admin-eigene Token-Gate (401
    // „ungültiges oder fehlendes Admin-Token") wird bei fehlender Session gar
    // nicht erst erreicht.
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })

  it('Regression: GET /api/spaces mit gültigem Admin-Token, OHNE Session → weiterhin 401 (kein Kollateral-Bypass für Nicht-Admin-Routen)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })
})

/**
 * Fail-Closed (Issue #24): ohne konfiguriertes `F451_ADMIN_TOKEN`
 * (`opts.adminToken` undefined) darf ein beliebiger Bearer-Token-Header NIE
 * als Bypass der Sessionpflicht wirken — `hasValidAdminToken` liefert dann
 * immer `false` (siehe `routes/admin.ts`).
 */
describe.sequential('Session-Gate: ohne konfiguriertes Admin-Token bleibt /admin/* fail-closed session-geschützt', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      // Bewusst KEIN adminToken gesetzt (F451_ADMIN_TOKEN fehlt in der Umgebung).
      spaces: [],
      providerRegistry: (): GitProvider => {
        throw new Error('unreachable: providerRegistry sollte in diesem Test nie aufgerufen werden')
      },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  it('POST /admin/reindex mit beliebigem Bearer-Header, OHNE Session, OHNE konfiguriertes Token → 401 (kein Bypass)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reindex',
      headers: { authorization: 'Bearer irgendein-wert' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('session')
    expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
  })
})
