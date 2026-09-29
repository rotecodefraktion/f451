import { buildApp, DEFAULT_RATE_LIMITS } from './app.js'
import { deleteExpiredSessions, type AuthOptions } from './auth/sessions.js'
import { createDb } from './db/client.js'
import { checkDrift } from './indexer/drift.js'
import type { IndexerLogger } from './indexer/index-space.js'
import { createProviderRegistry, getForgejoBaseUrl, loadGlobalTemplatesConfig, loadSpacesConfig } from './spaces/config.js'

const databaseUrl = process.env.DATABASE_URL

// Space-Konfiguration ist optional (Plan Task 2/4/5): ohne `F451_SPACES` bleiben
// Webhook-/Admin-Routen und der Drift-Job deaktiviert, Bestandsverhalten (nur
// /healthz, /readyz) bleibt unverändert.
const spaces = process.env.F451_SPACES ? loadSpacesConfig(process.env) : undefined
const providerRegistry = spaces ? createProviderRegistry(process.env) : undefined

// Webhook-Secrets (Plan Task 4) nur relevant, wenn überhaupt Spaces konfiguriert
// sind (sonst werden die Webhook-Routen gar nicht registriert, siehe app.ts).
// Globales Templates-Repo (Phase 3c Task 2) ist unabhängig von F451_SPACES
// konfigurierbar (fail-fast bei Fehlkonfiguration, siehe
// `loadGlobalTemplatesConfig`) — `undefined`, wenn nicht gesetzt.
const globalTemplates = loadGlobalTemplatesConfig(process.env)

const webhookSecrets = spaces
  ? {
      forgejo: process.env.F451_WEBHOOK_SECRET_FORGEJO,
      github: process.env.F451_WEBHOOK_SECRET_GITHUB,
    }
  : undefined

// Auth (Plan Task 3, extended for GitHub sign-in #8) is opt-in: it activates
// when EITHER F451_OIDC_ISSUER OR F451_GITHUB_LOGIN=1 is set. Without either,
// all routes stay unprotected and no auth routes are registered (1c
// behaviour). With only GitHub sign-in enabled, `oidc` stays `undefined` —
// sessions, `/api/me`, connect and `/auth/github/*` still get built below
// (see `AuthOptions.githubLogin`).
function buildAuthOptions(): AuthOptions | undefined {
  const issuer = process.env.F451_OIDC_ISSUER
  const githubLoginRequested = process.env.F451_GITHUB_LOGIN === '1'
  if (!issuer && !githubLoginRequested) return undefined

  const tokenKey = process.env.F451_TOKEN_KEY
  if (!tokenKey) {
    // Fail-fast (project global constraint): the token key is required
    // whenever EITHER OIDC or GitHub sign-in is enabled (provider-token
    // encryption, Task 4).
    throw new Error('F451_TOKEN_KEY is required when F451_OIDC_ISSUER or F451_GITHUB_LOGIN=1 is set.')
  }

  let oidc: AuthOptions['oidc']
  if (issuer) {
    const clientId = process.env.F451_OIDC_CLIENT_ID
    const clientSecret = process.env.F451_OIDC_CLIENT_SECRET
    const redirectUrl = process.env.F451_OIDC_REDIRECT_URL
    if (!clientId || !clientSecret || !redirectUrl) {
      throw new Error(
        'Bei gesetztem F451_OIDC_ISSUER sind F451_OIDC_CLIENT_ID, F451_OIDC_CLIENT_SECRET und F451_OIDC_REDIRECT_URL erforderlich.',
      )
    }
    oidc = { issuer, clientId, clientSecret, redirectUrl, providerName: process.env.F451_OIDC_PROVIDER_NAME || undefined }
  }

  const connect = buildConnectOptions()
  if (githubLoginRequested && !connect?.github) {
    // Fail-fast, same reasoning as the OIDC half-configuration check above:
    // `F451_GITHUB_LOGIN=1` without the connect app's client id/secret is a
    // deployment mistake, not a silently-disabled feature.
    throw new Error(
      'F451_GITHUB_LOGIN=1 requires F451_GITHUB_OAUTH_CLIENT_ID and F451_GITHUB_OAUTH_CLIENT_SECRET to be set.',
    )
  }

  const insecureCookies = process.env.F451_INSECURE_COOKIES === '1'

  return {
    tokenKey,
    insecureCookies,
    // Task 3 (Auth-Härtung M2, Spec §7): eigene Env-Variable, damit die
    // OIDC-Discovery unabhängig vom Cookie-Modus gesteuert werden kann (siehe
    // `AuthOptions.oidcAllowInsecure`). DEFAULT = Wert von
    // F451_INSECURE_COOKIES (abwärtskompatibel — Deployments, die bisher nur
    // F451_INSECURE_COOKIES=1 gesetzt hatten, verhalten sich unverändert).
    // Explizit gesetzt überschreibt den Default in BEIDE Richtungen: "0"
    // erzwingt HTTPS-Discovery trotz F451_INSECURE_COOKIES=1 (TLS-
    // terminierender Proxy, aber Dev-Cookies), "1" erlaubt http-Discovery
    // ohne die Cookies unsicher zu machen (seltener, aber möglich).
    oidcAllowInsecure:
      process.env.F451_OIDC_ALLOW_INSECURE !== undefined
        ? process.env.F451_OIDC_ALLOW_INSECURE === '1'
        : insecureCookies,
    oidc,
    connect,
    githubLogin: githubLoginRequested,
  }
}

/**
 * Provider-Kontoverknüpfung (Plan Task 4) ist pro Provider unabhängig opt-in:
 * Forgejo benötigt zusätzlich die Instanz-Basis-URL — dafür wird `F451_FORGEJO_URL`
 * wiederverwendet (dieselbe Forgejo-Instanz wie beim Indexer-Service-Account,
 * siehe spaces/config.ts), statt eine zweite, potenziell abweichende Basis-URL
 * zu pflegen.
 */
function buildConnectOptions(): AuthOptions['connect'] {
  const connect: NonNullable<AuthOptions['connect']> = {}

  const forgejoClientId = process.env.F451_FORGEJO_OAUTH_CLIENT_ID
  const forgejoClientSecret = process.env.F451_FORGEJO_OAUTH_CLIENT_SECRET
  if (forgejoClientId && forgejoClientSecret) {
    const baseUrl = process.env.F451_FORGEJO_URL
    if (!baseUrl) {
      throw new Error(
        'F451_FORGEJO_URL ist erforderlich, wenn F451_FORGEJO_OAUTH_CLIENT_ID/SECRET gesetzt sind.',
      )
    }
    connect.forgejo = { baseUrl, clientId: forgejoClientId, clientSecret: forgejoClientSecret }
  }

  const githubClientId = process.env.F451_GITHUB_OAUTH_CLIENT_ID
  const githubClientSecret = process.env.F451_GITHUB_OAUTH_CLIENT_SECRET
  if (githubClientId && githubClientSecret) {
    connect.github = { clientId: githubClientId, clientSecret: githubClientSecret }
  }

  return Object.keys(connect).length > 0 ? connect : undefined
}

// Media-Upload-Größenlimit (Phase 2a Task 5, Plan Global Constraints:
// "F451_MAX_UPLOAD_MB Default 10") — ohne gesetzte/valide Env-Variable
// bleibt es `undefined`, `drafts/upload.ts#maxUploadBytes` greift dann auf
// `DEFAULT_MAX_UPLOAD_MB` zurück.
const maxUploadMbEnv = process.env.F451_MAX_UPLOAD_MB ? Number(process.env.F451_MAX_UPLOAD_MB) : undefined
const maxUploadMb = maxUploadMbEnv !== undefined && Number.isFinite(maxUploadMbEnv) ? maxUploadMbEnv : undefined

// Rate-Limits (Task 2, Spec §7) — nur das Anfrage-MAXIMUM ist per Env
// konfigurierbar (Muster `maxUploadMb` oben), das Zeitfenster ist fest 60s
// (YAGNI). Ungesetzt/ungültig → `undefined`, `app.ts#buildApp` greift dann
// auf `DEFAULT_RATE_LIMITS` zurück (10 Auth-/60 Such-Anfragen pro Minute).
function readRateLimitMax(envVar: string | undefined): number | undefined {
  const n = envVar ? Number(envVar) : undefined
  return n !== undefined && Number.isFinite(n) ? n : undefined
}
const rateLimitAuthMax = readRateLimitMax(process.env.F451_RATE_LIMIT_AUTH_MAX)
const rateLimitSearchMax = readRateLimitMax(process.env.F451_RATE_LIMIT_SEARCH_MAX)
const rateLimitApiTokenMax = readRateLimitMax(process.env.F451_RATE_LIMIT_API_TOKEN_MAX)

// trustProxy (Fix-Runde 1, Review Task 2 — Spec §8: das Compose-Deployment
// läuft IMMER hinter einem Reverse Proxy): ungesetzt/leer/ungültig →
// kein trustProxy (Dev ohne Proxy, Bestandsverhalten); Zahl n → genau n
// Hops vertraut (Produktion: 1 = der eigene Proxy, siehe .env.example);
// String 'true' → alle Hops vertraut — NUR für exotische Setups: damit wird
// das LINKESTE (Client-kontrollierte, spoofbare) X-Forwarded-For-Glied zur
// req.ip und die Rate-Limits sind per Header trivial umgehbar. Details:
// `AppOptions.trustProxy` in app.ts.
function readTrustProxy(envVar: string | undefined): boolean | number | undefined {
  if (!envVar) return undefined
  if (envVar === 'true') return true
  const n = Number(envVar)
  return Number.isFinite(n) ? n : undefined
}
const trustProxy = readTrustProxy(process.env.F451_TRUST_PROXY)

const rateLimits =
  rateLimitAuthMax !== undefined || rateLimitSearchMax !== undefined || rateLimitApiTokenMax !== undefined
    ? {
        auth: { max: rateLimitAuthMax ?? DEFAULT_RATE_LIMITS.auth.max, windowMs: 60_000 },
        search: { max: rateLimitSearchMax ?? DEFAULT_RATE_LIMITS.search.max, windowMs: 60_000 },
        apiToken: { max: rateLimitApiTokenMax ?? DEFAULT_RATE_LIMITS.apiToken!.max, windowMs: 60_000 },
      }
    : undefined

// Auth-Optionen einmal berechnet (statt inline im buildApp-Aufruf) — der
// Session-Sweeper (Task 3, M3) unten braucht dieselbe Bedingung ("ist Auth
// überhaupt aktiv?") wie `buildApp`, ohne die Env-Ableitung ein zweites Mal
// zu duplizieren.
const authOptions = buildAuthOptions()

const app = buildApp({
  databaseUrl,
  spaces,
  providerRegistry,
  webhookSecrets,
  adminToken: process.env.F451_ADMIN_TOKEN,
  auth: authOptions,
  // Dieselbe Quelle wie die Service-Account-Registry (Phase 2a Task 2,
  // Konsistenz-Auflage aus dem Task-1-Review) — siehe Kommentar bei
  // `AppOptions.forgejoBaseUrl` in app.ts.
  forgejoBaseUrl: getForgejoBaseUrl(process.env),
  maxUploadMb,
  // Review-PR-Body-Link (Phase 2d Task 3, Finding 2 aus dem Review) — optional,
  // ohne gesetzte Env-Variable bleibt der PR-Body linklos (Bestandsverhalten).
  publicBaseUrl: process.env.F451_PUBLIC_BASE_URL,
  // Templates-API (Phase 3c Task 2) — ohne F451_GLOBAL_TEMPLATES bleibt sie
  // `undefined`, die Route liefert dann nur Space-Templates.
  globalTemplates,
  // Rate-Limits (Task 2, Spec §7) — ohne gesetzte Env-Variablen bleibt es
  // `undefined`, `app.ts#buildApp` greift dann auf `DEFAULT_RATE_LIMITS` zurück.
  rateLimits,
  // trustProxy (Fix-Runde 1, Review Task 2) — hinter dem Reverse Proxy (Spec
  // §8) zwingend, damit die Rate-Limits pro CLIENT-IP zählen statt pro
  // Proxy-IP (F451_TRUST_PROXY=1 im Deployment, siehe readTrustProxy oben).
  trustProxy,
})

// Fastifys Pino-Logger hat die Signatur `(mergingObject, msg)` — umgekehrt zur
// `IndexerLogger`-Konvention `(msg, meta?)` im Indexer-Modul. Kleiner Adapter,
// damit der Drift-Job über `app.log` beobachtbar ist.
const driftLogger: IndexerLogger = {
  warn: (msg, meta) => app.log.warn(meta ?? {}, msg),
}

const DRIFT_INTERVAL_MS = 5 * 60 * 1000

// HEAD-Abgleich-Job (Plan Task 5) nur starten, wenn Spaces konfiguriert sind
// UND eine Datenbank verfügbar ist.
if (spaces && spaces.length > 0 && providerRegistry && databaseUrl) {
  const driftDb = createDb(databaseUrl)
  const driftInterval = setInterval(() => {
    // Task 5 (Betrieb): DIESELBE `OpsCounters`-Instanz wie die Webhook-/Admin-
    // Routen (`app.opsCounters`, dekoriert in `buildApp`) — der Drift-Job läuft
    // als eigener Prozess-`setInterval` außerhalb von `buildApp`, ohne die
    // Instanz zu teilen sähe `GET /admin/status` Drift-Fehler nie.
    checkDrift(
      { db: driftDb.db, providerRegistry, logger: driftLogger, counters: app.opsCounters },
      spaces,
    ).catch((err: unknown) => {
      app.log.error({ err }, 'drift: Lauf fehlgeschlagen')
    })
  }, DRIFT_INTERVAL_MS)

  app.addHook('onClose', async () => {
    clearInterval(driftInterval)
    await driftDb.close()
  })
}

const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

// Task 3 (Auth-Härtung M3, Spec §7): stündlicher Sweep abgelaufener Sessions
// (`deleteExpiredSessions`, `auth/sessions.ts`) — exakt nach dem Muster des
// HEAD-Abgleich-Jobs oben (`setInterval` + `.catch`-Log + `onClose`-Cleanup).
// Bewusst HIER in server.ts (Prozess-Einstiegspunkt), NICHT in `buildApp`:
// `buildApp` wird in Tests je Testdatei mehrfach aufgerufen (eigene
// App-Instanz pro Testsuite) — ein Interval dort würde bei jedem
// `buildApp()`-Aufruf einen weiteren Sweeper-Timer starten, der über die
// Lebensdauer des gesamten Testprozesses (nicht nur der einzelnen App)
// weiterläuft. Nur starten, wenn Auth überhaupt aktiv ist (sonst entstehen
// gar keine Sessions) UND eine Datenbank verfügbar ist.
if (authOptions && databaseUrl) {
  const sessionDb = createDb(databaseUrl)
  const sweepInterval = setInterval(() => {
    deleteExpiredSessions(sessionDb.db).catch((err: unknown) => {
      app.log.error({ err }, 'sessions: Sweep abgelaufener Sessions fehlgeschlagen')
    })
  }, SESSION_SWEEP_INTERVAL_MS)

  app.addHook('onClose', async () => {
    clearInterval(sweepInterval)
    await sessionDb.close()
  })
}

const port = Number(process.env.PORT ?? 3001)

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
