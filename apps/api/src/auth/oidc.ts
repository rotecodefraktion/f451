import * as client from 'openid-client'

/**
 * OIDC-Login (Entra ID / generischer OpenID-Provider) mit PKCE (S256), `state`
 * und `nonce` (Plan Task 3). Kapselt die openid-client-v6-API, sodass die
 * Fastify-Routen (routes/auth.ts) frei von Bibliotheks-Details bleiben.
 *
 * Sicherheits-Constraints (Plan): PKCE + state + nonce werden IMMER erzeugt und
 * beim Rücktausch geprüft; Tokens/Codes tauchen nie in Fehlermeldungen auf (die
 * Routen fangen alle Fehler und liefern generische deutsche Meldungen).
 */

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUrl: string
  /** Name shown on the sign-in button (`F451_OIDC_PROVIDER_NAME`, e.g.
   *  "Microsoft Entra", "Forgejo"). Unset → the UI shows a neutral label. */
  providerName?: string
}

/** Discovery-Ergebnis + statische Konfiguration, gemeinsam durch die Flows gereicht. */
export interface OidcRuntime {
  config: client.Configuration
  oidc: OidcConfig
}

const SCOPE = 'openid email profile'

/**
 * Führt OIDC-Discovery aus. `allowInsecure` erlaubt http-Issuer (Dev/Test mit
 * Mock-IdP) — in Produktion (secure Cookies) bleibt HTTPS erzwungen.
 */
export async function discoverOidc(
  oidc: OidcConfig,
  opts: { allowInsecure?: boolean } = {},
): Promise<client.Configuration> {
  const execute = opts.allowInsecure ? [client.allowInsecureRequests] : []
  return client.discovery(new URL(oidc.issuer), oidc.clientId, oidc.clientSecret, undefined, { execute })
}

/** Kurzlebiger Login-Kontext, der signiert im Cookie zwischengelagert wird. */
export interface LoginTransaction {
  state: string
  nonce: string
  codeVerifier: string
  /** Whitelist-geprüfter relativer Ziel-Pfad nach erfolgreichem Login. */
  next: string
}

/**
 * Erzeugt die Authorization-Redirect-URL samt frischem PKCE-/state-/nonce-Satz.
 * `next` wird vom Aufrufer bereits Whitelist-geprüft übergeben (nur relative
 * Pfade) und in die Transaction übernommen.
 */
export async function buildLoginUrl(
  rt: OidcRuntime,
  next: string,
): Promise<{ url: string; tx: LoginTransaction }> {
  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = client.randomState()
  const nonce = client.randomNonce()

  const url = client.buildAuthorizationUrl(rt.config, {
    redirect_uri: rt.oidc.redirectUrl,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  return { url: url.href, tx: { state, nonce, codeVerifier, next } }
}

export interface OidcIdentity {
  /** OIDC-`sub` — dient als stabile User-Id (Spec Abschnitt 7). */
  sub: string
  email: string
  displayName: string
  /** Die beim Code-Tausch ausgestellten Tokens. Nur gebraucht, wenn Anmeldung
   *  und Forgejo-Verknüpfung dieselbe OAuth-App teilen (Issue #70, routes/auth.ts). */
  tokens: { accessToken: string; refreshToken?: string }
}

/**
 * Tauscht den Authorization-Code gegen Tokens und validiert das ID-Token
 * (Signatur via JWKS, Issuer, Audience, `state`, `nonce`). Wirft bei jedem
 * Fehlschlag — der Aufrufer übersetzt das in eine generische 400-Antwort.
 */
export async function completeLogin(
  rt: OidcRuntime,
  currentUrl: URL,
  tx: LoginTransaction,
): Promise<OidcIdentity> {
  const tokens = await client.authorizationCodeGrant(rt.config, currentUrl, {
    pkceCodeVerifier: tx.codeVerifier,
    expectedState: tx.state,
    expectedNonce: tx.nonce,
    idTokenExpected: true,
  })

  const claims = tokens.claims()
  if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('ID-Token ohne gültigen sub-Claim')
  }

  const email = emailFromClaims(claims)
  const nameClaim = typeof claims.name === 'string' ? claims.name : ''
  const displayName = nameClaim || email || claims.sub

  return {
    sub: claims.sub,
    email,
    displayName,
    tokens: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
  }
}

/**
 * Email address from the ID token. Entra ID often omits `email` unless the
 * optional claim is configured; `preferred_username` or `upn` then usually
 * hold the sign-in address, so they are used when they look like one.
 */
export function emailFromClaims(claims: Record<string, unknown>): string {
  for (const key of ['email', 'preferred_username', 'upn']) {
    const value = claims[key]
    if (typeof value === 'string' && (key === 'email' ? value.length > 0 : value.includes('@'))) return value
  }
  return ''
}

/**
 * Whitelist für den `?next=`-Parameter: ausschließlich relative Pfade. Alles
 * andere (absolute URLs, protokoll-relative `//host`, Backslash-Tricks) fällt
 * auf `/` zurück — verhindert Open-Redirects.
 */
export function sanitizeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  // Browser strippen ASCII-Tab/Newline/CR gemäß WHATWG-URL-Spec aus dem
  // Location-Header VOR dem Parsen. Ohne Entfernung würde z. B. `/\t/host` die
  // //-Prüfung unten passieren (raw[1] ist Tab) und im Browser zu `//host`
  // kollabieren — ein protokoll-relativer Open-Redirect. Bereinigten Wert
  // zurückgeben, damit auch der emittierte Header kein Tab/Newline mehr enthält.
  const cleaned = raw.replace(/[\t\n\r]/g, '')
  if (cleaned.length === 0 || cleaned[0] !== '/') return '/'
  // `//host` und `/\host` werden von Browsern als protokoll-relativ interpretiert.
  if (cleaned[1] === '/' || cleaned[1] === '\\') return '/'
  return cleaned
}
