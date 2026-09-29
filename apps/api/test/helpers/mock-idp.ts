import { generateKeyPairSync, type KeyObject, randomUUID, sign as cryptoSign } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Minimaler OIDC-Identity-Provider für Tests (Plan Task 3): ein echt lauschender
 * Fastify-Server mit Discovery-Dokument, JWKS (generiertes RSA-Paar),
 * `/authorize` (redirectet sofort mit code+state) und `/token` (liefert ein
 * RS256-signiertes id_token mit sub/email/name + dem nonce aus der
 * Authorize-Anfrage).
 *
 * JWT-Signierung erfolgt bewusst mit `node:crypto` (kein jose-Import), da jose
 * bei pnpm nur transitiv (nicht direkt auflösbar) vorliegt — der Plan lässt
 * genau diesen Fallback zu.
 *
 * Für Negativtests konfigurierbar: `tamper.nonce` setzt einen falschen nonce ins
 * id_token, `tamper.issuer` einen falschen `iss`-Claim.
 */

const KEY_ID = 'mock-idp-key-1'

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function signJwt(claims: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: KEY_ID }
  const encodedHeader = base64url(JSON.stringify(header))
  const encodedPayload = base64url(JSON.stringify(claims))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), privateKey)
  return `${signingInput}.${base64url(signature)}`
}

export interface MockIdpUser {
  sub: string
  email: string
  name: string
  /** Set → the mock also answers Forgejo's `GET /api/v1/user` with this login
   *  (Forgejo as identity provider and Git account at once, #8). */
  forgejoLogin?: string
}

export interface MockIdpTamper {
  /** Falschen nonce ins id_token schreiben (openid-client muss ablehnen). */
  nonce?: boolean
  /** Falschen `iss`-Claim ins id_token schreiben (openid-client muss ablehnen). */
  issuer?: boolean
}

export interface MockIdp {
  /** Issuer-Identifier (Basis-URL), z. B. `http://127.0.0.1:54321`. */
  issuer: string
  /** Der Nutzer, den der IdP beim nächsten Login zurückgibt (mutierbar). */
  user: MockIdpUser
  /** Manipulationen für Negativtests (mutierbar). */
  tamper: MockIdpTamper
  stop(): Promise<void>
}

interface AuthorizeRecord {
  nonce?: string
  clientId?: string
  redirectUri: string
}

/**
 * Startet den Mock-IdP auf einem zufälligen Port (127.0.0.1, http — der Client
 * muss dafür `allowInsecureRequests` nutzen).
 */
export async function startMockIdp(initialUser?: Partial<MockIdpUser>): Promise<MockIdp> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })

  const app: FastifyInstance = Fastify()
  // openid-client sendet die Token-Anfrage als application/x-www-form-urlencoded.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    },
  )

  const codes = new Map<string, AuthorizeRecord>()

  const state = {
    user: {
      sub: initialUser?.sub ?? 'mock-sub-001',
      email: initialUser?.email ?? 'alice@example.org',
      name: initialUser?.name ?? 'Alice Example',
    } satisfies MockIdpUser,
    tamper: {} as MockIdpTamper,
  }

  let issuer = ''

  app.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: ['openid', 'email', 'profile'],
    claims_supported: ['sub', 'email', 'name', 'nonce', 'aud', 'iss', 'exp', 'iat'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }))

  app.get('/jwks', async () => ({
    keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }],
  }))

  // Test-Kontrolle (Phase 2d Task 8): erlaubt einem SEPARATEN Prozess (der
  // Playwright-Testrunner, der `start-stack.ts`s Mock-IdP nicht direkt
  // importieren kann — eigener Subprozess, s. `start-stack.ts`-Kopfkommentar)
  // die Identität für den NÄCHSTEN `/authorize`-Login umzuschalten, ohne einen
  // zweiten IdP-Prozess zu starten. Bewusst ein simpler In-Memory-Zustand
  // (kein pro-Request-`login_hint`): die E2E-Flows loggen jede Identität genau
  // einmal seriell ein (zwei Browser-Kontexte, je eigenes Session-Cookie
  // danach) — kein Bedarf für nebenläufige Identitäten während EINES Logins.
  app.post('/test/user', async (req, reply) => {
    const body = req.body as Partial<MockIdpUser> | undefined
    if (body?.sub) state.user.sub = body.sub
    if (body?.email) state.user.email = body.email
    if (body?.name) state.user.name = body.name
    return reply.send({ ok: true, user: state.user })
  })

  app.get('/api/v1/user', async (_req, reply) => {
    if (!state.user.forgejoLogin) return reply.code(404).send({ message: 'not found' })
    return reply.send({ login: state.user.forgejoLogin })
  })

  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const redirectUri = q.redirect_uri
    const clientState = q.state
    if (!redirectUri) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri fehlt' })
    }
    const code = randomUUID()
    codes.set(code, { nonce: q.nonce, clientId: q.client_id, redirectUri })

    const location = new URL(redirectUri)
    location.searchParams.set('code', code)
    if (clientState !== undefined) location.searchParams.set('state', clientState)
    return reply.redirect(location.href, 302)
  })

  app.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string | undefined>
    const code = body.code
    const record = code ? codes.get(code) : undefined
    if (!code || !record) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'unbekannter code' })
    }
    codes.delete(code)

    const now = Math.floor(Date.now() / 1000)
    const nonce = state.tamper.nonce ? `tampered-${record.nonce ?? ''}` : record.nonce
    const iss = state.tamper.issuer ? `${issuer}/wrong-issuer` : issuer
    const aud = record.clientId ?? body.client_id ?? 'mock-client'

    const claims: Record<string, unknown> = {
      iss,
      sub: state.user.sub,
      aud,
      exp: now + 300,
      iat: now,
      email: state.user.email,
      name: state.user.name,
    }
    if (nonce !== undefined) claims.nonce = nonce

    const idToken = signJwt(claims, privateKey)

    return reply.send({
      access_token: `mock-access-${randomUUID()}`,
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'openid email profile',
      id_token: idToken,
    })
  })

  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  issuer = address.replace(/\/$/, '')

  return {
    get issuer() {
      return issuer
    },
    get user() {
      return state.user
    },
    set user(u: MockIdpUser) {
      state.user = u
    },
    get tamper() {
      return state.tamper
    },
    set tamper(t: MockIdpTamper) {
      state.tamper = t
    },
    async stop() {
      await app.close()
    },
  }
}
