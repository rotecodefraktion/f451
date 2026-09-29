import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { buildApp } from '../src/app.js'
import { decryptToken } from '../src/auth/crypto.js'
import { SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { providerAccounts, users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { startMockIdp } from './helpers/mock-idp.js'

const TOKEN_KEY = Buffer.alloc(32, 21).toString('base64')
const TX_COOKIE_NAME = 'f451_github_tx'

const GITHUB_CLIENT_ID = 'test-github-login-client'
const GITHUB_CLIENT_SECRET = 'test-github-login-secret'

interface LoginResult {
  status: number
  location: string
  sessionCookie?: string
}

interface GithubProfileFixture {
  accessToken: string
  id: number
  login: string
  name?: string | null
  email?: string | null
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>
}

describe.sequential('GitHub sign-in (#8)', () => {
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
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: {
          github: { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET },
        },
        githubLogin: true,
      },
      // Same reasoning as auth-oidc.test.ts: many logins in this file against a
      // single shared app/client-IP, a test artefact — not a production expectation.
      rateLimits: { auth: { max: 1000, windowMs: 60_000 }, search: { max: 1000, windowMs: 60_000 } },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app.close()
    await handle.close()
    await pg.stop()
  })

  // MockAgent only for github.com/api.github.com — real network stays available
  // for the local Postgres test container.
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
  })

  function mockGithubProfile(profile: GithubProfileFixture): void {
    agent
      .get('https://github.com')
      .intercept({ path: '/login/oauth/access_token', method: 'POST' })
      .reply(200, { access_token: profile.accessToken, token_type: 'bearer', scope: 'read:user,user:email,repo' })
    agent
      .get('https://api.github.com')
      .intercept({ path: '/user', method: 'GET' })
      .reply(200, { id: profile.id, login: profile.login, name: profile.name ?? null, email: profile.email ?? null })
    if (profile.emails) {
      agent
        .get('https://api.github.com')
        .intercept({ path: '/user/emails', method: 'GET' })
        .reply(200, profile.emails)
    }
  }

  /** Starts /auth/github/login, extracts state from the (mocked) GitHub redirect,
   *  injects the callback directly (mirrors auth-connect.test.ts's GitHub branch —
   *  GitHub's authorize page itself is never fetched, only its redirect target). */
  async function performLogin(
    profile: GithubProfileFixture,
    opts: { next?: string; tamperState?: boolean } = {},
  ): Promise<LoginResult> {
    mockGithubProfile(profile)

    const loginUrl = opts.next ? `/auth/github/login?next=${encodeURIComponent(opts.next)}` : '/auth/github/login'
    const loginRes = await app.inject({ method: 'GET', url: loginUrl })
    expect(loginRes.statusCode).toBe(302)

    const txCookie = loginRes.cookies.find((c) => c.name === TX_COOKIE_NAME)
    expect(txCookie, 'github-tx-cookie muss gesetzt sein').toBeDefined()

    const location = new URL(loginRes.headers.location as string)
    expect(location.origin).toBe('https://github.com')
    expect(location.pathname).toBe('/login/oauth/authorize')
    const state = location.searchParams.get('state')!

    const callbackUrl = new URL('http://internal.invalid/auth/github/callback')
    callbackUrl.searchParams.set('code', `github-code-${Math.random().toString(36).slice(2)}`)
    callbackUrl.searchParams.set('state', opts.tamperState ? 'completely-wrong-state' : state)

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

  describe('GET /auth/github/login', () => {
    it('redirects to GitHub with state, the correct scope and redirect_uri', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/github/login', headers: { host: 'wiki.test' } })
      expect(res.statusCode).toBe(302)

      const location = new URL(res.headers.location as string)
      expect(location.origin).toBe('https://github.com')
      expect(location.pathname).toBe('/login/oauth/authorize')
      expect(location.searchParams.get('client_id')).toBe(GITHUB_CLIENT_ID)
      expect(location.searchParams.get('redirect_uri')).toBe('http://wiki.test/auth/github/callback')
      expect(location.searchParams.get('scope')).toBe('read:user user:email repo')
      expect(location.searchParams.get('state')).toBeTruthy()

      const txCookie = res.cookies.find((c) => c.name === TX_COOKIE_NAME)
      expect(txCookie).toBeDefined()
    })
  })

  describe('Roundtrip', () => {
    it('creates user github:<id>, a session and the GitHub connection', async () => {
      const result = await performLogin({
        accessToken: 'gh-access-1',
        id: 42,
        login: 'octocat',
        name: 'The Octocat',
        email: 'octo@example.org',
      })

      expect(result.status).toBe(302)
      expect(result.location).toBe('/')
      expect(result.sessionCookie).toBeDefined()

      const [user] = await db.select().from(users).where(eq(users.id, 'github:42'))
      expect(user).toBeDefined()
      expect(user!.email).toBe('octo@example.org')
      expect(user!.displayName).toBe('The Octocat')

      const [account] = await db.select().from(providerAccounts).where(eq(providerAccounts.userId, 'github:42'))
      expect(account).toBeDefined()
      expect(account!.provider).toBe('github')
      expect(account!.providerLogin).toBe('octocat')
      expect(decryptToken(account!.encryptedAccessToken, TOKEN_KEY)).toBe('gh-access-1')
    })

    it('falls back to the GitHub login as display name when no name is set', async () => {
      const result = await performLogin({
        accessToken: 'gh-access-2',
        id: 43,
        login: 'no-name-user',
        name: null,
        email: 'nn@example.org',
      })
      expect(result.status).toBe(302)

      const [user] = await db.select().from(users).where(eq(users.id, 'github:43'))
      expect(user!.displayName).toBe('no-name-user')
    })
  })

  describe('Email fallback via /user/emails', () => {
    it('uses the primary, verified address when /user omits email', async () => {
      const result = await performLogin({
        accessToken: 'gh-access-3',
        id: 44,
        login: 'private-email-user',
        name: 'Private Email',
        email: null,
        emails: [
          { email: 'secondary@example.org', primary: false, verified: true },
          { email: 'primary@example.org', primary: true, verified: true },
        ],
      })
      expect(result.status).toBe(302)

      const [user] = await db.select().from(users).where(eq(users.id, 'github:44'))
      expect(user!.email).toBe('primary@example.org')
    })

    it('falls back to an empty email when nothing is verified', async () => {
      const result = await performLogin({
        accessToken: 'gh-access-4',
        id: 45,
        login: 'no-verified-email-user',
        name: 'No Verified Email',
        email: null,
        emails: [{ email: 'unverified@example.org', primary: true, verified: false }],
      })
      expect(result.status).toBe(302)

      const [user] = await db.select().from(users).where(eq(users.id, 'github:45'))
      expect(user!.email).toBe('')
    })
  })

  describe('Negativfälle', () => {
    it('wrong state → fail redirect, no session, no user created', async () => {
      const result = await performLogin(
        { accessToken: 'gh-access-5', id: 46, login: 'tampered-user' },
        { tamperState: true },
      )
      expect(result.status).toBe(302)
      expect(result.location).toBe('/?anmeldung=fehlgeschlagen')
      expect(result.sessionCookie).toBeUndefined()

      const rows = await db.select().from(users).where(eq(users.id, 'github:46'))
      expect(rows).toHaveLength(0)
    })

    it('callback without a tx cookie → redirect with abgelaufen', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/github/callback?code=irgendwas&state=irgendwas',
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('/?anmeldung=abgelaufen')
    })
  })

  describe('GitHub-only mode (no OIDC)', () => {
    it('builds without an OIDC issuer and serves /api/me for a GitHub session', async () => {
      const result = await performLogin({
        accessToken: 'gh-access-6',
        id: 47,
        login: 'github-only-user',
        name: 'GH Only',
        email: 'gh-only@example.org',
      })
      expect(result.sessionCookie).toBeDefined()

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE_NAME]: result.sessionCookie! },
      })
      expect(meRes.statusCode).toBe(200)
      expect(meRes.json()).toEqual({
        id: 'github:47',
        email: 'gh-only@example.org',
        displayName: 'GH Only',
        connections: { forgejo: false, github: true },
        expiredConnections: { forgejo: false, github: false },
      })
    })

    it('signs out without OIDC routes', async () => {
      const result = await performLogin({ accessToken: 'gh-access-7', id: 48, login: 'gh-out', name: 'Out', email: 'out@example.org' })
      const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { [SESSION_COOKIE_NAME]: result.sessionCookie! } })
      expect(out.statusCode).toBe(204)
      const meRes = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: result.sessionCookie! } })
      expect(meRes.statusCode).toBe(401)
    })
  })

  describe('GET /auth/methods (#8)', () => {
    it('includes github when githubLogin is enabled', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/methods' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ methods: [{ id: 'github', href: '/auth/github/login', label: 'GitHub' }], note: null })
    })

    it('omits github when githubLogin is not enabled', async () => {
      const withoutGithubLogin = buildApp({
        databaseUrl: pg.connectionString,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          connect: { github: { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET } },
          signInNote: 'Demo: sign in as demo\nReset nightly.',
        },
      })
      await withoutGithubLogin.ready()
      try {
        const res = await withoutGithubLogin.inject({ method: 'GET', url: '/auth/methods' })
        // The operator note is passed through as plain text.
        expect(res.json()).toEqual({ methods: [], note: 'Demo: sign in as demo\nReset nightly.' })
      } finally {
        await withoutGithubLogin.close()
      }
    })

    it('lists github after oidc when both are configured', async () => {
      const idp = await startMockIdp({ sub: 'sub-both', email: 'both@example.org', name: 'Both' })
      try {
        const both = buildApp({
          databaseUrl: pg.connectionString,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            oidcAllowInsecure: true,
            oidc: {
              issuer: idp.issuer,
              clientId: 'test-client',
              clientSecret: 'test-secret',
              redirectUrl: 'http://localhost:9999/auth/callback',
            },
            connect: { github: { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET } },
            githubLogin: true,
          },
        })
        await both.ready()
        try {
          const res = await both.inject({ method: 'GET', url: '/auth/methods' })
          expect(res.json()).toEqual({
            methods: [
              { id: 'oidc', href: '/auth/login', label: null },
              { id: 'github', href: '/auth/github/login', label: 'GitHub' },
            ],
            note: null,
          })
        } finally {
          await both.close()
        }
      } finally {
        await idp.stop()
      }
    })
  })
})
