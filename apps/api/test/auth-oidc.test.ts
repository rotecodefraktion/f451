import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { decryptToken, encryptToken } from '../src/auth/crypto.js'
import { providerAccounts, users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { startMockIdp, type MockIdp } from './helpers/mock-idp.js'

const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')
const TX_COOKIE_NAME = 'f451_oidc_tx'
const REDIRECT_URL = 'http://localhost:9999/auth/callback'

interface LoginResult {
  status: number
  location: string
  sessionCookie?: string
}

describe.sequential('OIDC-Login (Entra) mit Mock-IdP', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let idp: MockIdp
  let app: FastifyInstance

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    idp = await startMockIdp({ sub: 'sub-alice', email: 'alice@example.org', name: 'Alice Example' })

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        // Task 3 (Auth-Härtung M2, Spec §7): seit der Entkopplung von
        // `insecureCookies` steuert ausschließlich dieses Feld, ob die
        // OIDC-Discovery http-Issuer erlaubt (hier: der Mock-IdP).
        oidcAllowInsecure: true,
        oidc: {
          issuer: idp.issuer,
          clientId: 'test-client',
          clientSecret: 'test-secret',
          redirectUrl: REDIRECT_URL,
        },
        // Dieselbe Client-ID wie die Anmeldung → geteilter Forgejo-Grant (Issue #70).
        connect: {
          // The mock IdP also plays Forgejo's API (`/api/v1/user`, #8).
          forgejo: { baseUrl: idp.issuer, clientId: 'test-client', clientSecret: 'test-secret' },
        },
      },
      // Task 2 (Rate-Limits, Spec §7): dieser Testfile ruft `/auth/login`
      // über eine EINZIGE, geteilte App-Instanz und dieselbe Test-Client-IP
      // deutlich öfter als der Produktions-Default (10/min) auf (>10 Logins
      // über alle `it`-Blöcke hinweg) — ein reines Testartefakt (viele
      // Szenarien in einem Lauf), keine reale Traffic-Erwartung. Grosszügiger
      // Override statt knappem Default, damit dieser Bestandstest nicht
      // versehentlich ins Limit läuft (Auflage aus Task 2: „Bestandstests
      // dürfen nicht ins Limit laufen"). Das knappe Limit selbst wird
      // ausschließlich in `rate-limit.test.ts` geprüft.
      rateLimits: { auth: { max: 1000, windowMs: 60_000 }, search: { max: 1000, windowMs: 60_000 } },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app.close()
    await idp.stop()
    await handle.close()
    await pg.stop()
  })

  afterEach(() => {
    // Manipulationen und Nutzer nach jedem Negativtest zurücksetzen.
    idp.tamper = {}
    idp.user = { sub: 'sub-alice', email: 'alice@example.org', name: 'Alice Example' }
  })

  /** Startet /auth/login, folgt dem IdP-Redirect (echter fetch) und injiziert /auth/callback. */
  async function performLogin(options: { next?: string; tamperState?: boolean } = {}): Promise<LoginResult> {
    const loginUrl = options.next ? `/auth/login?next=${encodeURIComponent(options.next)}` : '/auth/login'
    const loginRes = await app.inject({ method: 'GET', url: loginUrl })
    expect(loginRes.statusCode).toBe(302)

    const txCookie = loginRes.cookies.find((c) => c.name === TX_COOKIE_NAME)
    expect(txCookie, 'tx-cookie muss gesetzt sein').toBeDefined()

    // 2. IdP-Authorize real ansteuern (Mock-Server lauscht), Redirect manuell fangen.
    const authorizeUrl = loginRes.headers.location as string
    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' })
    expect(authorizeRes.status).toBe(302)
    const callbackUrl = new URL(authorizeRes.headers.get('location') as string)

    if (options.tamperState) {
      callbackUrl.searchParams.set('state', 'voellig-falscher-state')
    }

    // 3. Callback in dieselbe App injizieren, tx-Cookie mitschicken.
    const cbRes = await app.inject({
      method: 'GET',
      url: callbackUrl.pathname + callbackUrl.search,
      cookies: { [TX_COOKIE_NAME]: txCookie!.value },
    })

    const sessionCookie = cbRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value
    return {
      status: cbRes.statusCode,
      location: (cbRes.headers.location as string) ?? '',
      sessionCookie: sessionCookie && sessionCookie.length > 0 ? sessionCookie : undefined,
    }
  }

  describe('Roundtrip', () => {
    it('vollständiger Login legt User an, setzt Session-Cookie und leitet auf / weiter', async () => {
      const result = await performLogin()

      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
      expect(result.sessionCookie).toBeDefined()

      const rows = await db.select().from(users).where(eq(users.id, 'sub-alice'))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.email).toBe('alice@example.org')
      expect(rows[0]!.displayName).toBe('Alice Example')
    })

    it('/api/me liefert mit gültiger Session das Profil samt (leerer) Verknüpfungen', async () => {
      const { sessionCookie } = await performLogin()
      expect(sessionCookie).toBeDefined()

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE_NAME]: sessionCookie! },
      })
      expect(meRes.statusCode).toBe(200)
      expect(meRes.json()).toEqual({
        id: 'sub-alice',
        email: 'alice@example.org',
        displayName: 'Alice Example',
        connections: { forgejo: false, github: false },
        expiredConnections: { forgejo: false, github: false },
      })
    })

    it('Logout zerstört die Session; /api/me antwortet danach mit 401', async () => {
      const { sessionCookie } = await performLogin()
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { [SESSION_COOKIE_NAME]: sessionCookie! },
      })
      expect(logoutRes.statusCode).toBe(204)

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE_NAME]: sessionCookie! },
      })
      expect(meRes.statusCode).toBe(401)
    })
  })

  describe('GET /auth/methods (#8)', () => {
    it('lists the OIDC sign-in with a neutral label when no provider name is set', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/methods' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ methods: [{ id: 'oidc', href: '/auth/login', label: null }], note: null })
    })
  })

  describe('/api/me ohne Session', () => {
    it('antwortet 401 ohne Cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/me' })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('session')
    })
  })

  describe('Negativfälle', () => {
    it('state-Mismatch → Startseite mit Meldung, ohne Session', async () => {
      const result = await performLogin({ tamperState: true })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/?anmeldung=fehlgeschlagen')
      expect(result.sessionCookie).toBeUndefined()
    })

    it('nonce-Manipulation im ID-Token → Startseite mit Meldung, ohne Session', async () => {
      idp.tamper = { nonce: true }
      const result = await performLogin()
      expect(result.status).toBe(302)
      expect(result.location).toBe('/?anmeldung=fehlgeschlagen')
      expect(result.sessionCookie).toBeUndefined()
    })

    it('falscher Issuer im ID-Token → Startseite mit Meldung, ohne Session', async () => {
      idp.tamper = { issuer: true }
      const result = await performLogin()
      expect(result.status).toBe(302)
      expect(result.location).toBe('/?anmeldung=fehlgeschlagen')
      expect(result.sessionCookie).toBeUndefined()
    })

    it('Callback ohne tx-Cookie (z. B. Anmeldung auf anderem Host begonnen) → Startseite mit Meldung', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback?code=irgendwas&state=irgendwas',
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('/?anmeldung=abgelaufen')
    })

    it('Fehlermeldungen enthalten keinen Code-/Token-Wert', async () => {
      idp.tamper = { nonce: true }
      const loginRes = await app.inject({ method: 'GET', url: '/auth/login' })
      const txCookie = loginRes.cookies.find((c) => c.name === TX_COOKIE_NAME)!
      const authorizeRes = await fetch(loginRes.headers.location as string, { redirect: 'manual' })
      const callbackUrl = new URL(authorizeRes.headers.get('location') as string)
      const code = callbackUrl.searchParams.get('code')!

      const cbRes = await app.inject({
        method: 'GET',
        url: callbackUrl.pathname + callbackUrl.search,
        cookies: { [TX_COOKIE_NAME]: txCookie.value },
      })
      expect(cbRes.statusCode).toBe(302)
      expect(cbRes.body).not.toContain(code)
      expect(String(cbRes.headers.location)).not.toContain(code)
    })
  })

  describe('next-Whitelist', () => {
    it('relativer Pfad wird nach Login übernommen', async () => {
      const result = await performLogin({ next: '/wiki/space/seite' })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/wiki/space/seite')
    })

    it('absolute externe URL wird ignoriert (→ /)', async () => {
      const result = await performLogin({ next: 'https://evil.example.com/phish' })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
    })

    it('protokoll-relative //host-URL wird ignoriert (→ /)', async () => {
      const result = await performLogin({ next: '//evil.example.com' })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
    })

    it('Tab-Bypass `/\\t/host` wird ignoriert (Browser strippt Tab → //host)', async () => {
      const result = await performLogin({ next: '/\t/evil.example.com' })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
    })

    it('Newline-Bypass `/\\n//host` wird ignoriert', async () => {
      const result = await performLogin({ next: '/\n//evil.example.com' })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
    })

    it('CR-Bypass `/\\r/host` wird ignoriert', async () => {
      const result = await performLogin({ next: '/\r/evil.example.com' })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
    })
  })

  describe('Doppel-Login', () => {
    it('upsertet denselben User (sub) statt ein Duplikat anzulegen und aktualisiert Profildaten', async () => {
      idp.user = { sub: 'sub-bob', email: 'bob@example.org', name: 'Bob Erst' }
      await performLogin()

      // Zweiter Login mit demselben sub, aber geänderten Profildaten.
      idp.user = { sub: 'sub-bob', email: 'bob-neu@example.org', name: 'Bob Zweit' }
      await performLogin()

      const rows = await db.select().from(users).where(eq(users.id, 'sub-bob'))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.email).toBe('bob-neu@example.org')
      expect(rows[0]!.displayName).toBe('Bob Zweit')
    })
  })

  describe('Geteilter Forgejo-Grant (Issue #70)', () => {
    it('übernimmt die Anmelde-Tokens in eine bestehende Forgejo-Verknüpfung', async () => {
      idp.user = { sub: 'sub-carol', email: 'carol@example.org', name: 'Carol' }
      await performLogin()
      await db.insert(providerAccounts).values({
        userId: 'sub-carol',
        provider: 'forgejo',
        providerLogin: 'carol',
        encryptedAccessToken: encryptToken('alt-access', TOKEN_KEY),
        encryptedRefreshToken: encryptToken('alt-refresh', TOKEN_KEY),
      })

      await performLogin()

      const [row] = await db.select().from(providerAccounts).where(eq(providerAccounts.userId, 'sub-carol'))
      expect(decryptToken(row!.encryptedAccessToken, TOKEN_KEY)).toMatch(/^mock-access-/)
      // Der Mock-IdP stellt keinen Refresh-Token aus — der gespeicherte bleibt stehen.
      expect(decryptToken(row!.encryptedRefreshToken!, TOKEN_KEY)).toBe('alt-refresh')
      expect(row!.providerLogin).toBe('carol')
    })

    it('links the Forgejo account on first sign-in (#8)', async () => {
      idp.user = { sub: 'sub-erin', email: 'erin@example.org', name: 'Erin', forgejoLogin: 'erin' }
      const result = await performLogin()

      expect(result.status).toBe(302)
      const [row] = await db.select().from(providerAccounts).where(eq(providerAccounts.userId, 'sub-erin'))
      expect(row!.providerLogin).toBe('erin')
      expect(decryptToken(row!.encryptedAccessToken, TOKEN_KEY)).toMatch(/^mock-access-/)
    })

    it('still signs in when the Forgejo login cannot be fetched', async () => {
      idp.user = { sub: 'sub-dave', email: 'dave@example.org', name: 'Dave' }
      const result = await performLogin()

      expect(result.status).toBe(302)
      expect(result.sessionCookie).toBeDefined()
      const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.userId, 'sub-dave'))
      expect(rows).toHaveLength(0)
    })
  })

  describe('Anmeldung beginnt auf der öffentlichen Adresse', () => {
    it('leitet einen Login-Start von fremder Adresse auf F451_PUBLIC_BASE_URL um, die eigene geht zum IdP', async () => {
      const oeffentlich = buildApp({
        databaseUrl: pg.connectionString,
        publicBaseUrl: 'http://wiki.example:8080',
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          oidcAllowInsecure: true,
          oidc: { issuer: idp.issuer, clientId: 'test-client', clientSecret: 'test-secret', redirectUrl: REDIRECT_URL },
        },
        rateLimits: { auth: { max: 1000, windowMs: 60_000 }, search: { max: 1000, windowMs: 60_000 } },
      })
      await oeffentlich.ready()
      try {
        const fremd = await oeffentlich.inject({ method: 'GET', url: '/auth/login?next=/wiki', headers: { host: 'localhost:8080' } })
        expect(fremd.statusCode).toBe(302)
        expect(fremd.headers.location).toBe('http://wiki.example:8080/auth/login?next=%2Fwiki')
        expect(fremd.cookies.find((c) => c.name === TX_COOKIE_NAME)).toBeUndefined()

        const eigen = await oeffentlich.inject({ method: 'GET', url: '/auth/login?next=/wiki', headers: { host: 'wiki.example:8080' } })
        expect(eigen.statusCode).toBe(302)
        expect(String(eigen.headers.location).startsWith(idp.issuer)).toBe(true)
        expect(eigen.cookies.find((c) => c.name === TX_COOKIE_NAME)).toBeDefined()
      } finally {
        await oeffentlich.close()
      }
    })
  })
})
