import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSession,
  requireSession,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { sessions, users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

describe.sequential('Sessions + requireSession', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let userCounter = 0

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
  }, 120_000)

  afterAll(async () => {
    await handle.close()
    await pg.stop()
  })

  async function insertUser(): Promise<string> {
    userCounter += 1
    const id = `user-${userCounter}`
    await db.insert(users).values({
      id,
      email: `${id}@example.org`,
      displayName: `User ${userCounter}`,
    })
    return id
  }

  describe('Session-Lifecycle', () => {
    it('legt eine Session mit ~7 Tagen TTL an und lädt sie wieder', async () => {
      const userId = await insertUser()
      const before = Date.now()
      const record = await createSession(db, userId)

      expect(record.id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(record.expiresAt.getTime()).toBeGreaterThan(before + SEVEN_DAYS_MS - 5_000)
      expect(record.expiresAt.getTime()).toBeLessThan(before + SEVEN_DAYS_MS + 5_000)

      const loaded = await getSession(db, record.id)
      expect(loaded).toEqual({ userId })
    })

    it('liefert null für eine unbekannte Session-Id', async () => {
      expect(await getSession(db, 'nicht-existent')).toBeNull()
    })

    it('destroySession löscht die Session; anschließendes getSession liefert null', async () => {
      const userId = await insertUser()
      const { id } = await createSession(db, userId)

      await destroySession(db, id)

      expect(await getSession(db, id)).toBeNull()
    })

    it('destroySession auf eine bereits gelöschte/unbekannte Id wirft nicht', async () => {
      await expect(destroySession(db, 'nie-existiert')).resolves.not.toThrow()
    })
  })

  describe('Ablauf', () => {
    it('löscht eine abgelaufene Session beim Zugriff und liefert null', async () => {
      const userId = await insertUser()
      const { id } = await createSession(db, userId)

      // Ablauf simulieren: expiresAt direkt in die Vergangenheit setzen (kein sleep).
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(sessions.id, id))

      expect(await getSession(db, id)).toBeNull()

      const remaining = await db.select().from(sessions).where(eq(sessions.id, id))
      expect(remaining).toHaveLength(0)
    })
  })

  describe('Sliding-Refresh', () => {
    it('verlängert expiresAt, wenn weniger als 50% der TTL übrig sind', async () => {
      const userId = await insertUser()
      const { id } = await createSession(db, userId)

      // < 50% Rest-TTL simulieren: nur noch 2 von 7 Tagen übrig (~28%).
      const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
      await db.update(sessions).set({ expiresAt: nearExpiry }).where(eq(sessions.id, id))

      const before = Date.now()
      const result = await getSession(db, id)
      expect(result).toEqual({ userId })

      const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
      expect(row!.expiresAt.getTime()).toBeGreaterThan(before + SEVEN_DAYS_MS - 5_000)
      expect(row!.expiresAt.getTime()).toBeGreaterThan(nearExpiry.getTime())
    })

    it('lässt expiresAt unverändert, wenn mehr als 50% der TTL übrig sind', async () => {
      const userId = await insertUser()
      const { id } = await createSession(db, userId)

      // >= 50% Rest-TTL simulieren: noch 5 von 7 Tagen übrig (~71%).
      const farFromExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
      await db.update(sessions).set({ expiresAt: farFromExpiry }).where(eq(sessions.id, id))

      const result = await getSession(db, id)
      expect(result).toEqual({ userId })

      const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
      expect(row!.expiresAt.getTime()).toBe(farFromExpiry.getTime())
    })
  })

  describe('Cookie-Attribute (setSessionCookie/clearSessionCookie)', () => {
    let secureApp: FastifyInstance
    let insecureApp: FastifyInstance

    beforeAll(() => {
      secureApp = buildApp({
        databaseUrl: pg.connectionString,
        auth: { tokenKey: TOKEN_KEY },
      })
      secureApp.get('/test/set-cookie', async (_req, reply) => {
        setSessionCookie(reply, 'test-session-id')
        return { ok: true }
      })
      secureApp.get('/test/clear-cookie', async (_req, reply) => {
        clearSessionCookie(reply)
        return { ok: true }
      })

      insecureApp = buildApp({
        databaseUrl: pg.connectionString,
        auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      })
      insecureApp.get('/test/set-cookie', async (_req, reply) => {
        setSessionCookie(reply, 'test-session-id', { insecureCookies: true })
        return { ok: true }
      })
    })

    afterAll(async () => {
      await secureApp.close()
      await insecureApp.close()
    })

    it('setzt httpOnly, sameSite=Lax, secure, path=/ im Standardmodus', async () => {
      const res = await secureApp.inject({ method: 'GET', url: '/test/set-cookie' })
      expect(res.statusCode).toBe(200)

      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)
      expect(cookie).toBeDefined()
      expect(cookie!.value).toBe('test-session-id')
      expect(cookie!.httpOnly).toBe(true)
      expect(String(cookie!.sameSite).toLowerCase()).toBe('lax')
      expect(cookie!.secure).toBe(true)
      expect(cookie!.path).toBe('/')
    })

    it('setzt maxAge passend zur Session-TTL (7 Tage) — persistentes Login', async () => {
      const res = await secureApp.inject({ method: 'GET', url: '/test/set-cookie' })
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)
      expect(cookie).toBeDefined()
      expect(cookie!.maxAge).toBe(SEVEN_DAYS_MS / 1000)
    })

    it('setzt secure=false, wenn insecureCookies aktiv ist (Dev-Modus)', async () => {
      const res = await insecureApp.inject({ method: 'GET', url: '/test/set-cookie' })
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)
      expect(cookie).toBeDefined()
      expect(cookie!.secure).toBeFalsy()
    })

    it('clearSessionCookie löscht das Cookie (leerer Wert, Ablauf in der Vergangenheit)', async () => {
      const res = await secureApp.inject({ method: 'GET', url: '/test/clear-cookie' })
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)
      expect(cookie).toBeDefined()
      expect(cookie!.value).toBe('')
      if (cookie!.expires) {
        expect(new Date(cookie!.expires as unknown as string).getTime()).toBeLessThan(Date.now())
      } else {
        expect(cookie!.maxAge).toBeLessThanOrEqual(0)
      }
    })
  })

  describe('requireSession-preHandler', () => {
    let app: FastifyInstance

    beforeAll(() => {
      app = buildApp({
        databaseUrl: pg.connectionString,
        auth: { tokenKey: TOKEN_KEY },
      })
      app.get('/test/protected', { preHandler: requireSession }, async (req) => ({
        userId: req.user!.id,
      }))
    })

    afterAll(async () => {
      await app.close()
    })

    it('antwortet 401 mit WWW-Authenticate: session ohne Cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/test/protected' })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('session')
      expect(res.json()).toEqual({ status: 'unauthorized', reason: expect.any(String) })
    })

    it('antwortet 401 bei unbekanntem/ungültigem Session-Cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        cookies: { [SESSION_COOKIE_NAME]: 'garbage-session-id' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('antwortet 401 bei einer abgelaufenen Session', async () => {
      const userId = await insertUser()
      const { id } = await createSession(db, userId)
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(sessions.id, id))

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        cookies: { [SESSION_COOKIE_NAME]: id },
      })
      expect(res.statusCode).toBe(401)
    })

    it('lässt die Anfrage mit einer gültigen Session durch und lädt req.user', async () => {
      const userId = await insertUser()
      const { id } = await createSession(db, userId)

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        cookies: { [SESSION_COOKIE_NAME]: id },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ userId })
    })
  })

  describe('Rückwärtskompatibilität: ohne opts.auth', () => {
    it('registriert keinen Cookie-Hook und setzt niemals ein Session-Cookie', async () => {
      const app = buildApp({ databaseUrl: pg.connectionString })
      try {
        const res = await app.inject({ method: 'GET', url: '/healthz' })
        expect(res.statusCode).toBe(200)
        expect(res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)).toBeUndefined()
        expect(res.headers['set-cookie']).toBeUndefined()
      } finally {
        await app.close()
      }
    })

    it('buildApp() ganz ohne Optionen funktioniert weiterhin (kein DB, kein Auth)', async () => {
      const app = buildApp()
      try {
        const res = await app.inject({ method: 'GET', url: '/healthz' })
        expect(res.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    })

    it('wirft, wenn opts.auth ohne databaseUrl konfiguriert wird (Fail-Fast)', () => {
      expect(() => buildApp({ auth: { tokenKey: TOKEN_KEY } })).toThrow(/databaseUrl/)
    })
  })
})
