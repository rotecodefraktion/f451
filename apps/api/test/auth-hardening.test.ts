import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { RepoRef } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { createSession, deleteExpiredSessions, getSession, SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { sessions, users } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { startMockIdp, type MockIdp } from './helpers/mock-idp.js'

const TOKEN_KEY = Buffer.alloc(32, 13).toString('base64')

describe.sequential('Auth-Härtung (M1–M4) + CSRF-Origin-Check (Task 3, Spec §7)', () => {
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

  async function insertUserWithSession(): Promise<string> {
    userCounter += 1
    const userId = `hardening-user-${userCounter}`
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.org`,
      displayName: `Hardening User ${userCounter}`,
    })
    const session = await createSession(db, userId)
    return session.id
  }

  describe('M1: Connect-redirect_uri nutzt publicBaseUrl statt Host-Header, wenn konfiguriert', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = buildApp({
        databaseUrl: pg.connectionString,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          connect: {
            github: { clientId: 'test-github-client', clientSecret: 'test-github-secret' },
          },
        },
        publicBaseUrl: 'https://wiki.example.de/',
      })
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    it('baut redirect_uri aus publicBaseUrl, NICHT aus dem (abweichenden) Host-Header', async () => {
      const sessionId = await insertUserWithSession()
      const res = await app.inject({
        method: 'GET',
        url: '/auth/connect/github',
        headers: { host: 'boese.example' },
        cookies: { [SESSION_COOKIE_NAME]: sessionId },
      })

      expect(res.statusCode).toBe(302)
      const location = new URL(res.headers.location as string)
      expect(location.searchParams.get('redirect_uri')).toBe(
        'https://wiki.example.de/auth/connect/github/callback',
      )
    })
  })

  describe('M1: ohne publicBaseUrl bleibt der Host-Header-Fallback (Dev-Bestandsverhalten)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = buildApp({
        databaseUrl: pg.connectionString,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          connect: {
            github: { clientId: 'test-github-client', clientSecret: 'test-github-secret' },
          },
        },
      })
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    it('baut redirect_uri aus dem Host-Header, wenn publicBaseUrl nicht gesetzt ist', async () => {
      const sessionId = await insertUserWithSession()
      const res = await app.inject({
        method: 'GET',
        url: '/auth/connect/github',
        headers: { host: 'dev.example' },
        cookies: { [SESSION_COOKIE_NAME]: sessionId },
      })

      expect(res.statusCode).toBe(302)
      const location = new URL(res.headers.location as string)
      expect(location.searchParams.get('redirect_uri')).toBe('http://dev.example/auth/connect/github/callback')
    })
  })

  describe('M2: F451_OIDC_ALLOW_INSECURE steuert Discovery unabhängig von insecureCookies', () => {
    let idp: MockIdp

    beforeAll(async () => {
      idp = await startMockIdp({ sub: 'sub-m2', email: 'm2@example.org', name: 'M2 Test' })
    })

    afterAll(async () => {
      await idp.stop()
    })

    it('oidcAllowInsecure=true erlaubt http-Discovery, obwohl insecureCookies=false ist', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: false,
          oidcAllowInsecure: true,
          oidc: {
            issuer: idp.issuer,
            clientId: 'm2-client',
            clientSecret: 'm2-secret',
            redirectUrl: 'http://localhost:9999/auth/callback',
          },
        },
      })
      await expect(app.ready()).resolves.not.toThrow()
      await app.close()
    })

    it('oidcAllowInsecure=false (explizit) lässt die Discovery scheitern, obwohl insecureCookies=true ist', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          oidcAllowInsecure: false,
          oidc: {
            issuer: idp.issuer,
            clientId: 'm2-client',
            clientSecret: 'm2-secret',
            redirectUrl: 'http://localhost:9999/auth/callback',
          },
        },
      })
      await expect(app.ready()).rejects.toThrow()
      await app.close()
    })
  })

  describe('M3: deleteExpiredSessions', () => {
    async function insertPlainUser(): Promise<string> {
      userCounter += 1
      const userId = `sweep-user-${userCounter}`
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.org`,
        displayName: `Sweep User ${userCounter}`,
      })
      return userId
    }

    it('löscht nur abgelaufene Sessions und liefert die Anzahl', async () => {
      const userId = await insertPlainUser()
      const expired = await createSession(db, userId)
      const valid = await createSession(db, userId)

      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(sessions.id, expired.id))

      const deletedCount = await deleteExpiredSessions(db)
      expect(deletedCount).toBeGreaterThanOrEqual(1)

      const remainingExpired = await db.select().from(sessions).where(eq(sessions.id, expired.id))
      expect(remainingExpired).toHaveLength(0)

      const remainingValid = await db.select().from(sessions).where(eq(sessions.id, valid.id))
      expect(remainingValid).toHaveLength(1)
    })

    it('liefert 0, wenn keine Session abgelaufen ist', async () => {
      // Alle noch übrigen abgelaufenen Sessions aus vorherigen Tests zuerst wegräumen.
      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
      const userId = await insertPlainUser()
      await createSession(db, userId)

      expect(await deleteExpiredSessions(db)).toBe(0)
    })
  })

  describe('M4: Sliding-Refresh-Drossel-Verifikation (Ist-Verhalten)', () => {
    it('zwei schnelle Folge-Requests in der Refresh-Phase erzeugen genau EIN UPDATE (Refresh springt auf 100% Rest-TTL)', async () => {
      userCounter += 1
      const userId = `m4-user-${userCounter}`
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.org`,
        displayName: `M4 User ${userCounter}`,
      })
      const { id } = await createSession(db, userId)

      // < 50% Rest-TTL simulieren (löst den Refresh beim ersten Zugriff aus).
      const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
      await db.update(sessions).set({ expiresAt: nearExpiry }).where(eq(sessions.id, id))

      await getSession(db, id) // 1. Zugriff: löst den Refresh aus (>50%-Bedingung erfüllt)
      const [afterFirst] = await db.select().from(sessions).where(eq(sessions.id, id))
      expect(afterFirst!.expiresAt.getTime()).toBeGreaterThan(nearExpiry.getTime())

      await getSession(db, id) // 2. Zugriff, sofort danach: Session ist jetzt wieder bei ~100% Rest-TTL
      const [afterSecond] = await db.select().from(sessions).where(eq(sessions.id, id))

      // Kein weiteres UPDATE — expiresAt ist nach dem 2. Zugriff identisch zum 1.
      expect(afterSecond!.expiresAt.getTime()).toBe(afterFirst!.expiresAt.getTime())
    })
  })

  describe('CSRF-Origin-Check', () => {
    let app: FastifyInstance
    const fakeSpace: SpaceConfig = {
      id: 'csrf-space',
      name: 'CSRF Space',
      provider: 'forgejo',
      owner: 'dev-docs',
      repo: 'csrf-space',
      defaultLang: 'de',
      repoRef: { provider: 'forgejo', owner: 'dev-docs', repo: 'csrf-space' } satisfies RepoRef,
    }

    beforeAll(async () => {
      app = buildApp({
        databaseUrl: pg.connectionString,
        auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
        publicBaseUrl: 'https://wiki.example.de',
        spaces: [fakeSpace],
        // Wird für diese Tests nie aufgerufen (Webhook-Requests scheitern vorher
        // an der fehlenden/ungültigen HMAC-Signatur) — reicht, damit
        // registerWebhookRoutes überhaupt aktiv ist.
        providerRegistry: () => {
          throw new Error('providerRegistry sollte in diesen Tests nicht aufgerufen werden')
        },
        webhookSecrets: { forgejo: 'unrelated-secret' },
      })
      // Eigene Test-Route (Muster `test/auth-sessions.test.ts#requireSession-
      // preHandler`) statt einer echten Auth-Route: `/auth/logout` ist nur
      // registriert, wenn OIDC konfiguriert ist — der Origin-Check-Hook selbst
      // ist aber unabhängig von jeder konkreten Route, daher genügt eine
      // simple, immer registrierte POST-Route als Sonde.
      app.post('/test/csrf-probe', async () => ({ ok: true }))
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    it('POST mit fremder Origin → 403 forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/csrf-probe',
        headers: { origin: 'https://boese.example' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ status: 'forbidden', reason: expect.any(String) })
    })

    it('POST mit eigener Origin (== publicBaseUrl) → durch (kein 403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/csrf-probe',
        headers: { origin: 'https://wiki.example.de' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('POST ohne Origin-Header → durch (native Clients/curl)', async () => {
      const res = await app.inject({ method: 'POST', url: '/test/csrf-probe' })
      expect(res.statusCode).toBe(200)
    })

    it('POST /webhooks/forgejo mit fremder Origin → durch (Server-zu-Server, HMAC-gesichert)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/forgejo',
        headers: { origin: 'https://boese.example', 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      })
      // Kein 403 durch den Origin-Check — die Route selbst lehnt mangels
      // gültiger HMAC-Signatur mit 401 ab, das beweist bereits, dass der
      // Request den CSRF-Hook passiert hat.
      expect(res.statusCode).not.toBe(403)
      expect(res.statusCode).toBe(401)
    })

    it('POST mit kaputtem (nicht parsbarem) Origin-Header → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/csrf-probe',
        headers: { origin: 'nicht-eine-url' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('GET bleibt vom Origin-Check unberührt, auch mit fremder Origin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://boese.example' },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('CSRF-Origin-Check: Host-Header-Fallback hinter Proxy (ohne publicBaseUrl, trustProxy: 1)', () => {
    // Fix-Runde 1 (Review 4a-3, Finding 3): genau dieser Pfad ist in
    // Referenz-Konfigurationen OHNE F451_PUBLIC_BASE_URL aktiv — der Check
    // vergleicht dann gegen `${req.protocol}://${req.headers.host}`. Hinter
    // dem Reverse Proxy (F451_TRUST_PROXY=1, Spec §8) MUSS `req.protocol`
    // dabei X-Forwarded-Proto respektieren (Fastify tut das bei gesetztem
    // trustProxy): der Browser spricht https mit dem Proxy, der Proxy http
    // mit der API — ohne die Header-Auswertung wäre die eigene Origin
    // fälschlich `http://<host>` und JEDER legitime https-Request bekäme 403.
    let app: FastifyInstance

    beforeAll(async () => {
      app = buildApp({
        databaseUrl: pg.connectionString,
        auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
        trustProxy: 1,
      })
      app.post('/test/csrf-probe', async () => ({ ok: true }))
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    it('X-Forwarded-Proto: https + passende https-Origin → durchgelassen (req.protocol respektiert den Proxy-Header)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/csrf-probe',
        headers: {
          host: 'wiki.example.de',
          'x-forwarded-proto': 'https',
          origin: 'https://wiki.example.de',
        },
      })
      expect(res.statusCode).toBe(200)
    })

    it('X-Forwarded-Proto: https + http-Origin (Schema-Differenz) → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/csrf-probe',
        headers: {
          host: 'wiki.example.de',
          'x-forwarded-proto': 'https',
          origin: 'http://wiki.example.de',
        },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ status: 'forbidden', reason: expect.any(String) })
    })
  })
})
