import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { createSession, SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 5).toString('base64')

/**
 * Security F-02: the router decodes the path before matching, so `/%61pi/pages/x/draft`
 * reached `/api/pages/:id/draft` while the global gate (raw `req.url`) saw no `/api/`
 * prefix — session requirement, read-only scope gate and token rate limit all fell away.
 * The gate now decides on the matched route pattern, and an encoded first segment is
 * rejected with 400 before anything else runs.
 */
describe.sequential('Global gate: percent-encoded path prefix (F-02)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance
  let userCounter = 0
  let providerCalls = 0
  let probeWrites = 0

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      // Registers the real read/write routes (`/api/spaces`, `/api/pages/:id/draft`, ...).
      // A call to the registry would mean a handler ran — counted and asserted on below.
      spaces: [],
      providerRegistry: (): GitProvider => {
        providerCalls += 1
        throw new Error('providerRegistry must not be reached in this test')
      },
    })
    // Probe routes isolate the gate from the business logic (pattern from api-tokens.test.ts).
    app.get('/api/probe/:id', async () => ({ ok: true }))
    app.put('/api/probe/:id', async () => {
      probeWrites += 1
      return { ok: true }
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  async function sessionCookie(): Promise<string> {
    userCounter += 1
    const userId = `gate-enc-${userCounter}`
    await db.insert(users).values({ id: userId, email: `${userId}@example.org`, displayName: `Gate ${userCounter}` })
    return (await createSession(db, userId)).id
  }

  async function readOnlyToken(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies: { [SESSION_COOKIE_NAME]: await sessionCookie() },
      payload: { label: 'gate-test', scope: 'read' },
    })
    expect(res.statusCode).toBe(200)
    return (res.json() as { token: string }).token
  }

  describe('encoded first segment', () => {
    it('(a) PUT /%61pi/pages/x/draft with a read-only token → 400, no handler runs', async () => {
      const token = await readOnlyToken()
      const res = await app.inject({
        method: 'PUT',
        url: '/%61pi/pages/x/draft',
        headers: { authorization: `Bearer ${token}` },
        payload: { baseSha: 'abc', content: 'x' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ status: 'bad_request', reason: expect.any(String) })
      expect(providerCalls).toBe(0)
    })

    it('(a) PUT /%61pi/probe/x with a read-only token → 400, the probe handler is not reached', async () => {
      const token = await readOnlyToken()
      const res = await app.inject({
        method: 'PUT',
        url: '/%61pi/probe/x',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(probeWrites).toBe(0)
    })

    it('(b) GET /%61pi/spaces without a session → 400, no data', async () => {
      const res = await app.inject({ method: 'GET', url: '/%61pi/spaces' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ status: 'bad_request', reason: expect.any(String) })
      expect(providerCalls).toBe(0)
    })

    it('other encoded prefixes (/media, /admin, double-encoded) → 400', async () => {
      expect((await app.inject({ method: 'GET', url: '/%2561pi/spaces' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/%6D%65dia/x/y' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: '/%61dmin/reindex' })).statusCode).toBe(400)
    })
  })

  describe('(c) normal paths behave as before', () => {
    it('GET /api/probe/x with a read-only token → 200', async () => {
      const token = await readOnlyToken()
      const res = await app.inject({
        method: 'GET',
        url: '/api/probe/x',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })

    it('PUT /api/probe/x with a read-only token → 403 read-only', async () => {
      const token = await readOnlyToken()
      const res = await app.inject({
        method: 'PUT',
        url: '/api/probe/x',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ status: 'forbidden', reason: expect.any(String) })
      expect(probeWrites).toBe(0)
    })

    it('PUT /api/pages/x/draft with a read-only token → 403, no handler runs', async () => {
      const token = await readOnlyToken()
      const res = await app.inject({
        method: 'PUT',
        url: '/api/pages/x/draft',
        headers: { authorization: `Bearer ${token}` },
        payload: { baseSha: 'abc', content: 'x' },
      })
      expect(res.statusCode).toBe(403)
      expect(providerCalls).toBe(0)
    })

    it('an encoded later segment is still routed normally (GET /api/probe/a%20b → 200)', async () => {
      const token = await readOnlyToken()
      const res = await app.inject({
        method: 'GET',
        url: '/api/probe/a%20b',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('unknown /api route without a session → still 401 (raw-path fallback for 404s)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('session')
    })

    it('GET /api/spaces without a session → still 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces' })
      expect(res.statusCode).toBe(401)
    })
  })
})
