import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { providerAccounts } from '../db/schema.js'
import { decryptToken, encryptToken } from './crypto.js'
import { invalidateUserPermissions } from './permissions.js'

/**
 * Forgejo-/GitHub-Kontoverknüpfung (Plan Task 4): OAuth-Token-Tausch, Abruf des
 * Provider-Login-Namens und verschlüsselte Ablage in `provider_accounts`.
 * Tokens werden NIE im Klartext geloggt oder in Fehlermeldungen erwähnt
 * (Plan Global Constraints) — Fetch-Fehler geben daher nur Status/Provider
 * preis, nie Response-Bodies, die ein Token enthalten könnten.
 */

export type ConnectProvider = 'forgejo' | 'github'

export interface ForgejoConnectConfig {
  /** Basis-URL der Forgejo-Instanz (ohne /api/v1), z. B. https://git.example.com. */
  baseUrl: string
  clientId: string
  clientSecret: string
}

export interface GithubConnectConfig {
  clientId: string
  clientSecret: string
}

export interface ConnectOptions {
  forgejo?: ForgejoConnectConfig
  github?: GithubConnectConfig
}

const USER_AGENT = 'f451'
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
// Exportiert (Task 4b/4, `auth/token-refresh.ts`): derselbe Endpoint wird für
// den (bei GitHub praktisch nie erreichten, aber der Vollständigkeit halber
// unterstützten) Refresh-Grant wiederverwendet statt dupliziert.
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
// Issue #8 (GitHub sign-in): only reachable when the access token carries the
// `user:email` scope — see `fetchGithubLoginProfile` below.
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

export function isConnectProvider(value: string): value is ConnectProvider {
  return value === 'forgejo' || value === 'github'
}

/** Liefert die Provider-Konfiguration, falls dieser Provider konfiguriert ist. */
export function getProviderConfig(
  connect: ConnectOptions,
  provider: ConnectProvider,
): ForgejoConnectConfig | GithubConnectConfig | undefined {
  return provider === 'forgejo' ? connect.forgejo : connect.github
}

/** Zufälliger `state`-Wert für den Connect-OAuth-Flow (128 bit, base64url). */
export function generateConnectState(): string {
  return randomBytes(16).toString('base64url')
}

/** Baut die Authorize-Redirect-URL für den gewählten Provider. Wirft, wenn der Provider nicht konfiguriert ist.
 *  `scope` (Issue #8, GitHub sign-in): überschreibt den GitHub-Default `repo read:user`
 *  — der Sign-in-Flow (`routes/auth.ts#registerGithubLoginRoutes`) braucht zusätzlich
 *  `user:email`, um im Callback eine Mailadresse abrufen zu können. Ohne Angabe
 *  bleibt das bisherige Connect-Verhalten unverändert. Für Forgejo ohne Wirkung
 *  (Forgejo kennt keine Scope-Einschränkung im Authorize-Request). */
export function buildConnectAuthorizeUrl(
  provider: ConnectProvider,
  connect: ConnectOptions,
  redirectUri: string,
  state: string,
  scope?: string,
): string {
  if (provider === 'github') {
    const config = connect.github
    if (!config) throw new Error('GitHub-Kontoverknüpfung ist nicht konfiguriert.')
    const url = new URL(GITHUB_AUTHORIZE_URL)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('scope', scope ?? 'repo read:user')
    return url.href
  }

  const config = connect.forgejo
  if (!config) throw new Error('Forgejo-Kontoverknüpfung ist nicht konfiguriert.')
  const url = new URL('/login/oauth/authorize', config.baseUrl)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  return url.href
}

export interface ProviderTokens {
  accessToken: string
  refreshToken?: string
}

/** Tauscht den Authorization-Code gegen ein Access-Token. Wirft bei jedem Fehlschlag — nie den Code/Token im Fehlertext. */
export async function exchangeConnectCode(
  provider: ConnectProvider,
  connect: ConnectOptions,
  code: string,
  redirectUri: string,
): Promise<ProviderTokens> {
  if (provider === 'github') {
    const config = connect.github
    if (!config) throw new Error('GitHub-Kontoverknüpfung ist nicht konfiguriert.')
    const res = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`GitHub-Token-Tausch fehlgeschlagen (Status ${res.status}).`)
    const data = (await res.json()) as { access_token?: string; error?: string }
    // GitHub antwortet bei Fehlern mit HTTP 200 + {error, error_description} statt eines Fehlerstatus.
    if (!data.access_token || data.error) {
      throw new Error('GitHub-Token-Tausch fehlgeschlagen (kein Access-Token in der Antwort).')
    }
    return { accessToken: data.access_token }
  }

  const config = connect.forgejo
  if (!config) throw new Error('Forgejo-Kontoverknüpfung ist nicht konfiguriert.')
  const tokenUrl = new URL('/login/oauth/access_token', config.baseUrl)
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) throw new Error(`Forgejo-Token-Tausch fehlgeschlagen (Status ${res.status}).`)
  const data = (await res.json()) as { access_token?: string; refresh_token?: string }
  if (!data.access_token) {
    throw new Error('Forgejo-Token-Tausch fehlgeschlagen (kein Access-Token in der Antwort).')
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token }
}

/** Holt den Provider-Login-Namen des Nutzers per API (User-Agent-Header ist für GitHub Pflicht). */
export async function fetchConnectLogin(
  provider: ConnectProvider,
  connect: ConnectOptions,
  accessToken: string,
): Promise<string> {
  const url =
    provider === 'github'
      ? GITHUB_USER_URL
      : (() => {
          const config = connect.forgejo
          if (!config) throw new Error('Forgejo-Kontoverknüpfung ist nicht konfiguriert.')
          return new URL('/api/v1/user', config.baseUrl).href
        })()

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json',
      'User-Agent': USER_AGENT,
    },
  })
  if (!res.ok) throw new Error(`Abruf des Provider-Nutzers fehlgeschlagen (Status ${res.status}).`)
  const data = (await res.json()) as { login?: string }
  if (!data.login) throw new Error('Abruf des Provider-Nutzers fehlgeschlagen (kein login-Feld in der Antwort).')
  return data.login
}

/** The profile fields GitHub sign-in needs (Issue #8) — a superset of what
 *  {@link fetchConnectLogin} returns for the connect flow. */
export interface GithubLoginProfile {
  id: number
  login: string
  name: string | null
  email: string
}

/**
 * Fetches the GitHub profile for sign-in (#8): id, login, display name and an
 * email address. GitHub omits `email` from `GET /user` unless the account has
 * a public address; in that case a second call to `GET /user/emails` (needs
 * the `user:email` scope, see `buildConnectAuthorizeUrl`) resolves the
 * primary, verified address. Falls back to an empty string if even that
 * yields nothing (e.g. no verified email at all) — sign-in must not depend on
 * a GitHub email being present. Throws only when `id`/`login` themselves are
 * missing; a failed or empty emails lookup is not fatal.
 */
export async function fetchGithubLoginProfile(accessToken: string): Promise<GithubLoginProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  }

  const res = await fetch(GITHUB_USER_URL, { headers })
  if (!res.ok) throw new Error(`Abruf des GitHub-Nutzers fehlgeschlagen (Status ${res.status}).`)
  const data = (await res.json()) as { id?: number; login?: string; name?: string | null; email?: string | null }
  if (typeof data.id !== 'number' || !data.login) {
    throw new Error('Abruf des GitHub-Nutzers fehlgeschlagen (unvollständige Antwort).')
  }

  let email = data.email ?? ''
  if (!email) {
    const emailsRes = await fetch(GITHUB_EMAILS_URL, { headers })
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>
      email = emails.find((entry) => entry.primary && entry.verified)?.email ?? ''
    }
  }

  return { id: data.id, login: data.login, name: data.name ?? null, email }
}

/**
 * Legt die Verknüpfung an oder ersetzt eine bestehende (gleicher User+Provider) —
 * Tokens werden verschlüsselt abgelegt. Invalidiert außerdem den
 * Berechtigungs-Cache des Nutzers (Plan Task 5, analog zu `deleteProviderAccount`):
 * ohne verknüpftes Konto ist jeder Space für diesen Nutzer nicht lesbar, und
 * dieses negative Ergebnis wird — wie jede Probe — bis zu 5 min gecacht (z. B.
 * durch einen `/api/spaces`-Aufruf kurz vor dem Connect). Ohne Invalidierung
 * bliebe ein Space nach erfolgreicher Verknüpfung bis zu 5 min unsichtbar,
 * obwohl der Zugriff jetzt sofort möglich wäre.
 */
export async function upsertProviderAccount(
  db: Db,
  userId: string,
  provider: ConnectProvider,
  providerLogin: string,
  tokens: ProviderTokens,
  tokenKey: string,
): Promise<void> {
  const encryptedAccessToken = encryptToken(tokens.accessToken, tokenKey)
  const encryptedRefreshToken = tokens.refreshToken ? encryptToken(tokens.refreshToken, tokenKey) : null

  await db
    .insert(providerAccounts)
    .values({ userId, provider, providerLogin, encryptedAccessToken, encryptedRefreshToken })
    .onConflictDoUpdate({
      target: [providerAccounts.userId, providerAccounts.provider],
      set: { providerLogin, encryptedAccessToken, encryptedRefreshToken, needsReconnect: false, updatedAt: new Date() },
    })
  invalidateUserPermissions(userId)
}

/**
 * Entfernt eine Verknüpfung. Kein Fehler, wenn sie nicht (mehr) existiert.
 * Invalidiert außerdem den Berechtigungs-Cache des Nutzers (Plan Task 5), damit
 * ein zuvor als lesbar gecachter Space nach dem Disconnect nicht bis zu 5 min
 * sichtbar bleibt.
 */
export async function deleteProviderAccount(db: Db, userId: string, provider: ConnectProvider): Promise<void> {
  await db
    .delete(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
  invalidateUserPermissions(userId)
}

/**
 * Der Accessor für Task 5 (Berechtigungs-Vererbung) und später den Workflow
 * (Phase 2): liefert das entschlüsselte Access-Token des Nutzers für den
 * angegebenen Provider, oder `null`, wenn keine Verknüpfung besteht.
 */
export async function getUserProviderToken(
  db: Db,
  userId: string,
  provider: ConnectProvider,
  tokenKey: string,
): Promise<string | null> {
  const rows = await db
    .select({ encryptedAccessToken: providerAccounts.encryptedAccessToken })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
  const row = rows[0]
  if (!row) return null
  return decryptToken(row.encryptedAccessToken, tokenKey)
}

/**
 * Wie {@link getUserProviderToken}, liefert aber ZUSÄTZLICH den entschlüsselten
 * Refresh-Token (Task 4b/4, `auth/token-refresh.ts`) — `refreshToken: null`,
 * wenn keiner gespeichert ist (kein Refresh möglich, z. B. GitHub, dessen
 * `exchangeConnectCode`-Zweig oben nie einen `refresh_token` anfordert).
 */
export async function getUserProviderTokens(
  db: Db,
  userId: string,
  provider: ConnectProvider,
  tokenKey: string,
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  const rows = await db
    .select({
      encryptedAccessToken: providerAccounts.encryptedAccessToken,
      encryptedRefreshToken: providerAccounts.encryptedRefreshToken,
    })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
  const row = rows[0]
  if (!row) return null
  return {
    accessToken: decryptToken(row.encryptedAccessToken, tokenKey),
    refreshToken: row.encryptedRefreshToken ? decryptToken(row.encryptedRefreshToken, tokenKey) : null,
  }
}

/**
 * Persistiert nach einem erfolgreichen Token-Refresh (Task 4b/4) die neuen
 * Tokens verschlüsselt — im Unterschied zu {@link upsertProviderAccount} OHNE
 * `providerLogin` (der Refresh-Grant liefert keinen neuen Login-Namen, der
 * bestehende bleibt unangetastet) und OHNE Insert-Zweig (die Zeile muss
 * bereits existieren, sonst hätte es keinen Refresh-Token gegeben, den man
 * hätte einlösen können). Liefert der Provider keinen neuen `refresh_token`
 * zurück (nicht rotierend), bleibt die gespeicherte Spalte unverändert statt
 * auf `null` gesetzt zu werden — sonst würde ein NICHT rotierender Provider
 * nach dem ersten Refresh jeden weiteren Refresh unmöglich machen.
 */
export async function updateProviderTokens(
  db: Db,
  userId: string,
  provider: ConnectProvider,
  tokens: ProviderTokens,
  tokenKey: string,
): Promise<void> {
  const setFields: Partial<typeof providerAccounts.$inferInsert> = {
    encryptedAccessToken: encryptToken(tokens.accessToken, tokenKey),
    needsReconnect: false,
    updatedAt: new Date(),
  }
  if (tokens.refreshToken) {
    setFields.encryptedRefreshToken = encryptToken(tokens.refreshToken, tokenKey)
  }

  await db
    .update(providerAccounts)
    .set(setFields)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
}

/**
 * Markiert die Verknüpfung als „muss neu hergestellt werden" (Issue #70):
 * der Provider hat den Refresh-Token abgelehnt, ohne Mensch im Browser gibt es
 * keinen Weg zurück. `/api/me` liefert das Kennzeichen an die Oberfläche aus;
 * der nächste erfolgreiche Token-Tausch setzt es zurück.
 */
export async function markNeedsReconnect(db: Db, userId: string, provider: ConnectProvider): Promise<void> {
  await db
    .update(providerAccounts)
    .set({ needsReconnect: true })
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
}
