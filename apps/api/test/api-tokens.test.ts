import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { hashApiToken } from '../src/auth/crypto.js'
import { createSession, SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { apiTokens, users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * MCP-Phase 0 (pro-Nutzer-API-Token-Authentifizierung): das Fundament, auf
 * dem der spätere MCP-Server als der jeweilige Nutzer liest/schreibt.
 * Kernannahme (verifiziert): ein API-Token authentifiziert `req.user` exakt
 * wie eine Session — bestehende Schreibrouten (die nur an `req.user.id`
 * hängen) bleiben dadurch UNVERÄNDERT funktionsfähig, ohne dass diese Tests
 * das erneut prüfen müssten (Fokus hier: Auth-Pfad + Token-Verwaltung).
 */
const TOKEN_KEY = Buffer.alloc(32, 11).toString('base64')
const ADMIN_TOKEN = 'admin-secret-does-not-start-with-pat-prefix'

describe.sequential('MCP-Phase 0: API-Token-Authentifizierung', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance
  let userCounter = 0

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      adminToken: ADMIN_TOKEN,
      // Admin-/Schreib-Routen (POST /api/pages) werden nur registriert, wenn
      // spaces + providerRegistry gesetzt sind (app.ts) — leere Liste genügt,
      // die Registry wird in diesen Tests nie tatsächlich aufgerufen (die
      // Scope-Gate-403s greifen VOR jedem Handler-Aufruf).
      spaces: [],
      providerRegistry: (): GitProvider => {
        throw new Error('unreachable: providerRegistry sollte in diesen Tests nie aufgerufen werden')
      },
    })
    // Zusätzliche Sonden-Route (Muster `test/auth-hardening.test.ts#CSRF-
    // Origin-Check`): eine simple, immer registrierte POST-Route unter /api/,
    // um das Scope-Gate isoliert von der echten Business-Logik (Provider,
    // Space-Auflösung) zu prüfen.
    app.post('/api/probe-write', async () => ({ ok: true }))
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  async function insertUser(prefix: string): Promise<string> {
    userCounter += 1
    const userId = `${prefix}-${userCounter}`
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.org`,
      displayName: `Token Test User ${userCounter}`,
    })
    return userId
  }

  async function createSessionCookie(prefix: string): Promise<{ userId: string; cookie: string }> {
    const userId = await insertUser(prefix)
    const session = await createSession(db, userId)
    return { userId, cookie: session.id }
  }

  /** Erzeugt via `POST /api/tokens` (Session-Auth) ein echtes Token — Roundtrip statt Direktinsert. */
  async function mintToken(
    cookie: string,
    scope: 'read' | 'write',
    label = 'Test-Token',
  ): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: { label, scope },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; token: string }
    return body
  }

  describe('(a) gültiger f451_pat-Token gegen eine GET-/api-Route → 200, req.user korrekt', () => {
    it('GET /api/me mit Bearer-Token liefert denselben Nutzer wie die Session, die das Token ausgestellt hat', async () => {
      const { userId, cookie } = await createSessionCookie('pat-a')
      const { token } = await mintToken(cookie, 'write')

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: userId, email: `${userId}@example.org` })
    })
  })

  describe('(b) read-scope-Token gegen schreibende Requests → 403', () => {
    it('POST /api/probe-write mit read-scope-Token → 403 forbidden ("nur Lesezugriff")', async () => {
      const { cookie } = await createSessionCookie('pat-b1')
      const { token } = await mintToken(cookie, 'read')

      const res = await app.inject({
        method: 'POST',
        url: '/api/probe-write',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ status: 'forbidden', reason: expect.any(String) })
    })

    it('POST /api/pages (echte Schreibroute) mit read-scope-Token → 403, providerRegistry nie aufgerufen', async () => {
      const { cookie } = await createSessionCookie('pat-b2')
      const { token } = await mintToken(cookie, 'read')

      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        headers: { authorization: `Bearer ${token}` },
        payload: { space: 'irrelevant', title: 'Irrelevant' },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ status: 'forbidden', reason: expect.any(String) })
    })

    it('write-scope-Token gegen dieselbe Sonden-Route → durch (kein 403)', async () => {
      const { cookie } = await createSessionCookie('pat-b3')
      const { token } = await mintToken(cookie, 'write')

      const res = await app.inject({
        method: 'POST',
        url: '/api/probe-write',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })

      expect(res.statusCode).toBe(200)
    })

    it('read-scope-Token gegen GET bleibt unberührt (Lesen ist erlaubt)', async () => {
      const { cookie } = await createSessionCookie('pat-b4')
      const { token } = await mintToken(cookie, 'read')

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(200)
    })
  })

  describe('(c) widerrufener + abgelaufener Token → 401', () => {
    it('widerrufenes Token → 401 unauthorized', async () => {
      const { cookie } = await createSessionCookie('pat-c1')
      const { id, token } = await mintToken(cookie, 'write')

      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${id}`,
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      })
      expect(revokeRes.statusCode).toBe(200)

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
    })

    it('abgelaufenes Token → 401 unauthorized', async () => {
      const { cookie } = await createSessionCookie('pat-c2')
      const { id, token } = await mintToken(cookie, 'write')

      // Ablauf simulieren (kein expiresInDays-Roundtrip nötig — direktes Update).
      await db
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(apiTokens.id, id))

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(401)
    })

    it('unbekanntes/erfundenes Token → 401 unauthorized', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: 'Bearer f451_pat_erfunden-und-ungueltig' },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('(d) Session-Cookie-Nutzer bleibt unbeeinflusst', () => {
    it('normale Session kann weiterhin schreiben (kein Scope-Gate für Session-Auth)', async () => {
      const { cookie } = await createSessionCookie('pat-d1')

      const res = await app.inject({
        method: 'POST',
        url: '/api/probe-write',
        cookies: { [SESSION_COOKIE_NAME]: cookie },
        payload: {},
      })

      expect(res.statusCode).toBe(200)
    })

    it('normale Session liest weiterhin problemlos', async () => {
      const { userId, cookie } = await createSessionCookie('pat-d2')

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: userId })
    })
  })

  describe('(e) Admin-Token ↔ API-Token Kollisionsfreiheit', () => {
    it('echtes Admin-Bearer-Token funktioniert weiterhin für /admin/status (unbeeinflusst)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('ein gültiges API-Token gilt NIE als Admin-Token (/admin/status bleibt 401)', async () => {
      const { cookie } = await createSessionCookie('pat-e1')
      const { token } = await mintToken(cookie, 'write')

      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { authorization: `Bearer ${token}` },
      })
      // req.user ist zwar gesetzt (API-Token-Auth), das admin-eigene Gate
      // (`requireAdminToken`) prüft aber unabhängig davon erneut gegen das
      // konfigurierte F451_ADMIN_TOKEN und lehnt ab.
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
    })

    it('das Admin-Token wird NIE als API-Token behandelt (kein f451_pat_-Präfix → /api/me bleibt 401 ohne Session)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('(f) POST/GET/DELETE /api/tokens Grundfunktion', () => {
    it('POST erzeugt ein Token: Klartext nur in dieser Antwort, DB speichert nur den Hash', async () => {
      const { cookie } = await createSessionCookie('pat-f1')

      const res = await app.inject({
        method: 'POST',
        url: '/api/tokens',
        cookies: { [SESSION_COOKIE_NAME]: cookie },
        payload: { label: 'Mein MCP-Token', scope: 'write', expiresInDays: 30 },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        id: string
        label: string
        scope: string
        expiresAt: string | null
        token: string
      }
      expect(body.token.startsWith('f451_pat_')).toBe(true)
      expect(body.label).toBe('Mein MCP-Token')
      expect(body.scope).toBe('write')
      expect(body.expiresAt).not.toBeNull()

      const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, body.id))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.tokenHash).toBe(hashApiToken(body.token))
      expect(rows[0]!.tokenHash).not.toBe(body.token)
      // Response darf den Hash nirgends tragen.
      expect(JSON.stringify(body)).not.toContain(rows[0]!.tokenHash)
    })

    it('GET listet eigene Tokens ohne Hash/Klartext', async () => {
      const { cookie } = await createSessionCookie('pat-f2')
      await mintToken(cookie, 'read', 'Token Eins')

      const res = await app.inject({
        method: 'GET',
        url: '/api/tokens',
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      })

      expect(res.statusCode).toBe(200)
      const list = res.json() as Array<Record<string, unknown>>
      expect(list.length).toBeGreaterThanOrEqual(1)
      const entry = list.find((t) => t.label === 'Token Eins')!
      expect(entry).toMatchObject({ label: 'Token Eins', scope: 'read', revoked: false })
      expect(entry.token).toBeUndefined()
      expect(entry.tokenHash).toBeUndefined()
    })

    it('GET zeigt nur EIGENE Tokens, keine fremden', async () => {
      const alice = await createSessionCookie('pat-f3-alice')
      const bob = await createSessionCookie('pat-f3-bob')
      await mintToken(alice.cookie, 'read', 'Alice-Token')
      await mintToken(bob.cookie, 'read', 'Bob-Token')

      const res = await app.inject({
        method: 'GET',
        url: '/api/tokens',
        cookies: { [SESSION_COOKIE_NAME]: alice.cookie },
      })
      const labels = (res.json() as Array<{ label: string }>).map((t) => t.label)
      expect(labels).toContain('Alice-Token')
      expect(labels).not.toContain('Bob-Token')
    })

    it('DELETE widerruft nur eigene Tokens (fremde Id → 404)', async () => {
      const alice = await createSessionCookie('pat-f4-alice')
      const bob = await createSessionCookie('pat-f4-bob')
      const bobToken = await mintToken(bob.cookie, 'read', 'Bobs-geheimes-Token')

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${bobToken.id}`,
        cookies: { [SESSION_COOKIE_NAME]: alice.cookie },
      })
      expect(res.statusCode).toBe(404)

      // Bobs Token ist danach weiterhin gültig (nicht versehentlich widerrufen).
      const stillListed = await app.inject({
        method: 'GET',
        url: '/api/tokens',
        cookies: { [SESSION_COOKIE_NAME]: bob.cookie },
      })
      const entry = (stillListed.json() as Array<{ id: string; revoked: boolean }>).find(
        (t) => t.id === bobToken.id,
      )
      expect(entry?.revoked).toBe(false)
    })

    it('DELETE der eigenen Token-Id → 200, danach in der Liste als revoked markiert', async () => {
      const { cookie } = await createSessionCookie('pat-f5')
      const { id } = await mintToken(cookie, 'write', 'Wird widerrufen')

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${id}`,
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      })
      expect(del.statusCode).toBe(200)
      expect(del.json()).toEqual({ ok: true })

      const list = await app.inject({
        method: 'GET',
        url: '/api/tokens',
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      })
      const entry = (list.json() as Array<{ id: string; revoked: boolean }>).find((t) => t.id === id)
      expect(entry?.revoked).toBe(true)
    })

    it('kein Token-Bootstrapping: /api/tokens per API-Token (statt Session) → 403, auch mit write-scope', async () => {
      const { cookie } = await createSessionCookie('pat-f6')
      const { token } = await mintToken(cookie, 'write')

      const list = await app.inject({
        method: 'GET',
        url: '/api/tokens',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(list.statusCode).toBe(403)

      const create = await app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 'Bootstrap-Versuch', scope: 'write' },
      })
      expect(create.statusCode).toBe(403)
    })

    it('POST ohne Session (kein Cookie, kein Token) → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tokens',
        payload: { label: 'x', scope: 'read' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('POST mit leerem label → 400', async () => {
      const { cookie } = await createSessionCookie('pat-f7')
      const res = await app.inject({
        method: 'POST',
        url: '/api/tokens',
        cookies: { [SESSION_COOKIE_NAME]: cookie },
        payload: { label: '   ', scope: 'read' },
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
