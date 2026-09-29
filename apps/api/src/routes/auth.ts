import { timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/client.js'
import {
  buildConnectAuthorizeUrl,
  deleteProviderAccount,
  exchangeConnectCode,
  fetchConnectLogin,
  generateConnectState,
  getProviderConfig,
  isConnectProvider,
  updateProviderTokens,
  upsertProviderAccount,
  type ConnectOptions,
  type ProviderTokens,
} from '../auth/connect.js'
import {
  buildLoginUrl,
  completeLogin,
  discoverOidc,
  sanitizeNext,
  type OidcConfig,
  type OidcRuntime,
} from '../auth/oidc.js'
import { invalidateUserPermissions } from '../auth/permissions.js'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireSession,
  SESSION_COOKIE_NAME,
  COOKIE_PREFIX,
  setSessionCookie,
  type SessionCookieOptions,
} from '../auth/sessions.js'
import { providerAccounts, users } from '../db/schema.js'

/** Task 2 (Rate-Limits, Spec §7): Anfragebudget, das jede Auth-Route als
 *  `config.rateLimit` bekommt — `deps.rateLimits.auth` aus `app.ts` (Default
 *  oder `AppOptions.rateLimits`). WICHTIG (Fix-Runde 1, Review-Finding 2):
 *  das ist KEIN gemeinsames Gruppenbudget aller Auth-Routen —
 *  @fastify/rate-limit legt PRO Route einen EIGENEN Zähler an. `max: 10`
 *  heißt also 10/min (pro Client-IP) auf JEDER Route einzeln: Login,
 *  Callback, Logout und die 3 Connect-Routen zählen unabhängig voneinander. */
interface AuthRateLimit {
  max: number
  windowMs: number
}

export interface AuthRoutesDeps {
  db: Db
  oidc: OidcConfig
  /** Dev/Test: setzt Cookies ohne `secure` (F451_INSECURE_COOKIES). */
  insecureCookies?: boolean
  /** Task 3 (Auth-Härtung M2, Spec §7): erlaubt http-Issuer bei der OIDC-
   *  Discovery (`F451_OIDC_ALLOW_INSECURE`). Bewusst ENTKOPPELT von
   *  `insecureCookies`: eine unsichere Discovery gegen den IdP ist ein
   *  anderes Risiko als ungesicherte Cookies im Browser (Bestand VOR Task 3
   *  koppelte beides an dieselbe Variable — z. B. ein Deployment mit
   *  `F451_INSECURE_COOKIES=1` hinter einem TLS-terminierenden Proxy hätte
   *  ungewollt AUCH die IdP-Discovery abgesichert, obwohl der Proxy längst
   *  HTTPS spricht). Siehe `server.ts` für die Env-Ableitung (Default =
   *  Wert von `insecureCookies`, abwärtskompatibel). */
  oidcAllowInsecure?: boolean
  /** Task 2 (Rate-Limits, Spec §7): Budget für die 3 OIDC-Auth-Routen
   *  (Login/Callback/Logout) — gilt PRO Route, je eigener Zähler (siehe `AuthRateLimit`). */
  rateLimit: AuthRateLimit
  /** Issue #70: gesetzt, wenn Anmeldung und Forgejo-Verknüpfung dieselbe
   *  OAuth-App nutzen (gleiche Client-ID). Dann teilen sie sich in Forgejo
   *  einen Grant, und jeder Code-Tausch bei der Anmeldung erklärt den
   *  gespeicherten Refresh-Token der Verknüpfung für verbraucht. Der Callback
   *  übernimmt deshalb die frischen Anmelde-Tokens in eine bestehende
   *  Verknüpfung. Gibt es noch keine, legt er sie an (#8): Forgejo ist dann
   *  Login-Provider und Git-Konto zugleich, ein zweiter Schritt unter
   *  Settings → Connections wäre überflüssig. */
  sharedForgejoGrant?: { tokenKey: string; connect: ConnectOptions }
  /** Öffentliche Basis-URL (`F451_PUBLIC_BASE_URL`). Beginnt die Anmeldung auf
   *  einer anderen Adresse (z. B. `localhost` statt der LAN-Adresse), lägen
   *  Login-Cookie und Rücksprung auf verschiedenen Hosts und der Rücksprung
   *  schlüge fehl — `/auth/login` leitet deshalb zuerst hierher um. */
  publicBaseUrl?: string
}

export interface MeRouteDeps {
  db: Db
}

export interface ConnectRoutesDeps {
  db: Db
  connect: ConnectOptions
  /** Schlüssel zur Provider-Token-Verschlüsselung (F451_TOKEN_KEY). */
  tokenKey: string
  /** Dev/Test: setzt Cookies ohne `secure` (F451_INSECURE_COOKIES). */
  insecureCookies?: boolean
  /** Task 2 (Rate-Limits, Spec §7): Budget für die 3 Provider-Verknüpfungs-Routen
   *  — gilt PRO Route, je eigener Zähler (siehe `AuthRateLimit`). */
  rateLimit: AuthRateLimit
  /** Task 3 (Auth-Härtung M1, Spec §7): öffentliche Basis-URL (`F451_PUBLIC_BASE_URL`,
   *  `AppOptions.publicBaseUrl`), Basis für die `redirect_uri` — siehe
   *  `buildConnectRedirectUri`. */
  publicBaseUrl?: string
}

/** Kurzlebiges, signiertes Cookie für den Login-Kontext (state/nonce/code_verifier/next). */
const TX_COOKIE_NAME = `${COOKIE_PREFIX}_oidc_tx`
const TX_TTL_SECONDS = 10 * 60

/** Task 2 (Rate-Limits, Spec §7): projektweites {status,reason}-Format
 *  (Muster `routes/drafts.ts`/`routes/templates.ts`) für den 429-Zweig, den
 *  @fastify/rate-limit über `error-format.ts` wirft. */
const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

/** Bestehende Fehlerform dieser Routen (VOR Task 2 schon so, unverändert —
 *  Muster `routes/templates.ts#forbiddenSchema`). Muss zusammen mit `429:
 *  errorSchema` im `response`-Objekt stehen: sobald EIN Statuscode im
 *  Fastify-Response-Schema deklariert ist, schränkt Fastifys Typing
 *  `reply.code(...)` auf GENAU die deklarierten Codes ein — jeder von der
 *  Route tatsächlich gesendete Code muss also aufgeführt sein. */
const simpleErrorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
} as const

const meSchema = {
  tags: ['auth'],
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        displayName: { type: 'string' },
        connections: {
          type: 'object',
          properties: {
            forgejo: { type: 'boolean' },
            github: { type: 'boolean' },
          },
          required: ['forgejo', 'github'],
        },
        /** Verknüpft, aber vom Provider abgelehnt — muss neu verbunden werden (Issue #70). */
        expiredConnections: {
          type: 'object',
          properties: {
            forgejo: { type: 'boolean' },
            github: { type: 'boolean' },
          },
          required: ['forgejo', 'github'],
        },
      },
      required: ['id', 'email', 'displayName', 'connections', 'expiredConnections'],
    },
  },
} as const

function txCookieOptions(insecureCookies: boolean | undefined): Record<string, unknown> {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !insecureCookies,
    path: '/',
    maxAge: TX_TTL_SECONDS,
  }
}

function clearTxCookie(reply: FastifyReply, insecureCookies: boolean | undefined): void {
  reply.clearCookie(TX_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !insecureCookies,
    path: '/',
  })
}

/**
 * Registriert die OIDC-Auth-Routen. Wird von app.ts NUR aufgerufen, wenn
 * `opts.auth.oidc` konfiguriert ist — ohne OIDC bleiben diese Routen
 * unregistriert (Plan Global Constraints: Bestandsverhalten unverändert).
 *
 * Discovery läuft einmalig beim Boot (innerhalb der async-Plugin-Registrierung);
 * ist der IdP dabei nicht erreichbar, scheitert `app.ready()` — Fail-Fast statt
 * halb funktionsfähiger Login.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const cookieOpts: SessionCookieOptions = { insecureCookies: deps.insecureCookies }

  app.register(async (instance) => {
    const config = await discoverOidc(deps.oidc, { allowInsecure: deps.oidcAllowInsecure })
    const rt: OidcRuntime = { config, oidc: deps.oidc }

    // GET /auth/login → 302 zum IdP; state/nonce/code_verifier im signierten Cookie.
    instance.get(
      '/auth/login',
      {
        schema: { tags: ['auth'], response: { 429: errorSchema } },
        config: { rateLimit: { max: deps.rateLimit.max, timeWindow: deps.rateLimit.windowMs } },
      },
      async (req, reply) => {
        const next = sanitizeNext((req.query as Record<string, unknown>).next)
        // Anmeldung auf der öffentlichen Adresse beginnen: Der IdP springt auf
        // `redirectUrl` zurück, und nur dort findet der Rücksprung das
        // Login-Cookie (s. `AuthRoutesDeps.publicBaseUrl`).
        if (deps.publicBaseUrl) {
          const oeffentlich = new URL(deps.publicBaseUrl)
          const forwarded = req.headers['x-forwarded-host']
          const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host
          if (host && host !== oeffentlich.host) {
            return reply.redirect(`${oeffentlich.origin}/auth/login?next=${encodeURIComponent(next)}`, 302)
          }
        }
        const { url, tx } = await buildLoginUrl(rt, next)
        reply.setCookie(TX_COOKIE_NAME, JSON.stringify(tx), txCookieOptions(deps.insecureCookies))
        return reply.redirect(url, 302)
      },
    )

    // GET /auth/callback?code&state → Code-Tausch, ID-Token-Validierung, Session.
    instance.get(
      '/auth/callback',
      {
        schema: { tags: ['auth'], response: { 400: simpleErrorSchema, 429: errorSchema } },
        config: { rateLimit: { max: deps.rateLimit.max, timeWindow: deps.rateLimit.windowMs } },
      },
      async (req, reply) => {
        const rawTx = req.cookies[TX_COOKIE_NAME]
        const unsigned = rawTx ? reply.unsignCookie(rawTx) : { valid: false, value: null }
        // Fehlschläge führen zur Startseite mit Meldung statt zu einer
        // JSON-Antwort: Hier steht ein Mensch im Browser, kein API-Client.
        if (!unsigned.valid || !unsigned.value) {
          clearTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/?anmeldung=abgelaufen', 302)
        }

        let tx: { state: string; nonce: string; codeVerifier: string; next: string }
        try {
          tx = JSON.parse(unsigned.value)
        } catch {
          clearTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/?anmeldung=abgelaufen', 302)
        }

        // currentUrl aus der registrierten redirect_uri + eingehenden Query rekonstruieren
        // (öffentliche Basis-URL ist maßgeblich, nicht der interne req.host).
        const currentUrl = new URL(deps.oidc.redirectUrl)
        const incoming = new URL(req.url, 'http://internal.invalid')
        currentUrl.search = incoming.search

        let identity: Awaited<ReturnType<typeof completeLogin>>
        try {
          identity = await completeLogin(rt, currentUrl, tx)
        } catch (err) {
          // Bewusst generische Meldung — KEINE Token-/Code-Werte nach außen (Plan).
          req.log.warn(
            { err: err instanceof Error ? err.message : 'unbekannt' },
            'oidc/callback: Code-Tausch oder ID-Token-Validierung fehlgeschlagen',
          )
          clearTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/?anmeldung=fehlgeschlagen', 302)
        }

        // User-Upsert: sub → id (kein Duplikat bei Wiederanmeldung).
        await deps.db
          .insert(users)
          .values({ id: identity.sub, email: identity.email, displayName: identity.displayName })
          .onConflictDoUpdate({
            target: users.id,
            set: { email: identity.email, displayName: identity.displayName },
          })

        if (deps.sharedForgejoGrant) {
          const { tokenKey, connect } = deps.sharedForgejoGrant
          try {
            const [linked] = await deps.db
              .select({ userId: providerAccounts.userId })
              .from(providerAccounts)
              .where(and(eq(providerAccounts.userId, identity.sub), eq(providerAccounts.provider, 'forgejo')))
            if (linked) {
              await updateProviderTokens(deps.db, identity.sub, 'forgejo', identity.tokens, tokenKey)
              invalidateUserPermissions(identity.sub)
            } else {
              const login = await fetchConnectLogin('forgejo', connect, identity.tokens.accessToken)
              await upsertProviderAccount(deps.db, identity.sub, 'forgejo', login, identity.tokens, tokenKey)
            }
          } catch (err) {
            // Die Anmeldung selbst ist gültig — sie scheitert nicht an der Verknüpfung.
            req.log.warn(
              { err: err instanceof Error ? err.message : 'unbekannt' },
              'oidc/callback: Forgejo-Verknüpfung nicht angelegt/aufgefrischt',
            )
          }
        }

        const session = await createSession(deps.db, identity.sub)
        clearTxCookie(reply, deps.insecureCookies)
        setSessionCookie(reply, session.id, cookieOpts)
        return reply.redirect(sanitizeNext(tx.next), 302)
      },
    )

    // POST /auth/logout → Session zerstören + Cookie löschen (CSRF-sicher: POST + SameSite).
    instance.post(
      '/auth/logout',
      {
        schema: { tags: ['auth'], response: { 204: { type: 'null' }, 429: errorSchema } },
        config: { rateLimit: { max: deps.rateLimit.max, timeWindow: deps.rateLimit.windowMs } },
      },
      async (req, reply) => {
        const sid = req.cookies[SESSION_COOKIE_NAME]
        if (sid) await destroySession(deps.db, sid)
        clearSessionCookie(reply, cookieOpts)
        return reply.code(204).send()
      },
    )
  })
}

/** One way to sign in, as offered on the sign-in page. `label` null → the UI's
 *  neutral wording. */
export interface SignInMethod {
  id: 'oidc' | 'github'
  href: string
  label: string | null
}

const methodsSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        methods: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              href: { type: 'string' },
              label: { type: ['string', 'null'] },
            },
            required: ['id', 'href', 'label'],
          },
        },
      },
      required: ['methods'],
    },
  },
} as const

/**
 * `GET /auth/methods` (#8): which sign-in methods this instance offers. Public —
 * the sign-in page needs it before anyone is signed in; it reveals only what the
 * sign-in page shows anyway.
 */
export function registerAuthMethodsRoute(app: FastifyInstance, deps: { methods: SignInMethod[] }): void {
  app.get('/auth/methods', { schema: methodsSchema }, async () => ({ methods: deps.methods }))
}

/**
 * Registriert `GET /api/me` unabhängig von OIDC: der Endpoint spiegelt nur den
 * aktuellen Session-/Verknüpfungsstand aus der DB, unabhängig davon, wie die
 * Session zustande kam (OIDC-Login in Produktion; in Tests z. B. auch direkt
 * über `createSession`, siehe Task 4 — Connect-Tests ohne Mock-IdP).
 */
export function registerMeRoute(app: FastifyInstance, deps: MeRouteDeps): void {
  app.register(async (instance) => {
    instance.get('/api/me', { schema: meSchema, preHandler: requireSession }, async (req) => {
      const user = req.user!
      const accounts = await deps.db
        .select({ provider: providerAccounts.provider, needsReconnect: providerAccounts.needsReconnect })
        .from(providerAccounts)
        .where(eq(providerAccounts.userId, user.id))
      const linked = new Set(accounts.map((a) => a.provider))
      const expired = new Set(accounts.filter((a) => a.needsReconnect).map((a) => a.provider))
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        connections: {
          forgejo: linked.has('forgejo'),
          github: linked.has('github'),
        },
        expiredConnections: {
          forgejo: expired.has('forgejo'),
          github: expired.has('github'),
        },
      }
    })
  })
}

/** Kurzlebiges, signiertes Cookie für den Connect-OAuth-Kontext (state + Provider). */
const CONNECT_TX_COOKIE_NAME = `${COOKIE_PREFIX}_connect_tx`
const CONNECT_TX_TTL_SECONDS = 10 * 60

interface ConnectTransaction {
  state: string
  provider: string
}

/**
 * Konstant-Zeit-Vergleich für den `state`-Parameter (Review-Nachzug): ein
 * gewöhnlicher `===`-Vergleich verrät über die Antwortzeit, an welcher Stelle
 * zwei Strings voneinander abweichen — ein Timing-Seitenkanal für den
 * CSRF-Schutz. Längen-Guard zuerst, da `timingSafeEqual` bei ungleicher
 * Pufferlänge wirft statt `false` zu liefern.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function connectTxCookieOptions(insecureCookies: boolean | undefined): Record<string, unknown> {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !insecureCookies,
    path: '/',
    maxAge: CONNECT_TX_TTL_SECONDS,
  }
}

function clearConnectTxCookie(reply: FastifyReply, insecureCookies: boolean | undefined): void {
  reply.clearCookie(CONNECT_TX_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !insecureCookies,
    path: '/',
  })
}

/**
 * Baut die `redirect_uri`, die dem Provider beim Authorize- und beim
 * Token-Tausch mitgegeben wird. Task 3 (Auth-Härtung M1, Spec §7): In
 * Produktion ist `deps.publicBaseUrl` (`F451_PUBLIC_BASE_URL`) gesetzt — nur
 * DANN als Basis verwenden (trailing Slashes entfernt, damit sich kein
 * doppelter Slash vor `/auth/connect/...` einschleicht). Ohne konfigurierte
 * `publicBaseUrl` bleibt der bisherige Host-Header-Fallback (Dev-Betrieb ohne
 * gesetzte Env-Variable) — der Host-Header ist Angreifer-kontrollierbar
 * (Request-Smuggling/Cache-Poisoning-Vektor über eine manipulierte
 * `redirect_uri`), weshalb Produktion NIE stillschweigend darauf zurückfallen
 * darf, sobald eine feste Basis-URL konfiguriert ist.
 */
function buildConnectRedirectUri(deps: ConnectRoutesDeps, req: FastifyRequest, provider: string): string {
  const base = deps.publicBaseUrl?.replace(/\/+$/, '') ?? `${req.protocol}://${req.hostname}`
  return `${base}/auth/connect/${provider}/callback`
}

/**
 * Registriert die Provider-Verknüpfungs-Routen (Plan Task 4). Wird von
 * app.ts NUR aufgerufen, wenn `opts.auth.connect` konfiguriert ist.
 */
export function registerConnectRoutes(app: FastifyInstance, deps: ConnectRoutesDeps): void {
  app.register(async (instance) => {
    // GET /auth/connect/:provider → 302 zum Provider-OAuth; state im signierten Cookie.
    instance.get<{ Params: { provider: string } }>(
      '/auth/connect/:provider',
      {
        schema: { tags: ['auth'], response: { 404: simpleErrorSchema, 429: errorSchema } },
        preHandler: requireSession,
        config: { rateLimit: { max: deps.rateLimit.max, timeWindow: deps.rateLimit.windowMs } },
      },
      async (req, reply) => {
        const { provider } = req.params
        if (!isConnectProvider(provider)) {
          return reply.code(404).send({ error: 'Unbekannter Provider.' })
        }
        const providerConfig = getProviderConfig(deps.connect, provider)
        if (!providerConfig) {
          return reply.code(404).send({ error: 'Dieser Provider ist nicht für die Verknüpfung konfiguriert.' })
        }

        const state = generateConnectState()
        const redirectUri = buildConnectRedirectUri(deps, req, provider)
        const url = buildConnectAuthorizeUrl(provider, deps.connect, redirectUri, state)

        const tx: ConnectTransaction = { state, provider }
        reply.setCookie(CONNECT_TX_COOKIE_NAME, JSON.stringify(tx), connectTxCookieOptions(deps.insecureCookies))
        return reply.redirect(url, 302)
      },
    )

    // GET /auth/connect/:provider/callback → Token-Tausch, Login-Abruf, verschlüsselte Ablage.
    instance.get<{ Params: { provider: string } }>(
      '/auth/connect/:provider/callback',
      {
        schema: {
          tags: ['auth'],
          response: { 400: simpleErrorSchema, 404: simpleErrorSchema, 429: errorSchema },
        },
        preHandler: requireSession,
        config: { rateLimit: { max: deps.rateLimit.max, timeWindow: deps.rateLimit.windowMs } },
      },
      async (req, reply) => {
        const { provider } = req.params
        if (!isConnectProvider(provider)) {
          return reply.code(404).send({ error: 'Unbekannter Provider.' })
        }
        const providerConfig = getProviderConfig(deps.connect, provider)
        if (!providerConfig) {
          return reply.code(404).send({ error: 'Dieser Provider ist nicht für die Verknüpfung konfiguriert.' })
        }

        const rawTx = req.cookies[CONNECT_TX_COOKIE_NAME]
        const unsigned = rawTx ? reply.unsignCookie(rawTx) : { valid: false, value: null }
        if (!unsigned.valid || !unsigned.value) {
          clearConnectTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/einstellungen/verbindungen?verbindung=abgelaufen', 302)
        }

        let tx: ConnectTransaction
        try {
          tx = JSON.parse(unsigned.value)
        } catch {
          clearConnectTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/einstellungen/verbindungen?verbindung=abgelaufen', 302)
        }

        const query = req.query as Record<string, string | undefined>
        if (tx.provider !== provider || !query.state || !timingSafeEqualString(query.state, tx.state)) {
          clearConnectTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/einstellungen/verbindungen?verbindung=fehlgeschlagen', 302)
        }

        const code = query.code
        if (!code) {
          clearConnectTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/einstellungen/verbindungen?verbindung=fehlgeschlagen', 302)
        }

        const redirectUri = buildConnectRedirectUri(deps, req, provider)

        let tokens: ProviderTokens
        try {
          tokens = await exchangeConnectCode(provider, deps.connect, code, redirectUri)
        } catch (err) {
          // Bewusst generische Meldung — KEINE Token-/Code-Werte nach außen (Plan).
          req.log.warn(
            { err: err instanceof Error ? err.message : 'unbekannt', provider },
            'connect/callback: Token-Tausch fehlgeschlagen',
          )
          clearConnectTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/einstellungen/verbindungen?verbindung=fehlgeschlagen', 302)
        }

        let login: string
        try {
          login = await fetchConnectLogin(provider, deps.connect, tokens.accessToken)
        } catch (err) {
          req.log.warn(
            { err: err instanceof Error ? err.message : 'unbekannt', provider },
            'connect/callback: Abruf des Provider-Nutzers fehlgeschlagen',
          )
          clearConnectTxCookie(reply, deps.insecureCookies)
          return reply.redirect('/einstellungen/verbindungen?verbindung=fehlgeschlagen', 302)
        }

        await upsertProviderAccount(deps.db, req.user!.id, provider, login, tokens, deps.tokenKey)
        clearConnectTxCookie(reply, deps.insecureCookies)
        return reply.redirect('/', 302)
      },
    )

    // DELETE /auth/connect/:provider → Verknüpfung entfernen.
    instance.delete<{ Params: { provider: string } }>(
      '/auth/connect/:provider',
      {
        schema: {
          tags: ['auth'],
          response: { 204: { type: 'null' }, 404: simpleErrorSchema, 429: errorSchema },
        },
        preHandler: requireSession,
        config: { rateLimit: { max: deps.rateLimit.max, timeWindow: deps.rateLimit.windowMs } },
      },
      async (req, reply) => {
        const { provider } = req.params
        if (!isConnectProvider(provider)) {
          return reply.code(404).send({ error: 'Unbekannter Provider.' })
        }
        await deleteProviderAccount(deps.db, req.user!.id, provider)
        return reply.code(204).send()
      },
    )
  })
}
