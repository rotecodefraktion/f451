import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { buildApp } from '../src/app.js'
import { markNeedsReconnect } from '../src/auth/connect.js'
import { decryptToken } from '../src/auth/crypto.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { providerAccounts, users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { startMockForgejoOAuth, type MockForgejoOAuth } from './helpers/mock-forgejo-oauth.js'

const TOKEN_KEY = Buffer.alloc(32, 11).toString('base64')
const CONNECT_TX_COOKIE_NAME = 'f451_connect_tx'

const GITHUB_CLIENT_ID = 'test-github-client'
const GITHUB_CLIENT_SECRET = 'test-github-secret'
const FORGEJO_CLIENT_ID = 'test-forgejo-client'
const FORGEJO_CLIENT_SECRET = 'test-forgejo-secret'

interface ConnectResult {
  status: number
  location: string
}

describe.sequential('Provider-Kontoverknüpfung (Forgejo + GitHub OAuth)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let forgejo: MockForgejoOAuth
  let app: FastifyInstance
  let userCounter = 0

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    forgejo = await startMockForgejoOAuth()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: {
          forgejo: {
            baseUrl: forgejo.baseUrl,
            clientId: FORGEJO_CLIENT_ID,
            clientSecret: FORGEJO_CLIENT_SECRET,
          },
          github: {
            clientId: GITHUB_CLIENT_ID,
            clientSecret: GITHUB_CLIENT_SECRET,
          },
        },
      },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app.close()
    await forgejo.stop()
    await handle.close()
    await pg.stop()
  })

  // MockAgent nur für github.com/api.github.com — Weiterleitung an das echte
  // Netzwerk bleibt aktiv (kein disableNetConnect), damit der reale Fetch zum
  // lokalen Forgejo-Mock (Loopback) unangetastet funktioniert.
  let agent: MockAgent
  let prevDispatcher: Dispatcher

  beforeEach(() => {
    prevDispatcher = getGlobalDispatcher()
    agent = new MockAgent()
    setGlobalDispatcher(agent)
  })

  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher)
    await agent.close()
    forgejo.accessToken = 'forgejo-access-token-1'
    forgejo.refreshToken = 'forgejo-refresh-token-1'
    forgejo.login = 'alice-forgejo'
  })

  async function insertUserWithSession(): Promise<{ userId: string; sessionId: string }> {
    userCounter += 1
    const userId = `connect-user-${userCounter}`
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.org`,
      displayName: `Connect User ${userCounter}`,
    })
    const session = await createSession(db, userId)
    return { userId, sessionId: session.id }
  }

  function mockGithubExchange(opts: { accessToken: string; login: string }): void {
    agent
      .get('https://github.com')
      .intercept({ path: '/login/oauth/access_token', method: 'POST' })
      .reply(200, { access_token: opts.accessToken, token_type: 'bearer', scope: 'repo,read:user' })
    agent
      .get('https://api.github.com')
      .intercept({ path: '/user', method: 'GET' })
      .reply(200, { login: opts.login })
  }

  /** Startet /auth/connect/:provider, folgt dem Redirect zum Provider (echter fetch bei Forgejo), injiziert den Callback. */
  async function performConnect(
    provider: 'forgejo' | 'github',
    sessionId: string,
    opts: { tamperState?: boolean } = {},
  ): Promise<ConnectResult> {
    const startRes = await app.inject({
      method: 'GET',
      url: `/auth/connect/${provider}`,
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
    })
    expect(startRes.statusCode).toBe(302)

    const txCookie = startRes.cookies.find((c) => c.name === CONNECT_TX_COOKIE_NAME)
    expect(txCookie, 'connect-tx-cookie muss gesetzt sein').toBeDefined()

    let callbackUrl: URL
    if (provider === 'forgejo') {
      const authorizeUrl = startRes.headers.location as string
      const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' })
      expect(authorizeRes.status).toBe(302)
      callbackUrl = new URL(authorizeRes.headers.get('location') as string)
    } else {
      // GitHubs Authorize-Seite selbst wird nicht angefragt (Browser-Redirect) —
      // wir extrahieren `state` aus der Location und simulieren den Provider-Callback direkt.
      const location = new URL(startRes.headers.location as string)
      expect(location.origin).toBe('https://github.com')
      expect(location.pathname).toBe('/login/oauth/authorize')
      const state = location.searchParams.get('state')!
      callbackUrl = new URL(`http://internal.invalid/auth/connect/github/callback`)
      callbackUrl.searchParams.set('code', `github-code-${Math.random().toString(36).slice(2)}`)
      callbackUrl.searchParams.set('state', state)
    }

    if (opts.tamperState) {
      callbackUrl.searchParams.set('state', 'voellig-falscher-state')
    }

    const cbRes = await app.inject({
      method: 'GET',
      url: callbackUrl.pathname + callbackUrl.search,
      cookies: { [CONNECT_TX_COOKIE_NAME]: txCookie!.value, [SESSION_COOKIE_NAME]: sessionId },
    })

    return { status: cbRes.statusCode, location: (cbRes.headers.location as string) ?? '' }
  }

  describe('OAuth-Roundtrip', () => {
    it('Forgejo: Verknüpfung landet upsertet in provider_accounts und leitet auf / weiter', async () => {
      const { userId, sessionId } = await insertUserWithSession()
      forgejo.accessToken = 'forgejo-roundtrip-token'
      forgejo.login = 'alice-fj'

      const result = await performConnect('forgejo', sessionId)
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')

      const rows = await db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.userId, userId))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.provider).toBe('forgejo')
      expect(rows[0]!.providerLogin).toBe('alice-fj')
    })

    it('GitHub: Verknüpfung landet upsertet in provider_accounts und leitet auf / weiter', async () => {
      const { userId, sessionId } = await insertUserWithSession()
      mockGithubExchange({ accessToken: 'github-roundtrip-token', login: 'alice-gh' })

      const result = await performConnect('github', sessionId)
      expect(result.status).toBe(302)
      expect(result.location).toBe('/')

      const rows = await db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.userId, userId))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.provider).toBe('github')
      expect(rows[0]!.providerLogin).toBe('alice-gh')
    })
  })

  describe('Token-Verschlüsselung', () => {
    it('das Access-Token landet NUR verschlüsselt in der DB (kein Klartext-Substring, Format v1:...)', async () => {
      const { userId, sessionId } = await insertUserWithSession()
      const plainToken = 'super-secret-forgejo-token-xyz'
      forgejo.accessToken = plainToken
      forgejo.login = 'bob-fj'

      const result = await performConnect('forgejo', sessionId)
      expect(result.status).toBe(302)

      const rows = await db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.userId, userId))
      expect(rows).toHaveLength(1)
      const encrypted = rows[0]!.encryptedAccessToken
      expect(encrypted.startsWith('v1:')).toBe(true)
      expect(encrypted).not.toContain(plainToken)
      expect(encrypted).not.toBe(plainToken)

      const encryptedRefresh = rows[0]!.encryptedRefreshToken
      expect(encryptedRefresh).not.toBeNull()
      expect(encryptedRefresh!.startsWith('v1:')).toBe(true)
    })
  })

  describe('Negativfälle', () => {
    it('state-Mismatch → zurück zu den Verbindungen mit Meldung, keine Verknüpfung', async () => {
      const { sessionId } = await insertUserWithSession()
      const result = await performConnect('forgejo', sessionId, { tamperState: true })
      expect(result.status).toBe(302)
      expect(result.location).toBe('/einstellungen/verbindungen?verbindung=fehlgeschlagen')
    })

    it('Callback ohne Session → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/connect/forgejo/callback?code=irgendwas&state=irgendwas',
      })
      expect(res.statusCode).toBe(401)
    })

    it('unbekannter Provider → 404', async () => {
      const { sessionId } = await insertUserWithSession()
      const res = await app.inject({
        method: 'GET',
        url: '/auth/connect/gitlab',
        cookies: { [SESSION_COOKIE_NAME]: sessionId },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('Doppel-Connect', () => {
    it('ersetzt das bestehende Token statt eine zweite Zeile anzulegen', async () => {
      const { userId, sessionId } = await insertUserWithSession()

      forgejo.accessToken = 'forgejo-first-token'
      forgejo.login = 'first-login'
      const first = await performConnect('forgejo', sessionId)
      expect(first.status).toBe(302)

      forgejo.accessToken = 'forgejo-second-token'
      forgejo.login = 'second-login'
      const second = await performConnect('forgejo', sessionId)
      expect(second.status).toBe(302)

      const rows = await db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.userId, userId))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.providerLogin).toBe('second-login')
      expect(rows[0]!.encryptedAccessToken).not.toContain('forgejo-first-token')
      expect(rows[0]!.encryptedAccessToken).not.toContain('forgejo-second-token')

      // Review-Nachzug: nicht nur den Klartext-Substring ausschließen, sondern
      // tatsächlich entschlüsseln und den ZWEITEN Klartext-Token assertieren —
      // das beweist, dass der gespeicherte Ciphertext wirklich das neue Token
      // ist (und nicht z. B. ein unveränderter alter Wert, der zufällig keinen
      // Substring-Treffer ergibt).
      expect(decryptToken(rows[0]!.encryptedAccessToken, TOKEN_KEY)).toBe('forgejo-second-token')
    })
  })

  describe('Disconnect + /api/me', () => {
    it('DELETE entfernt die Verknüpfung und /api/me zeigt danach forgejo:false', async () => {
      const { userId, sessionId } = await insertUserWithSession()
      forgejo.accessToken = 'forgejo-disconnect-token'
      forgejo.login = 'disconnect-login'

      const connectResult = await performConnect('forgejo', sessionId)
      expect(connectResult.status).toBe(302)

      const meBefore = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE_NAME]: sessionId },
      })
      expect(meBefore.statusCode).toBe(200)
      expect(meBefore.json().connections).toEqual({ forgejo: true, github: false })

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/auth/connect/forgejo',
        cookies: { [SESSION_COOKIE_NAME]: sessionId },
      })
      expect(deleteRes.statusCode).toBe(204)

      const rows = await db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.userId, userId))
      expect(rows).toHaveLength(0)

      const meAfter = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE_NAME]: sessionId },
      })
      expect(meAfter.statusCode).toBe(200)
      expect(meAfter.json().connections).toEqual({ forgejo: false, github: false })
    })

    it('/api/me meldet eine abgelehnte Verknüpfung, ein neuer Connect hebt sie auf (Issue #70)', async () => {
      const { userId, sessionId } = await insertUserWithSession()
      forgejo.accessToken = 'forgejo-expired-token'
      expect((await performConnect('forgejo', sessionId)).status).toBe(302)
      await markNeedsReconnect(db, userId, 'forgejo')

      const meExpired = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: sessionId } })
      expect(meExpired.json().connections).toEqual({ forgejo: true, github: false })
      expect(meExpired.json().expiredConnections).toEqual({ forgejo: true, github: false })

      forgejo.accessToken = 'forgejo-renewed-token'
      expect((await performConnect('forgejo', sessionId)).status).toBe(302)

      const meRenewed = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: sessionId } })
      expect(meRenewed.json().expiredConnections).toEqual({ forgejo: false, github: false })
    })

    it('DELETE ohne Session → 401', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/auth/connect/forgejo' })
      expect(res.statusCode).toBe(401)
    })
  })
})
