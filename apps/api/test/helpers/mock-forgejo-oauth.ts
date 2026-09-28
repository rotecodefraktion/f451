import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Minimaler Forgejo-OAuth-Mock für Tests (Plan Task 4): ein echt lauschender
 * Fastify-Server, der `/login/oauth/authorize` (redirectet sofort mit
 * code+state), `/login/oauth/access_token` (Token-Tausch) und `/api/v1/user`
 * (Login-Name-Abruf) bereitstellt — analog zu `mock-idp.ts` (Task 3), aber
 * für den Provider-Connect-Flow statt OIDC.
 *
 * `accessToken`/`login` sind mutierbar, damit ein Test einen zweiten
 * Connect-Durchlauf mit anderen Werten simulieren kann (Doppel-Connect-Test).
 */
export interface MockForgejoOAuth {
  /** Basis-URL (ohne /api/v1), z. B. `http://127.0.0.1:54321`. */
  baseUrl: string
  accessToken: string
  refreshToken: string
  login: string
  stop(): Promise<void>
}

export async function startMockForgejoOAuth(): Promise<MockForgejoOAuth> {
  const app: FastifyInstance = Fastify()

  const state = {
    accessToken: 'forgejo-access-token-1',
    refreshToken: 'forgejo-refresh-token-1',
    login: 'alice-forgejo',
  }

  const codes = new Set<string>()

  app.get('/login/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (!q.redirect_uri) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri fehlt' })
    }
    const code = `forgejo-code-${randomUUID()}`
    codes.add(code)
    const location = new URL(q.redirect_uri)
    location.searchParams.set('code', code)
    if (q.state !== undefined) location.searchParams.set('state', q.state)
    return reply.redirect(location.href, 302)
  })

  app.post('/login/oauth/access_token', async (req, reply) => {
    const body = req.body as Record<string, unknown>
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : 'authorization_code'

    // Task 4b/4 (Token-Refresh): Forgejo rotiert den Refresh-Token bei jeder
    // Einlösung (realistisches Verhalten laut Aufgabenstellung) — ein bereits
    // eingelöster (alter) Refresh-Token wird wie ein widerrufener behandelt
    // (400 invalid_grant), damit der Konkurrenz-Testfall (zwei parallele
    // Refresh-Versuche mit demselben, inzwischen verbrauchten Token) realistisch
    // reproduzierbar ist.
    if (grantType === 'refresh_token') {
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined
      if (!refreshToken || refreshToken !== state.refreshToken) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'unbekannter/veralteter refresh_token' })
      }
      state.accessToken = `forgejo-refreshed-access-${randomUUID()}`
      state.refreshToken = `forgejo-refreshed-refresh-${randomUUID()}`
      return reply.send({
        access_token: state.accessToken,
        token_type: 'bearer',
        refresh_token: state.refreshToken,
      })
    }

    const code = typeof body.code === 'string' ? body.code : undefined
    if (!code || !codes.has(code)) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'unbekannter code' })
    }
    codes.delete(code)
    return reply.send({
      access_token: state.accessToken,
      token_type: 'bearer',
      refresh_token: state.refreshToken,
    })
  })

  app.get('/api/v1/user', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${state.accessToken}`) {
      return reply.code(401).send({ message: 'unauthorized' })
    }
    return reply.send({ login: state.login })
  })

  const address = await app.listen({ port: 0, host: '127.0.0.1' })

  return {
    get baseUrl() {
      return address.replace(/\/$/, '')
    },
    get accessToken() {
      return state.accessToken
    },
    set accessToken(v: string) {
      state.accessToken = v
    },
    get refreshToken() {
      return state.refreshToken
    },
    set refreshToken(v: string) {
      state.refreshToken = v
    },
    get login() {
      return state.login
    },
    set login(v: string) {
      state.login = v
    },
    async stop() {
      await app.close()
    },
  }
}
