import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { ForgejoProvider } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { decryptToken } from '../src/auth/crypto.js'
import { SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { providerAccounts } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { startMockIdp, type MockIdp } from './helpers/mock-idp.js'

/**
 * Auth-Lifecycle-Test (Plan Task 6): ein durchgehender Test, der die komplette
 * Phase-1d-Kette gegen echte Container fährt: Mock-IdP-Login → `/api/me` →
 * Space unsichtbar ohne Provider-Verknüpfung (leere Liste, Tree/Page 404) →
 * Connect-Flow (der Forgejo-OAuth-Endpunkt selbst ist gemockt — echtes
 * `login/oauth/authorize`+`access_token` gäbe es nur mit einer interaktiven
 * Login-Session im Container —, liefert aber als Ergebnis ein ECHTES
 * Access-Token des Forgejo-Containers, sodass die anschließende
 * Berechtigungsprüfung `/api/v1/repos/...` wirklich gegen den Container läuft)
 * → Space sichtbar + Seite lesbar → Logout → 401.
 *
 * Abnahme-Kriterium 2 (Klartext-Token nie geloggt): der Fastify-Logger dieser
 * App-Instanz schreibt auf einen Test-Stream (statt stdout, das Pino
 * standardmäßig synchron per Dateideskriptor beschreibt und sich daher nicht
 * per `process.stdout.write`-Patch abfangen lässt) — am Ende grep-en wir den
 * gesammelten Log-Text auf das Klartext-Access-Token.
 */
describe.sequential('Auth-Lifecycle: Login → Verknüpfung → Berechtigung → Logout (Task 6)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let idp: MockIdp
  let app: FastifyInstance

  let space: SpaceConfig
  let connectUser: ForgejoTestUser

  let logChunks: string[]
  let logStream: PassThrough

  const TOKEN_KEY = Buffer.alloc(32, 21).toString('base64')
  const OIDC_TX_COOKIE_NAME = 'f451_oidc_tx'
  const CONNECT_TX_COOKIE_NAME = 'f451_connect_tx'
  const OIDC_REDIRECT_URL = 'http://localhost:9999/auth/callback'

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })

    const repo = await forgejo.createRepo('lifecycle-space', { private: false })
    await provider.writeFile(
      repo,
      'index.md',
      '---\nid: lifecycle-home\ntitle: Lifecycle Start\nlang: de\n---\n# Lifecycle\n\nInhalt der Startseite.\n',
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'lifecycle-space',
      name: 'Lifecycle Space',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
    // Service-Account (Admin) indexiert — die Nutzer-Sichtbarkeit hängt davon
    // nicht ab (die entsteht erst durch die spätere Provider-Probe mit dem
    // Nutzer-Token, Plan Task 5).
    await indexSpace({ db, provider }, space)

    // Zweiter Nutzer im Container: sein per Forgejo-CLI erzeugtes API-Token
    // fungiert im Test als das "echte" Access-Token, das der gemockte
    // OAuth-Token-Endpunkt zurückliefert.
    connectUser = await forgejo.createUser('lifecycle-reader')

    idp = await startMockIdp({ sub: 'sub-lifecycle', email: 'lifecycle@example.org', name: 'Lifecycle User' })

    logChunks = []
    logStream = new PassThrough()
    logStream.on('data', (chunk: Buffer) => logChunks.push(chunk.toString('utf8')))

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      logStream,
      // Wie die Service-Account-Registry, unabhängig von `auth.connect.forgejo`
      // (Phase 2a Task 2, Konsistenz-Auflage aus dem Task-1-Review).
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        // Task 3 (Auth-Härtung M2, Spec §7): seit der Entkopplung von
        // `insecureCookies` steuert ausschließlich dieses Feld, ob die
        // OIDC-Discovery http-Issuer erlaubt (hier: der Mock-IdP).
        oidcAllowInsecure: true,
        oidc: {
          issuer: idp.issuer,
          clientId: 'lifecycle-client',
          clientSecret: 'lifecycle-secret',
          redirectUrl: OIDC_REDIRECT_URL,
        },
        connect: {
          forgejo: {
            baseUrl: forgejo.baseUrl,
            clientId: 'lifecycle-forgejo-oauth-client',
            clientSecret: 'lifecycle-forgejo-oauth-secret',
          },
        },
      },
    })
    await app.ready()
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await idp?.stop()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it(
    'Mock-IdP-Login → /api/me → Space unsichtbar → Connect (echter Forgejo-Token) → Space sichtbar → Logout → 401',
    async () => {
      const prevDispatcher: Dispatcher = getGlobalDispatcher()
      const agent = new MockAgent()
      setGlobalDispatcher(agent)

      try {
        // Nur die beiden Forgejo-OAuth-Endpunkte (authorize + Token-Tausch) auf
        // dem echten Container-Origin mocken. Alles andere auf demselben Origin
        // (insb. `/api/v1/user` beim Connect und `/api/v1/repos/...` bei der
        // späteren Berechtigungsprüfung) läuft unverändert gegen das echte
        // Netzwerk (kein `disableNetConnect()`, wie in auth-connect.test.ts) —
        // dort authentifiziert sich das zurückgegebene Token dann wirklich am
        // Container, nicht an einem Mock.
        agent
          .get(forgejo.baseUrl)
          .intercept({ path: (p: string) => p.startsWith('/login/oauth/authorize'), method: 'GET' })
          .reply((opts) => {
            const url = new URL(opts.path, forgejo.baseUrl)
            const redirectUri = url.searchParams.get('redirect_uri')
            if (!redirectUri) throw new Error('redirect_uri fehlt in der gemockten Authorize-Anfrage')
            const location = new URL(redirectUri)
            location.searchParams.set('code', `lifecycle-forgejo-code-${Math.random().toString(36).slice(2)}`)
            const state = url.searchParams.get('state')
            if (state !== null) location.searchParams.set('state', state)
            return { statusCode: 302, data: '', responseOptions: { headers: { location: location.href } } }
          })

        agent
          .get(forgejo.baseUrl)
          .intercept({ path: '/login/oauth/access_token', method: 'POST' })
          .reply(200, { access_token: connectUser.token, token_type: 'bearer' })

        // --- 1. Mock-IdP-Login ------------------------------------------------
        const loginRes = await app.inject({ method: 'GET', url: '/auth/login' })
        expect(loginRes.statusCode).toBe(302)
        const oidcTxCookie = loginRes.cookies.find((c) => c.name === OIDC_TX_COOKIE_NAME)
        expect(oidcTxCookie, 'oidc-tx-cookie muss gesetzt sein').toBeDefined()

        const authorizeRes = await fetch(loginRes.headers.location as string, { redirect: 'manual' })
        expect(authorizeRes.status).toBe(302)
        const oidcCallbackUrl = new URL(authorizeRes.headers.get('location') as string)

        const callbackRes = await app.inject({
          method: 'GET',
          url: oidcCallbackUrl.pathname + oidcCallbackUrl.search,
          cookies: { [OIDC_TX_COOKIE_NAME]: oidcTxCookie!.value },
        })
        expect(callbackRes.statusCode).toBe(302)
        expect(callbackRes.headers.location).toBe('/')
        const sessionCookie = callbackRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value
        expect(sessionCookie, 'session-cookie muss nach Login gesetzt sein').toBeDefined()
        const authCookies = (): Record<string, string> => ({ [SESSION_COOKIE_NAME]: sessionCookie! })

        // --- 2. /api/me ---------------------------------------------------------
        const meAfterLogin = await app.inject({ method: 'GET', url: '/api/me', cookies: authCookies() })
        expect(meAfterLogin.statusCode).toBe(200)
        expect(meAfterLogin.json()).toEqual({
          id: 'sub-lifecycle',
          email: 'lifecycle@example.org',
          displayName: 'Lifecycle User',
          connections: { forgejo: false, github: false },
          expiredConnections: { forgejo: false, github: false },
        })

        // --- 3. Space unsichtbar ohne Provider-Verknüpfung -----------------------
        const spacesBefore = await app.inject({ method: 'GET', url: '/api/spaces', cookies: authCookies() })
        expect(spacesBefore.statusCode).toBe(200)
        expect(spacesBefore.json()).toEqual([])

        const treeBefore = await app.inject({
          method: 'GET',
          url: `/api/spaces/${space.id}/tree`,
          cookies: authCookies(),
        })
        expect(treeBefore.statusCode).toBe(404)

        const pageBefore = await app.inject({
          method: 'GET',
          url: '/api/pages/lifecycle-home',
          cookies: authCookies(),
        })
        expect(pageBefore.statusCode).toBe(404)

        // --- 4. Connect-Flow (gemockter Forgejo-OAuth, echtes Container-Token) ---
        const connectStartRes = await app.inject({
          method: 'GET',
          url: '/auth/connect/forgejo',
          cookies: authCookies(),
        })
        expect(connectStartRes.statusCode).toBe(302)
        const connectTxCookie = connectStartRes.cookies.find((c) => c.name === CONNECT_TX_COOKIE_NAME)
        expect(connectTxCookie, 'connect-tx-cookie muss gesetzt sein').toBeDefined()

        const authorizeConnectRes = await fetch(connectStartRes.headers.location as string, { redirect: 'manual' })
        expect(authorizeConnectRes.status).toBe(302)
        const connectCallbackUrl = new URL(authorizeConnectRes.headers.get('location') as string)

        const connectCallbackRes = await app.inject({
          method: 'GET',
          url: connectCallbackUrl.pathname + connectCallbackUrl.search,
          cookies: { [CONNECT_TX_COOKIE_NAME]: connectTxCookie!.value, ...authCookies() },
        })
        expect(connectCallbackRes.statusCode).toBe(302)
        expect(connectCallbackRes.headers.location).toBe('/')

        // Token landet NUR verschlüsselt in der DB — und entschlüsselt ist es
        // wirklich das ECHTE Token des Forgejo-Containers (kein Mock-Wert).
        const accountRows = await db
          .select()
          .from(providerAccounts)
          .where(eq(providerAccounts.userId, 'sub-lifecycle'))
        expect(accountRows).toHaveLength(1)
        expect(accountRows[0]!.provider).toBe('forgejo')
        expect(accountRows[0]!.providerLogin).toBe(connectUser.username)
        expect(accountRows[0]!.encryptedAccessToken.startsWith('v1:')).toBe(true)
        expect(accountRows[0]!.encryptedAccessToken).not.toContain(connectUser.token)
        expect(decryptToken(accountRows[0]!.encryptedAccessToken, TOKEN_KEY)).toBe(connectUser.token)

        // --- 5. Space sichtbar + Seite lesbar -------------------------------------
        const meAfterConnect = await app.inject({ method: 'GET', url: '/api/me', cookies: authCookies() })
        expect(meAfterConnect.statusCode).toBe(200)
        expect(meAfterConnect.json().connections).toEqual({ forgejo: true, github: false })

        const spacesAfter = await app.inject({ method: 'GET', url: '/api/spaces', cookies: authCookies() })
        expect(spacesAfter.statusCode).toBe(200)
        expect(spacesAfter.json()).toEqual([{ id: space.id, name: space.name, defaultLang: space.defaultLang }])

        const treeAfter = await app.inject({
          method: 'GET',
          url: `/api/spaces/${space.id}/tree`,
          cookies: authCookies(),
        })
        expect(treeAfter.statusCode).toBe(200)
        expect((treeAfter.json() as unknown[]).length).toBeGreaterThan(0)

        const pageAfter = await app.inject({
          method: 'GET',
          url: '/api/pages/lifecycle-home',
          cookies: authCookies(),
        })
        expect(pageAfter.statusCode).toBe(200)
        expect(pageAfter.json().title).toBe('Lifecycle Start')

        // --- 6. Logout -------------------------------------------------------------
        const logoutRes = await app.inject({ method: 'POST', url: '/auth/logout', cookies: authCookies() })
        expect(logoutRes.statusCode).toBe(204)

        // --- 7. 401 nach Logout ------------------------------------------------------
        const meAfterLogout = await app.inject({ method: 'GET', url: '/api/me', cookies: authCookies() })
        expect(meAfterLogout.statusCode).toBe(401)
        expect(meAfterLogout.headers['www-authenticate']).toBe('session')

        const spacesAfterLogout = await app.inject({ method: 'GET', url: '/api/spaces', cookies: authCookies() })
        expect(spacesAfterLogout.statusCode).toBe(401)
      } finally {
        setGlobalDispatcher(prevDispatcher)
        await agent.close()
      }

      // --- Abnahme-Kriterium 2: Klartext-Token in keiner Log-Ausgabe -----------------
      // Pino schreibt synchron auf `logStream`; einen Tick abwarten, damit alle
      // 'data'-Events der PassThrough-Stream verarbeitet sind, bevor wir grep-en.
      await new Promise((resolve) => setImmediate(resolve))
      const logOutput = logChunks.join('')
      expect(logOutput.length).toBeGreaterThan(0) // Kanary: Logger schreibt überhaupt etwas.
      expect(logOutput).not.toContain(connectUser.token)
    },
    240_000,
  )
})
