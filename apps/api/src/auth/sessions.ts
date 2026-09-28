import { eq, lt } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/client.js'
import type { ConnectOptions } from './connect.js'
import { apiTokens, sessions, users } from '../db/schema.js'
import { generateSessionId, hashApiToken, isApiToken } from './crypto.js'

/**
 * Sessions sind flüchtige Betriebsdaten (Plan Global Constraints): TTL 7 Tage,
 * Sliding-Refresh bei weniger als 50 % Rest-TTL, abgelaufene Sessions werden
 * beim Zugriff gelöscht statt nur ignoriert (kein "toter" Datenmüll).
 */

/**
 * Prefix for all auth cookies (session and login/connect transactions).
 * Browsers do not separate cookies by port, so two instances on the same host
 * (e.g. a demo stack next to the dev stack) would overwrite each other's
 * session. Setting F451_COOKIE_PREFIX per instance keeps them apart.
 */
export const COOKIE_PREFIX = cookiePrefix(process.env.F451_COOKIE_PREFIX)

export function cookiePrefix(value: string | undefined): string {
  if (!value) return 'f451'
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`F451_COOKIE_PREFIX may only contain letters, digits, "_" and "-": ${value}`)
  }
  return value
}

export const SESSION_COOKIE_NAME = `${COOKIE_PREFIX}_session`

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SLIDING_REFRESH_RATIO = 0.5

/** Cookie-`maxAge` in Sekunden, passend zur Session-TTL in der DB (Review-
 *  Nachzug): ohne `maxAge` wäre es ein Browser-Session-Cookie, das beim
 *  Schließen des Browsers verschwindet, obwohl die Session in der DB dank
 *  Sliding-Refresh bis zu 7 Tage weiterlebt — der Nutzer müsste sich dann
 *  öfter neu anmelden, als die Session eigentlich gültig ist. Persistentes
 *  Cookie mit derselben Lebensdauer wie die Server-Session behebt das. */
const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000

export interface SessionRecord {
  id: string
  expiresAt: Date
}

export interface SessionLookup {
  userId: string
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Aus dem Session-Cookie ODER (Fallback, MCP-Phase 0) einem gültigen
     * `Authorization: Bearer f451_pat_<...>`-API-Token geladen (onRequest-
     * Hook, siehe app.ts). Nur gesetzt, wenn `opts.auth` beim App-Bau
     * konfiguriert ist — ohne Auth-Konfiguration wird der Hook gar nicht
     * erst registriert, sodass Bestandsverhalten (1c) unverändert bleibt.
     */
    user: AuthUser | null
    /**
     * MCP-Phase 0: Scope des API-Tokens, über das `req.user` (falls
     * überhaupt) aufgelöst wurde — `null` bei Session-Cookie-Auth (oder ganz
     * ohne Auth). Steuert das Schreib-Gate in `app.ts` (Nur-Lese-Tokens
     * dürfen keine mutierenden Requests auslösen) UND das Bootstrapping-
     * Verbot der Token-Verwaltungsrouten (`routes/tokens.ts`
     * #requireBrowserSession — ein API-Token darf sich nicht selbst weitere
     * Tokens ausstellen/einsehen/widerrufen).
     */
    apiTokenScope: 'read' | 'write' | null
  }
}

/** Legt eine neue Session mit 7 Tagen TTL an. */
export async function createSession(db: Db, userId: string): Promise<SessionRecord> {
  const id = generateSessionId()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(sessions).values({ id, userId, expiresAt })
  return { id, expiresAt }
}

/**
 * Lädt eine Session anhand ihrer Id. Abgelaufene Sessions werden beim Zugriff
 * gelöscht (Rückgabe `null`) statt nur ignoriert. Sliding-Refresh: ist weniger
 * als die Hälfte der TTL übrig, wird `expiresAt` auf eine neue volle TTL
 * verlängert (Plan Global Constraints).
 */
export async function getSession(db: Db, id: string): Promise<SessionLookup | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id))
  const session = rows[0]
  if (!session) return null

  const now = Date.now()
  if (session.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return null
  }

  // Task 3 (Auth-Härtung M4, Spec §7 — verifiziert, siehe Backlog Phase 1d):
  // der Refresh setzt `expiresAt` auf eine VOLLE neue TTL (nicht nur eine
  // kleine Verlängerung), also ist die Session nach diesem Schreiben wieder
  // bei 100% Rest-TTL. Der `remainingMs < TTL/2`-Zweig greift dadurch pro
  // Session frühestens wieder in TTL/2 (3,5 Tage) — ein UPDATE pro Request in
  // der zweiten TTL-Hälfte, wie ursprünglich befürchtet, tritt NICHT ein.
  // Eine zusätzliche Drossel-Bedingung (nur schreiben, wenn die Verlängerung
  // ≥ 1h Zugewinn bringt) wäre hier gegenstandslos, da der schlechteste Fall
  // bereits "höchstens alle 3,5 Tage ein UPDATE pro aktiver Session" ist —
  // deutlich unter jeder relevanten Schreiblast-Schwelle. Kein Code-Fix nötig,
  // siehe `test/auth-hardening.test.ts` für die Verifikation (zwei schnelle
  // Folge-Requests in derselben Refresh-Phase erzeugen genau EIN UPDATE, weil
  // der erste Aufruf die Session sofort wieder auf 100% Rest-TTL hebt).
  const remainingMs = session.expiresAt.getTime() - now
  if (remainingMs < SESSION_TTL_MS * SLIDING_REFRESH_RATIO) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, id))
  }

  return { userId: session.userId }
}

/** Beendet eine Session (Logout). Kein Fehler, wenn sie nicht (mehr) existiert. */
export async function destroySession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id))
}

/**
 * Task 3 (Auth-Härtung M3, Spec §7): löscht alle abgelaufenen Sessions
 * (`expiresAt < jetzt`) unabhängig von einem Zugriff — ohne diesen Sweep
 * bleiben Sessions, die nie erneut abgerufen werden (Nutzer kommt einfach
 * nicht wieder), bis in alle Ewigkeit als "toter" Datenmüll in der Tabelle
 * stehen (der Lösch-Pfad in `getSession` greift nur BEIM Zugriff). Liefert
 * die Anzahl gelöschter Zeilen (Beobachtbarkeit fürs Sweeper-Log in
 * `server.ts`). `.returning()` statt `rowCount` (Muster `routes/locks.ts`) —
 * treiberunabhängig zählbar, ohne Annahmen über das pg-Rückgabeformat.
 */
export async function deleteExpiredSessions(db: Db): Promise<number> {
  const deleted = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({ id: sessions.id })
  return deleted.length
}

async function loadUser(db: Db, userId: string): Promise<AuthUser | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId))
  const user = rows[0]
  if (!user) return null
  return { id: user.id, email: user.email, displayName: user.displayName }
}

/** Wie der Admin-Bearer-Check (`routes/admin.ts#extractBearerToken`) — hier
 *  eigenständig, weil `auth/sessions.ts` nichts aus `routes/` importieren soll. */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/.exec(header)
  return match ? match[1]! : null
}

/** Nur, damit `lastUsedAt` nicht bei JEDEM Request geschrieben wird (analog
 *  der Sliding-Refresh-Drossel bei Sessions oben) — ein API-Token, das ein
 *  MCP-Server im Sekundentakt nutzt, würde sonst pro Aufruf ein UPDATE auslösen. */
const LAST_USED_THROTTLE_MS = 60_000

export interface ApiTokenLookup {
  user: AuthUser
  scope: 'read' | 'write'
}

/**
 * MCP-Phase 0: löst ein `Authorization: Bearer f451_pat_<...>`-Token auf
 * einen Nutzer + Scope auf. `null`, wenn das Token unbekannt, widerrufen
 * oder abgelaufen ist, oder der referenzierte User fehlt (Fail-Closed —
 * jeder dieser Fälle degradiert zu „nicht authentifiziert", nie zu einem
 * geöffneten Zugriff). Vergleich läuft über den Unique-Index auf
 * `tokenHash` (DB-Lookup auf den SHA-256-Hash) — kein direkter String-
 * Vergleich mit dem Klartext nötig, der Hash IST bereits der eindeutige
 * Schlüssel.
 */
export async function resolveApiTokenUser(db: Db, token: string): Promise<ApiTokenLookup | null> {
  const tokenHash = hashApiToken(token)
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash))
  const record = rows[0]
  if (!record) return null

  const now = Date.now()
  if (record.revokedAt) return null
  if (record.expiresAt && record.expiresAt.getTime() <= now) return null

  const user = await loadUser(db, record.userId)
  if (!user) return null

  if (!record.lastUsedAt || now - record.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await db.update(apiTokens).set({ lastUsedAt: new Date(now) }).where(eq(apiTokens.id, record.id))
  }

  const scope = record.scope === 'write' ? 'write' : 'read'
  return { user, scope }
}

/**
 * Baut den onRequest-Hook, der `req.user` (+ `req.apiTokenScope`) auflädt:
 * primär aus dem Session-Cookie, ODER (MCP-Phase 0, Fallback nur ohne
 * gültiges Cookie) aus einem `Authorization: Bearer f451_pat_<...>`-API-
 * Token. `null`/`null`, wenn keiner der beiden Wege einen gültigen Nutzer
 * liefert. Wird nur registriert, wenn `opts.auth` konfiguriert ist (siehe
 * app.ts).
 *
 * WICHTIG (Kollisionsfreiheit mit dem Admin-Bearer-Token, `routes/
 * admin.ts#hasValidAdminToken`): nur Bearer-Werte MIT dem `f451_pat_`-
 * Präfix (`isApiToken`) werden hier überhaupt als API-Token behandelt — ein
 * beliebiger, anders geformter Admin-Token fällt einfach durch (kein
 * Cookie, kein API-Token-Präfix → `req.user = null`) und wird ausschließlich
 * vom unabhängigen, eigenen Admin-Gate (`hasValidAdminToken`/
 * `requireAdminToken` in `app.ts`/`routes/admin.ts`) geprüft, das den rohen
 * Header-Wert direkt gegen `opts.adminToken` vergleicht — dieser Hook hat
 * darauf keinerlei Einfluss. Umgekehrt kann ein API-Token nie als Admin-
 * Token durchgehen: `hasValidAdminToken` vergleicht zeitkonstant gegen das
 * konfigurierte `F451_ADMIN_TOKEN`, ein `f451_pat_...`-Wert kann das nur
 * treffen, wenn ein Betreiber genau diesen String als Admin-Token
 * konfiguriert hätte (praktisch ausgeschlossen, siehe Test „Admin-Token ↔
 * API-Token Kollisionsfreiheit").
 */
export function createSessionAuthHook(db: Db): (req: FastifyRequest) => Promise<void> {
  return async function sessionAuthHook(req: FastifyRequest): Promise<void> {
    const cookieValue = req.cookies[SESSION_COOKIE_NAME]
    if (cookieValue) {
      const session = await getSession(db, cookieValue)
      req.user = session ? await loadUser(db, session.userId) : null
      req.apiTokenScope = null
      return
    }

    const bearer = extractBearerToken(req.headers.authorization)
    if (bearer && isApiToken(bearer)) {
      const resolved = await resolveApiTokenUser(db, bearer)
      req.user = resolved ? resolved.user : null
      req.apiTokenScope = resolved ? resolved.scope : null
      return
    }

    req.user = null
    req.apiTokenScope = null
  }
}

/** preHandler: verlangt eine gültige Session, sonst 401 JSON mit `WWW-Authenticate: session`. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    reply.header('WWW-Authenticate', 'session')
    // Projektweites {status,reason}-Format (Phase 4a) — konsistent mit dem
    // globalen Session-Gate in app.ts und admin.ts/webhooks.ts. Verhindert
    // dieselbe fast-json-stringify-Kollision (→ 500), sobald je eine
    // requireSession-Route ein `401: errorSchema` deklariert.
    await reply.code(401).send({ status: 'unauthorized', reason: 'Anmeldung erforderlich.' })
  }
}

/**
 * preHandler für die Token-Verwaltungsrouten (`routes/tokens.ts`,
 * `POST`/`GET`/`DELETE /api/tokens*`): verlangt eine ECHTE Browser-Session,
 * KEIN API-Token — kein Token darf sich selbst neue Tokens ausstellen,
 * einsehen oder widerrufen (kein Bootstrapping). `req.apiTokenScope` ist
 * ausschließlich bei API-Token-Auth gesetzt (`createSessionAuthHook` oben
 * lässt es bei Session-Cookie-Auth immer `null`), ein einfacher `!= null`-
 * Check genügt daher. Läuft VOR `requireSession` — deren 401 wäre
 * irreführend (das Token IST ja gültig, nur für diese Routen nicht
 * zugelassen), daher 403 statt 401.
 */
export async function requireBrowserSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.apiTokenScope != null) {
    await reply
      .code(403)
      .send({ status: 'forbidden', reason: 'Token-Verwaltung ist nur per Browser-Session möglich.' })
    return
  }
  await requireSession(req, reply)
}

export interface SessionCookieOptions {
  /** Dev-Modus (Plan Global Constraints, F451_INSECURE_COOKIES): `secure=false` statt `true`. */
  insecureCookies?: boolean
}

/** Setzt das Session-Cookie mit den Constraint-Attributen (httpOnly, sameSite=lax, secure je nach Modus, path=/). */
export function setSessionCookie(reply: FastifyReply, id: string, opts: SessionCookieOptions = {}): void {
  reply.setCookie(SESSION_COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !opts.insecureCookies,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  })
}

/** Löscht das Session-Cookie (Logout) mit denselben Attributen. */
export function clearSessionCookie(reply: FastifyReply, opts: SessionCookieOptions = {}): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !opts.insecureCookies,
    path: '/',
  })
}

export interface OidcAuthOptions {
  /** Issuer-URL des OpenID-Providers (Entra ID), Basis für Discovery. */
  issuer: string
  clientId: string
  clientSecret: string
  /** Öffentliche Callback-URL (`redirect_uri`), am IdP vorregistriert. */
  redirectUrl: string
}

export interface AuthOptions {
  /** Task 4: Schlüssel zur Provider-Token-Verschlüsselung (F451_TOKEN_KEY, 32 Byte base64). */
  tokenKey: string
  /** Dev-Modus: Cookies ohne `secure`-Flag (F451_INSECURE_COOKIES). */
  insecureCookies?: boolean
  /** Task 3 (Auth-Härtung M2, Spec §7): erlaubt http-Issuer bei der OIDC-Discovery
   *  (F451_OIDC_ALLOW_INSECURE), unabhängig von `insecureCookies` — siehe
   *  `routes/auth.ts#AuthRoutesDeps.oidcAllowInsecure`. */
  oidcAllowInsecure?: boolean
  /** Task 3 (OIDC-Login): ohne diese Angabe bleiben die Auth-Routen unregistriert. */
  oidc?: OidcAuthOptions
  /** Task 4 (Provider-Verknüpfung): ohne diese Angabe bleiben die Connect-Routen unregistriert. */
  connect?: ConnectOptions
}
