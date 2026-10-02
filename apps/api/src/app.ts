import { createHash } from 'node:crypto'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import type { GitProvider } from '@f451/git-provider'
import { attachPoolErrorHandler } from './db/pool-errors.js'
import { createSessionAuthHook, type AuthOptions } from './auth/sessions.js'
import { createTokenRateLimiter } from './auth/token-rate-limit.js'
import { canReadSpace, canWriteSpace, type PermissionDeps, type SpaceAccess } from './auth/permissions.js'
import { formatErrorReply } from './error-format.js'
import { schema } from './db/schema.js'
import { getUserProvider, type UserProviderDeps } from './drafts/user-provider.js'
import { createOpsCounters } from './ops/counters.js'
import { hasValidAdminToken, registerAdminRoutes } from './routes/admin.js'
import { registerVersionRoutes } from './routes/versions.js'
import {
  registerAuthMethodsRoute,
  registerAuthRoutes,
  registerConnectRoutes,
  registerGithubLoginRoutes,
  registerLogoutRoute,
  registerMeRoute,
  type SignInMethod,
} from './routes/auth.js'
import { registerBrokenLinksRoutes } from './routes/broken-links.js'
import { registerCreatePageRoute } from './routes/create-page.js'
import { registerDeletePageRoute } from './routes/delete-page.js'
import { registerDraftsRoutes } from './routes/drafts.js'
import { createClassificationGate } from './auth/classification-gate.js'
import { registerGraphRoutes } from './routes/graph.js'
import { registerLocksRoutes } from './routes/locks.js'
import { registerMediaRoutes } from './routes/media.js'
import { registerMetadataSchemaRoutes } from './routes/metadata-schema.js'
import { registerMovePageRoute } from './routes/move-page.js'
import { registerPagesRoutes } from './routes/pages.js'
import { registerReorderRoute } from './routes/reorder.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerTemplatesRoutes } from './routes/templates.js'
import { registerThemeRoutes } from './routes/theme.js'
import { registerThemeEditorRoutes } from './routes/theme-editor.js'
import { registerThemeContrastRoutes } from './routes/theme-contrast.js'
import { registerTokensRoutes } from './routes/tokens.js'
import { registerUnarchivePageRoute } from './routes/unarchive-page.js'
import {
  registerWebhookRoutes,
  type WebhookCleanupResult,
  type WebhookIndexResult,
  type WebhookSecrets,
} from './routes/webhooks.js'
import { registerWorkflowRoutes } from './routes/workflow.js'
import type { GlobalTemplatesConfig, InstanceConfig, SpaceConfig } from './spaces/config.js'

export interface AppOptions {
  databaseUrl?: string
  /** Task 4 (Webhooks): konfigurierte Spaces. Optional — ohne sie werden keine
   *  Webhook-Routen registriert und Bestands-Tests bleiben unverändert. */
  spaces?: SpaceConfig[]
  providerRegistry?: (space: SpaceConfig) => GitProvider
  webhookSecrets?: WebhookSecrets
  /** Test-Hook: wird nach jeder asynchron angestoßenen Webhook-Indexierung aufgerufen. */
  onIndexed?: (result: WebhookIndexResult) => void
  /** Test-Hook (Phase 2d Task 2): wird nach jedem asynchron angestoßenen
   *  Nach-Merge-Cleanup eines `pull_request`-Webhook-Events aufgerufen. */
  onCleanup?: (result: WebhookCleanupResult) => void
  /** Task 5 (Admin-Reindex): Bearer-Token für `POST /admin/reindex`. Optional —
   *  ohne gesetztes Token lehnt der Endpoint jede Anfrage ab (Fail-Closed). */
  adminToken?: string
  /**
   * Basis-URL der Forgejo-Instanz (Phase 2a Task 2, Konsistenz-Auflage aus dem
   * Task-1-Review): EINE Quelle (`F451_FORGEJO_URL`, `spaces/config.ts#getForgejoBaseUrl`)
   * für alle drei Verwendungen — die Service-Account-Registry (`providerRegistry`),
   * die Schreib-/Leserechte-Probe (`PermissionDeps.forgejoBaseUrl`) UND die
   * Nutzer-Provider-Factory (`UserProviderDeps.forgejoBaseUrl`, `drafts/user-provider.ts`).
   * Vorher hing `PermissionDeps.forgejoBaseUrl` an `opts.auth.connect?.forgejo?.baseUrl`
   * (nur gesetzt, wenn zusätzlich Forgejo-OAuth-Kontoverknüpfung konfiguriert war) —
   * das ließ Leseprobe/Schreibprobe fälschlich scheitern, sobald Spaces gegen
   * Forgejo liefen, aber (noch) kein OAuth-Client für die Kontoverknüpfung
   * eingerichtet war. Jetzt unabhängig davon aus derselben Env wie die Registry. */
  forgejoBaseUrl?: string
  /** Task 2 (Sessions): aktiviert das Auth-Wiring (Cookie-Plugin, req.user-Hook).
   *  Optional — ohne sie ändert sich nichts am 1c-Verhalten (kein Hook, keine
   *  Cookies, Bestands-Tests unverändert). Erfordert `databaseUrl`. */
  auth?: AuthOptions
  /** Test-Hook (Plan Task 6, Abnahme-Kriterium 2): leitet den Pino-Logger auf
   *  einen eigenen Stream um, damit ein Test dessen Ausgabe auf Klartext-Tokens
   *  grep-en kann, statt auf stdout zu schreiben (das synchron per fd schreibt
   *  und sich daher nicht per `process.stdout.write`-Patch abfangen lässt).
   *  Ohne Angabe unverändertes Bestandsverhalten (`logger: true` → stdout). */
  logStream?: NodeJS.WritableStream
  /** Phase 2a Task 5 (Media-Upload): Größenlimit in MiB für
   *  `POST /api/pages/:id/draft/media` (`F451_MAX_UPLOAD_MB`, gelesen in
   *  `server.ts`). Ohne Angabe gilt `DEFAULT_MAX_UPLOAD_MB` (10), siehe
   *  `drafts/upload.ts`. */
  maxUploadMb?: number
  /** Öffentliche Basis-URL der f451-Oberfläche (Phase 2d Task 3, Finding 2 aus
   *  dem Review): `F451_PUBLIC_BASE_URL`, gelesen in `server.ts` (Muster wie
   *  `forgejoBaseUrl` oben). Optional — ohne sie bleibt der Review-PR-Body ohne
   *  klickbaren Link (Bestandsverhalten, siehe `routes/workflow.ts#reviewPrBody`).
   *  Task 3 (Auth-Härtung, Spec §7): seit Phase 4a zusätzlich Basis für die
   *  `redirect_uri` der Connect-Routen (M1, `routes/auth.ts#buildConnectRedirectUri`)
   *  UND für die "eigene Origin" des CSRF-Origin-Checks unten in `buildApp` —
   *  ohne sie fallen beide auf den (Angreifer-kontrollierbaren) Host-Header
   *  des jeweiligen Requests zurück (Dev-Fallback). */
  publicBaseUrl?: string
  /** Phase 3c Task 2: optionales globales Templates-Repo (`F451_GLOBAL_TEMPLATES`,
   *  `spaces/config.ts#loadGlobalTemplatesConfig`) — ergänzt `GET
   *  /api/spaces/:space/templates` um providerweite Vorlagen zusätzlich zu
   *  den Space-eigenen `_templates/*.md`. Ohne sie liefert die Route nur
   *  Space-Templates (Bestandsverhalten). */
  globalTemplates?: GlobalTemplatesConfig
  /** Theming Stage 2: optional instance repo (`F451_INSTANCE_CONFIG`,
   *  `spaces/config.ts#loadInstanceConfig`) holding `_meta/theme.yaml`; read by
   *  `theme/instance-theme.ts#loadInstanceTheme` as `deps.instanceConfig`.
   *  Without it there is no instance theme. */
  instanceConfig?: InstanceConfig
  /** Task 2 (Rate-Limits, Spec §7): Anfragebudget pro Zeitfenster für die
   *  6 Auth-Routen (`auth.ts`, OIDC- + Connect-Flows) und `GET /api/search`.
   *  WICHTIG (Fix-Runde 1, Review-Finding 2): das Limit gilt PRO Route und
   *  Client-IP — @fastify/rate-limit legt je Route mit `config.rateLimit`
   *  einen EIGENEN Zähler an (`auth.max: 10` heißt also 10/min auf JEDER der
   *  6 Auth-Routen einzeln, kein gemeinsames Gruppenbudget von 10 gesamt).
   *  Ohne Angabe gilt `DEFAULT_RATE_LIMITS` unten — hoch genug, dass
   *  Bestandstests nicht ins Limit laufen; knappe Werte nur in Tests, die
   *  das Limit selbst prüfen (`rate-limit.test.ts`). Env `F451_RATE_LIMIT_
   *  AUTH_MAX`/`F451_RATE_LIMIT_SEARCH_MAX`, gelesen in `server.ts`
   *  (Muster `getForgejoBaseUrl`) — das Zeitfenster ist fest 60s (YAGNI). */
  rateLimits?: {
    auth: { max: number; windowMs: number }
    search: { max: number; windowMs: number }
    /** Issue #73: Budget für ALLE Aufrufe mit API-Token (/api, /media), pro
     *  Nutzer gezählt statt pro IP — siehe `auth/token-rate-limit.ts`.
     *  Fehlt es, gilt `DEFAULT_RATE_LIMITS.apiToken`. Env
     *  `F451_RATE_LIMIT_API_TOKEN_MAX`. */
    apiToken?: { max: number; windowMs: number }
  }
  /** Fix-Runde 1 (Review Task 2, HIGH): hinter dem Reverse Proxy aus Spec §8
   *  (Caddy/Traefik — das Compose-Deployment hat IMMER einen davor) wäre
   *  `req.ip` sonst für ALLE Nutzer dieselbe Proxy-IP → die Rate-Limits oben
   *  zählten alle Nutzer in EINEM Zähler pro Route (10 fremde Login-Versuche/
   *  min sperren den Login firmenweit — der Schutz würde zum DoS-Vektor).
   *  `1` = genau der letzte Hop (der eigene Proxy) ist vertraut; `req.ip`
   *  wird das LETZTE X-Forwarded-For-Glied — das vom vertrauten Proxy selbst
   *  angehängte, vom Client nicht spoofbare. BEWUSST NICHT pauschal `true`:
   *  damit nähme proxy-addr das LINKESTE Glied, das der Client selbst setzen
   *  und pro Request variieren kann (durch den Proxy hindurch gespooft) —
   *  das Limit wäre trivial umgehbar. `true` bleibt für exotische Setups
   *  bewusst möglich. Env `F451_TRUST_PROXY`, gelesen in `server.ts`;
   *  ungesetzt → kein trustProxy (Dev ohne Proxy, Bestandsverhalten:
   *  `req.ip` = Socket-Adresse, X-Forwarded-For wird ignoriert). */
  trustProxy?: boolean | number
}

/** Default-Anfragebudget (Task 2, Spec §7) — siehe `AppOptions.rateLimits`.
 *  Exportiert, damit `server.ts` beim Zusammenbau aus Env-Variablen
 *  (`F451_RATE_LIMIT_AUTH_MAX`/`F451_RATE_LIMIT_SEARCH_MAX`) dieselben
 *  Default-Werte verwendet, statt sie ein zweites Mal zu pflegen. */
export const DEFAULT_RATE_LIMITS: NonNullable<AppOptions['rateLimits']> = {
  auth: { max: 10, windowMs: 60_000 },
  search: { max: 60, windowMs: 60_000 },
  apiToken: { max: 300, windowMs: 60_000 },
}

const healthSchema = {
  tags: ['system'],
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
    },
  },
} as const

const readySchema = {
  tags: ['system'],
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
    },
    503: {
      type: 'object',
      properties: { status: { type: 'string' }, reason: { type: 'string' } },
      required: ['status', 'reason'],
    },
  },
} as const

// Fix-Runde 1/2 (Review 4a-1, Format-Konsistenz): Fehler, die Fastify NOCH VOR
// Routing/setErrorHandler wirft, laufen ausschließlich über die Konstruktor-
// Option `frameworkErrors` — ohne sie antwortet Fastify mit seinem Alt-Format
// ({message,error,statusCode}). Fastify 5.10 routet DREI Fehlerklassen hierüber
// (fastify.js: onBadUrl/onMaxParamLength/onAsyncConstraintError):
//   - FST_ERR_BAD_URL (400): kaputtes Percent-Encoding, z. B. `/%zz`
//   - FST_ERR_MAX_PARAM_LENGTH (414): Pfadparameter über maxParamLength
//     (Default 100 — real erreichbar, z. B. `/api/pages/:id` mit langen
//     percent-encodeten `path:`-IDs)
//   - FST_ERR_ASYNC_CONSTRAINT (500): Fehler aus async Route-Constraints
//     (im Projekt unerreichbar — es sind keine Route-Constraints konfiguriert)
// Der semantische Statuscode des Fehlers BLEIBT erhalten (adjudizierte Regel
// aus Fix-Runde 1: 414 bleibt 414, kein Zwang auf 400), nur der Body wird
// normalisiert; der 500er-Fall wird wie im 500-Zweig von formatErrorReply
// behandelt (vollständig loggen, generischer Body, kein Message-Leak).
// Als eigenständige, explizit typisierte Funktion (statt Inline-Arrow)
// definiert — Fastifys generische `frameworkErrors`-Signatur leitet sonst
// (mangels registrierter Response-Schemas an dieser Stelle) einen zu engen
// `.send()`-Typ her.
function handleFrameworkError(error: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  const statusCode = error.statusCode ?? 400
  if (statusCode >= 500) {
    req.log.error({ err: error }, 'Framework-Fehler (frameworkErrors)')
    void reply.status(statusCode).send({ status: 'error', reason: 'Interner Fehler.' })
    return
  }
  void reply.status(statusCode).send({ status: 'bad_request', reason: 'Ungültige URL.' })
}

// Task 5 (Betrieb, Spec §7): Pino-`redact` — läuft VOR jeder Serialisierung,
// löscht/ersetzt Werte an diesen Pfaden durch `[Redacted]` in JEDER Log-
// Ausgabe dieses Loggers, unabhängig davon, WAS an dieser Stelle geloggt
// wird. Fastifys eigener Standard-`req`-Serializer loggt Header nicht (nur
// Methode/URL/Host/Remote-Adresse) — die Liste ist bewusste Verteidigung in
// der Tiefe für jede künftige oder manuelle Log-Stelle, die `req`/`req.headers`
// mitloggt (z. B. Debug-Logging), UND deckt exakt die drei Stellen ab, an
// denen Klartext-Geheimnisse in Requests dieser API stehen: das Bearer-Token
// (`/admin/reindex`-/`/admin/status`-Auth, s. `routes/admin.ts`), das
// Session-Cookie (`auth/sessions.ts`) und die Webhook-HMAC-Signatur — GitHub
// sendet sie als `X-Hub-Signature-256`-Header (Forgejo/Gitea dagegen im
// Payload-Body via `X-Gitea-Signature`, ebenfalls ein Header, aber ohne
// Secret-Charakter selbst — der Wert ist eine Signatur, kein Schlüssel;
// dennoch ist NUR der GitHub-Header hier gelistet, weil der Brief exakt
// diesen Pfad vorgibt und `X-Gitea-Signature` ebenfalls nur eine HMAC ÜBER
// den Body ist, kein Geheimnis an sich — siehe `routes/webhooks.ts`).
const REDACT_PATHS = ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-hub-signature-256"]']

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logStream
      ? { level: 'info', stream: opts.logStream, redact: REDACT_PATHS }
      : { redact: REDACT_PATHS },
    frameworkErrors: handleFrameworkError,
    // Fix-Runde 1 (Review Task 2): siehe `AppOptions.trustProxy` — ohne sie
    // bleibt `req.ip` die Socket-Adresse (Bestandsverhalten, Dev ohne Proxy).
    trustProxy: opts.trustProxy,
  })

  // Task 5 (Betrieb): EINE `OpsCounters`-Instanz pro App-Build, an die
  // Webhook-/Admin-Routen unten durchgereicht UND auf der Instanz dekoriert
  // (`app.opsCounters`) — `server.ts` braucht dieselbe Instanz für den
  // Drift-Job, der außerhalb von `buildApp` als eigener Prozess-`setInterval`
  // läuft (siehe Kommentar in `ops/counters.ts`).
  const opsCounters = createOpsCounters()
  app.decorate('opsCounters', opsCounters)
  // Task 4a-1 (Security & Betrieb): zentraler Error-Handler — übersetzt
  // Fastify-/AJV-Fehler ins projektweite {status,reason}-Format, BEVOR die
  // Response-Schema-Serialisierung greift (schließt die FST_ERR_FAILED_ERROR_
  // SERIALIZATION-Klasse projektweit, siehe error-format.ts). Ändert NUR
  // geworfene/Fastify-interne Fehler — Handler mit eigenem `reply.send` (z. B.
  // Webhook-{status:'ignored'}, 502-providerErrorReply-Pfade) bleiben unberührt.
  app.setErrorHandler(formatErrorReply)
  // Fix-Runde 1 (Review 4a-1, Format-Konsistenz): unbekannte Routen laufen
  // NICHT durch setErrorHandler (kein Fehler wird geworfen, Fastify antwortet
  // direkt mit seinem Alt-Format). Eigener NotFound-Handler bringt sie auf das
  // projektweite {status,reason}-Format. WICHTIG: greift NUR für nicht
  // registrierte Routen — bestehende Routen-404s (z. B. `{status:'not_found'}`
  // aus Handlern wie Pages/Drafts) und `/api/docs`/`/api/openapi.json`
  // (registrierte Routen) bleiben unverändert, siehe error-format.test.ts.
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ status: 'not_found', reason: 'Unbekannte Route.' })
  })

  // Task 3 (Auth-Härtung, CSRF-Origin-Check, Spec §7): zweite Verteidigungslinie
  // NEBEN SameSite=Lax-Cookies — Lax lässt Top-Level-GET-Navigationen mit
  // Cookie durch, verhindert aber KEINE state-ändernden Requests von Seiten,
  // die per JS `fetch(..., {credentials:'include'})` browserübergreifend
  // POSTen, wenn ein Nutzer sich versehentlich auf eine bösartige Seite
  // verirrt UND ältere/abweichende SameSite-Handhabung greift. Unconditional
  // (NICHT an `opts.auth` gekoppelt) registriert — betrifft auch
  // `/admin/reindex` (Bearer-Token) und alle Space-Schreibrouten, nicht nur
  // Session-Cookies. Nur GEGEN vorhandenen, FREMDEN `origin`-Header — ein
  // fehlender Header (native Clients, curl, server-zu-server, ältere Browser
  // bei Top-Level-Navigation) lässt die Anfrage bewusst durch: das ist exakt
  // das Verhalten, das reale, nicht-browserbasierte API-Clients (CLI, CI,
  // Webhook-Server) benötigen und das SameSite=Lax ohnehin nicht abdeckt.
  // Muss VOR der Routen-Registrierung stehen (wie die Hooks oben), damit er
  // für ALLE später registrierten Routen greift — Fastifys Hook-Vererbung
  // gibt nur auf dem Root-`app` VOR der Kind-Registrierung angehängte Hooks
  // an spätere `app.register(...)`-Aufrufe weiter.
  //
  // Eigene Origin: `opts.publicBaseUrl` (Produktion — die feste, konfigurierte
  // Basis-URL), sonst der Host-Header des jeweiligen Requests (Dev-Fallback,
  // analog `buildConnectRedirectUri` in `routes/auth.ts`, M1). Bewusst EINMAL
  // außerhalb des Hooks berechnet, wenn `publicBaseUrl` gesetzt ist: eine
  // kaputte Konfiguration fällt so schon beim App-Bau auf (Fail-Fast), nicht
  // erst beim ersten mutierenden Request.
  // Task 4 (Security & Betrieb, Spec §7): globale Security-Header auf JEDER
  // Antwort — per `onSend`-Hook (statt Route-Handler), damit auch Fehler-
  // Antworten (404/500/Framework-Fehler) sie tragen. NUR setzen, wenn der
  // Header noch nicht gesetzt ist: die Media-Route (`routes/media.ts`) setzt
  // ihre eigene, sandboxte `Content-Security-Policy` UND ihr eigenes
  // `X-Content-Type-Options` VOR `reply.send()` — der Hook darf diese nicht
  // überschreiben (Regression: `media.test.ts`). `Referrer-Policy: no-referrer`
  // (strikter als die Web-App, s. `next.config.ts`) — die API hat keine
  // Navigations-Links, die von einem `same-origin`-Referrer profitieren
  // könnten, und soll keinerlei Pfad-Informationen an fremde Ziele lecken.
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('X-Content-Type-Options')) reply.header('X-Content-Type-Options', 'nosniff')
    if (!reply.getHeader('Referrer-Policy')) reply.header('Referrer-Policy', 'no-referrer')
    return payload
  })

  const ownOrigin = opts.publicBaseUrl ? new URL(opts.publicBaseUrl).origin : undefined
  const CSRF_GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  app.addHook('onRequest', async (req, reply) => {
    if (!CSRF_GUARDED_METHODS.has(req.method)) return
    const path = req.url.split('?', 1)[0]!
    // Webhook-Routen (`routes/webhooks.ts`): Server-zu-Server, HMAC-gesichert
    // (X-Gitea-Signature/X-Hub-Signature-256) — kein Browser-Kontext, in dem
    // ein `origin`-Header irgendeine Aussagekraft hätte.
    if (path.startsWith('/webhooks/')) return
    const origin = req.headers.origin
    if (!origin) return
    const own = ownOrigin ?? `${req.protocol}://${req.headers.host ?? ''}`
    let ok = false
    try {
      ok = new URL(origin).origin === own
    } catch {
      // Kaputter, nicht parsbarer origin-Header — kann kein legitimer Browser
      // gesendet haben (fail closed statt den Header stillschweigend zu ignorieren).
      ok = false
    }
    if (!ok) {
      return reply.status(403).send({ status: 'forbidden', reason: 'Ungültige Origin.' })
    }
  })

  const pool = opts.databaseUrl
    ? new pg.Pool({ connectionString: opts.databaseUrl, connectionTimeoutMillis: 3000 })
    : undefined
  // ZWINGEND vor der ersten Abfrage: ohne diesen Listener beendet ein
  // Datenbank-Neustart den gesamten Prozess (s. `db/pool-errors.ts`).
  if (pool) attachPoolErrorHandler(pool, app.log)
  const db = pool ? drizzle(pool, { schema }) : undefined

  if (opts.auth && !db) {
    // Fail-Fast (Plan Global Constraints): Sessions leben in der DB, ohne
    // databaseUrl kann Auth gar nicht funktionieren.
    throw new Error('opts.auth erfordert eine konfigurierte databaseUrl (Sessions werden in der DB gespeichert).')
  }

  app.register(swagger, {
    openapi: {
      info: {
        title: 'f451 API',
        description: 'Git-native Dokumentationsplattform',
        version: '0.1.0',
      },
    },
  })
  app.register(swaggerUi, { routePrefix: '/api/docs' })

  // Media-Upload (Phase 2a Task 5): global registriert (nicht nur im Draft-
  // Routen-Sub-Plugin), damit `req.file()`/`fastify.multipartErrors` überall
  // verfügbar sind. KEIN globales `limits.fileSize` hier — die Route setzt
  // das Größenlimit PRO REQUEST (`req.file({ limits: { fileSize } })`), damit
  // `maxUploadMb` (aus `F451_MAX_UPLOAD_MB`) die einzige Quelle der Wahrheit
  // bleibt, siehe `routes/drafts.ts`.
  app.register(multipart)

  // Rate-Limits (Task 2, Spec §7): `global: false` — KEIN pauschales Limit,
  // nur Routen mit explizitem `config.rateLimit` (die 6 Auth-Routen +
  // `GET /api/search`, siehe `routes/auth.ts`/`routes/search.ts`). Muss VOR
  // der Routen-Registrierung stehen (wie @fastify/swagger oben): das Plugin
  // hängt seinen `onRoute`-Hook an, der bei jeder späteren Routen-Definition
  // nach `config.rateLimit` sucht — registriert man das Plugin danach, sieht
  // der Hook die bereits definierten Routen nicht mehr.
  // `errorResponseBuilder` liefert ein PLAIN OBJECT, das @fastify/rate-limit
  // bei Überschreitung UNVERÄNDERT wirft (kein Error, kein `.message`) — der
  // zentrale Error-Handler (`error-format.ts`) liest dafür bereits gezielt
  // `reason` statt `message` (siehe Kommentar dort, Task 1).
  const rateLimits = opts.rateLimits ?? DEFAULT_RATE_LIMITS
  const limitApiToken = createTokenRateLimiter(rateLimits.apiToken ?? DEFAULT_RATE_LIMITS.apiToken!)
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      status: 'rate_limited',
      reason: 'Zu viele Anfragen — bitte kurz warten.',
    }),
  })

  // Routen werden erst registriert, nachdem @fastify/swagger seinen
  // onRoute-Hook angehängt hat (siehe app.register oben) — sonst fehlen
  // sie in der generierten Spec, weil Fastify onRoute synchron beim
  // Aufruf von .get() auswertet, während .register() asynchron bootet.
  app.register(async (instance) => {
    instance.get('/healthz', { schema: healthSchema }, async () => ({ status: 'ok' }))

    instance.get('/readyz', { schema: readySchema }, async (_req, reply) => {
      if (!pool) {
        return reply
          .code(503)
          .send({ status: 'unavailable', reason: 'keine Datenbank konfiguriert' })
      }
      try {
        await pool.query('SELECT 1')
        return { status: 'ok' }
      } catch (err) {
        app.log.error({ err }, 'readyz: Datenbank nicht erreichbar')
        return reply
          .code(503)
          .send({ status: 'unavailable', reason: 'Datenbank nicht erreichbar' })
      }
    })

    instance.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger())
  })

  // Auth-Wiring (Cookie-Plugin + req.user-Hook) nur, wenn opts.auth gesetzt ist
  // (Plan Task 2 — ohne sie bleibt das 1c-Verhalten exakt unverändert: kein
  // Hook, keine Cookies, Bestands-Tests unberührt).
  if (opts.auth) {
    if (!db) {
      // Für TS-Narrowing unerreichbar (siehe Fail-Fast oben), aber explizit
      // statt eines non-null-assertions weiter unten.
      throw new Error('unreachable: db fehlt trotz Fail-Fast-Prüfung')
    }
    // Signiertes Cookie-Secret nur nötig, wenn OIDC oder Connect aktiv sind
    // (beide legen ein kurzlebiges, signiertes Transaktions-Cookie an).
    // Abgeleitet aus tokenKey, damit kein zusätzliches Secret verwaltet werden
    // muss. Ohne OIDC/Connect bleibt die Registrierung wie in Task 2 (kein
    // Secret → unsignierte Cookies).
    if (opts.auth.oidc || opts.auth.connect) {
      const cookieSecret = createHash('sha256')
        .update(`f451-oidc-cookie-v1:${opts.auth.tokenKey}`)
        .digest('base64')
      app.register(cookie, { secret: cookieSecret })
    } else {
      app.register(cookie)
    }
    app.decorateRequest('user', null)
    // MCP-Phase 0: Default `null` wie bei `user` oben — nur bei erfolgreicher
    // API-Token-Auth (statt Session-Cookie) auf 'read'/'write' gesetzt, siehe
    // `auth/sessions.ts#createSessionAuthHook`.
    app.decorateRequest('apiTokenScope', null)
    app.decorateRequest('apiTokenMaxClassification', null)
    app.addHook('onRequest', createSessionAuthHook(db))

    // Schutz-Matrix (Plan Task 5, erweitert um Zusatz-Task Phase 1e/Media): NUR
    // wenn opts.auth gesetzt ist. Läuft nach dem Session-Hook (Registrierungs-
    // reihenfolge), sodass req.user gesetzt ist.
    //   - /api/* → Session erforderlich, außer /api/openapi.json, /api/docs und den Lese-Routen des Themes (/api/theme, /api/theme/resolved — anonymes Lesen behält sein Aussehen)
    //     (Spec/Swagger sind offen; ein Login-Redirect vor der Doku wäre absurd).
    //   - /admin/* → Session ODER gültiges Admin-Token (Issue #24, Ops-
    //     Automatisierung: `POST /admin/reindex`/`/admin/backfill-ids` sollen
    //     per reinem curl/CI/Deploy-Skript nutzbar sein, OHNE eingeloggte
    //     Browser-Session extra aufzubauen). Vorher zwang dieser Hook für
    //     `/admin/*` IMMER eine Session zusätzlich zum admin-eigenen Token-Gate
    //     (`requireAdminToken`, `routes/admin.ts`) — ein gültiges Token allein
    //     genügte nicht. `hasValidAdminToken` (`routes/admin.ts`) ist derselbe
    //     zeitkonstante Vergleich wie `requireAdminToken` und bleibt hier reiner
    //     Vorab-Check OHNE eigene Fail-Closed-Semantik: fehlt `opts.adminToken`
    //     (kein `F451_ADMIN_TOKEN` gesetzt) oder ist das mitgeschickte Token
    //     falsch/fehlend, liefert die Funktion `false` → dieser Hook verlangt
    //     dann wie bisher eine Session, UND `requireAdminToken` in admin.ts
    //     prüft das Token bei JEDEM Aufruf ohnehin erneut (kein Ersatz, nur
    //     eine zusätzliche, bedingte Ausnahme von der Sessionpflicht). Kein
    //     Kollateral-Bypass für andere Routen: der Check gilt NUR für
    //     `protectedAdmin`-Pfade.
    //   - /media/* → Session erforderlich (dieselbe Zugriffsprüfung wie /api/pages).
    //   - /auth/* → offen (Login/Callback/Logout müssen ohne Session erreichbar
    //     sein; Connect-Routen sichern sich selbst per requireSession).
    //   - /webhooks, /healthz, /readyz → offen (Maschinen-Endpunkte, eigene Sicherung).
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?', 1)[0]!
      if (path === '/api/openapi.json' || path === '/api/docs' || path.startsWith('/api/docs/')) return
      if (path.startsWith('/auth/')) return
      // Theme read routes are public: anonymous readers and the sign-in page keep the look.
      // Reads only — `PUT`/`DELETE /api/theme` go through the session and token-scope gates below.
      if (
        (path === '/api/theme' || path === '/api/theme/resolved')
        && (req.method === 'GET' || req.method === 'HEAD')
      ) {
        return
      }
      const protectedApi = path === '/api' || path.startsWith('/api/')
      const protectedAdmin = path === '/admin' || path.startsWith('/admin/')
      const protectedMedia = path === '/media' || path.startsWith('/media/')
      if (protectedAdmin && hasValidAdminToken(opts.adminToken, req.headers.authorization)) return
      if ((protectedApi || protectedAdmin || protectedMedia) && !req.user) {
        reply.header('WWW-Authenticate', 'session')
        // Etabliertes 401-Format (Bug-Fix, Live-Betrieb: reproduziert an
        // POST /admin/reindex und GET /admin/status). Das alte `{error}`-
        // Format kollidierte mit Routen, die `401: errorSchema` = {status,
        // reason} (required) deklarieren (admin.ts) — fast-json-stringify
        // wirft dann „status is required", Fastify antwortet serverseitig
        // mit 500 statt 401. `{status, reason}` ist das im Projekt etablierte
        // Format (siehe admin.ts:141, webhooks.ts).
        return reply.code(401).send({ status: 'unauthorized', reason: 'Anmeldung erforderlich.' })
      }

      // MCP-Phase 0 (Scope-Gate): ein Nur-Lese-API-Token (`req.apiTokenScope
      // === 'read'`, gesetzt in `createSessionAuthHook`) darf keine
      // mutierenden Requests auslösen — NUR GET bleibt erlaubt. Session-
      // Cookie-Nutzer sind unberührt (`apiTokenScope` bleibt für sie `null`,
      // s. Deklaration oben). Gilt für /api/* UND /media/* (dieselben Pfade,
      // die oben die Sessionpflicht durchsetzen) — NICHT für /admin/*: Admin-
      // Zugriff läuft ausschließlich über das eigene, unabhängige
      // Admin-Bearer-Token-Gate (`hasValidAdminToken`/`requireAdminToken`),
      // ein API-Token-Scope hat darauf keinen Einfluss.
      if ((protectedApi || protectedMedia) && req.apiTokenScope === 'read' && req.method !== 'GET') {
        // WICHTIG: dieser globale Hook läuft für JEDE Route — inklusive
        // Schreibrouten, die für 403 ein EIGENES (älteres) Schema deklarieren
        // (`forbiddenSchema` = {error,action}, s. z. B. `routes/create-
        // page.ts`), inkompatibel zum hier gewünschten {status,reason}.
        // fast-json-stringify würde bei `reply.send({status,reason})` gegen
        // ein solches Routen-Schema mit „error is required" scheitern →
        // 500 statt 403 (dieselbe Fehlerklasse, die die 401-Format-Fixes
        // oben bereits einmal geschlossen haben). Ein vorab per
        // `JSON.stringify` serialisierter STRING-Payload umgeht Fastifys
        // Response-Schema-Serialisierung komplett (`reply.js#send`: bei
        // gesetztem JSON-Content-Type und einem bereits-String-Payload wird
        // NICHT gegen das Routen-Schema validiert/serialisiert) — sicher für
        // jede beliebige, auch abweichend deklarierte Route.
        reply.header('content-type', 'application/json; charset=utf-8')
        return reply.code(403).send(JSON.stringify({ status: 'forbidden', reason: 'Token hat nur Lesezugriff.' }))
      }

      // Issue #73: Token-Aufrufe zählen pro Nutzer gegen ein eigenes Budget.
      // String-Payload aus demselben Grund wie beim Scope-Gate oben.
      if ((protectedApi || protectedMedia) && req.apiTokenScope && req.user) {
        const decision = limitApiToken(req.user.id)
        if (!decision.allowed) {
          reply.header('retry-after', String(decision.retryAfterSec))
          reply.header('content-type', 'application/json; charset=utf-8')
          return reply
            .code(429)
            .send(JSON.stringify({ status: 'rate_limited', reason: 'Zu viele Anfragen — bitte kurz warten.' }))
        }
      }
    })

    // Token classification limit (#39): page-scoped routes past the token's
    // limit answer 403; runs after routing so `:id` is known.
    app.addHook(
      'preHandler',
      createClassificationGate({ db, spaces: opts.spaces ?? [], providerRegistry: opts.providerRegistry }),
    )

    // GET /api/me: unabhängig von OIDC/Connect, solange Auth überhaupt aktiv
    // ist — spiegelt nur den aktuellen Session-/Verknüpfungsstand aus der DB.
    registerMeRoute(app, { db })
    registerLogoutRoute(app, { db, insecureCookies: opts.auth.insecureCookies, rateLimit: rateLimits.auth })

    // Sign-in methods for the sign-in page (#8). GitHub only appears when
    // BOTH `githubLogin` is on AND the connect app is configured — mirrors the
    // condition that actually registers `/auth/github/login` below.
    const githubLoginEnabled = Boolean(opts.auth.githubLogin && opts.auth.connect?.github)
    const signInMethods: SignInMethod[] = [
      ...(opts.auth.oidc
        ? [{ id: 'oidc' as const, href: '/auth/login', label: opts.auth.oidc.providerName ?? null }]
        : []),
      ...(githubLoginEnabled ? [{ id: 'github' as const, href: '/auth/github/login', label: 'GitHub' }] : []),
    ]
    registerAuthMethodsRoute(app, { methods: signInMethods, note: opts.auth.signInNote })

    // Persönliche API-Token-Verwaltung (MCP-Phase 0, `routes/tokens.ts`):
    // unabhängig von OIDC/Connect, analog `registerMeRoute` — die Routen
    // gaten sich selbst zusätzlich per `requireBrowserSession` (kein
    // Token-Bootstrapping).
    registerTokensRoutes(app, { db })

    // OIDC-Auth-Routen (Login/Callback/Logout) nur bei konfiguriertem OIDC.
    if (opts.auth.oidc) {
      registerAuthRoutes(app, {
        db,
        oidc: opts.auth.oidc,
        insecureCookies: opts.auth.insecureCookies,
        oidcAllowInsecure: opts.auth.oidcAllowInsecure,
        rateLimit: rateLimits.auth,
        publicBaseUrl: opts.publicBaseUrl,
        sharedForgejoGrant:
          opts.auth.connect?.forgejo?.clientId === opts.auth.oidc.clientId
            ? { tokenKey: opts.auth.tokenKey, connect: opts.auth.connect }
            : undefined,
      })
    }

    // Provider-Verknüpfungs-Routen (Task 4) nur bei konfiguriertem Connect.
    if (opts.auth.connect) {
      registerConnectRoutes(app, {
        db,
        connect: opts.auth.connect,
        tokenKey: opts.auth.tokenKey,
        insecureCookies: opts.auth.insecureCookies,
        rateLimit: rateLimits.auth,
        publicBaseUrl: opts.publicBaseUrl,
      })
    }

    // GitHub sign-in (#8) doubles as the connect app (same OAuth client) —
    // only registered with BOTH `githubLogin` on and `connect.github` set,
    // works without `opts.auth.oidc` configured (GitHub-only instances).
    if (githubLoginEnabled && opts.auth.connect?.github) {
      registerGithubLoginRoutes(app, {
        db,
        github: opts.auth.connect.github,
        tokenKey: opts.auth.tokenKey,
        insecureCookies: opts.auth.insecureCookies,
        rateLimit: rateLimits.auth,
        publicBaseUrl: opts.publicBaseUrl,
      })
    }
  }

  // Zugriffsprüfer (Plan Task 5) nur, wenn Auth aktiv ist. Ohne Auth bleibt er
  // `undefined` → Lese-Routen filtern nichts (1c-Verhalten, Bestands-Tests).
  // Schreibrechte-Probe + Nutzer-Provider-Factory (Phase 2a Task 1/2) laufen
  // über dieselbe `permDeps`/`userProviderDeps`-Basis — beide nutzen
  // `opts.forgejoBaseUrl`, NICHT `opts.auth.connect?.forgejo?.baseUrl` (siehe
  // Kommentar bei `AppOptions.forgejoBaseUrl` oben: eine Quelle für alle drei
  // Verwendungen, unabhängig davon, ob Forgejo-OAuth-Kontoverknüpfung separat
  // konfiguriert ist).
  let access: SpaceAccess | undefined
  let canWrite: ((userId: string, space: SpaceConfig) => Promise<boolean>) | undefined
  let userProvider: ((userId: string, space: SpaceConfig) => ReturnType<typeof getUserProvider>) | undefined
  if (opts.auth && db) {
    const permDeps: PermissionDeps = {
      db,
      tokenKey: opts.auth.tokenKey,
      forgejoBaseUrl: opts.forgejoBaseUrl,
      // Issue #25 (Token-Refresh in der Permission-Probe): dieselbe
      // Connect-Konfiguration wie beim Nutzer-Provider unten — ohne sie bleibt
      // ein 401 bei der Probe unheilbar (siehe `PermissionDeps.connect`-Kommentar).
      connect: opts.auth.connect,
      log: app.log,
    }
    access = { canRead: (userId, space) => canReadSpace(permDeps, userId, space) }
    canWrite = (userId, space) => canWriteSpace(permDeps, userId, space)

    const userProviderDeps: UserProviderDeps = {
      db,
      tokenKey: opts.auth.tokenKey,
      forgejoBaseUrl: opts.forgejoBaseUrl,
      // Task 4b/4 (Token-Refresh): dieselbe Connect-Konfiguration wie bei der
      // Kontoverknüpfung selbst — ohne sie bleibt Refresh unmöglich (siehe
      // `UserProviderDeps.connect`-Kommentar, `drafts/user-provider.ts`).
      connect: opts.auth.connect,
    }
    userProvider = (userId, space) => getUserProvider(userProviderDeps, userId, space)
  }

  // Theme read routes (theming Stage 2): always registered — without an instance
  // config or provider registry they answer with the defaults (fail-soft loader).
  // Stage 3: `spaces`/`access` add the space layer and `GET /api/spaces/:space/theme`.
  // Stage 4: `canWrite`/`userProvider` (auth only) add `PUT`/`DELETE` on both theme paths.
  registerThemeRoutes(app, {
    providerRegistry: opts.providerRegistry,
    instanceConfig: opts.instanceConfig,
    spaces: opts.spaces,
    access,
    canWrite,
    getUserProvider: userProvider,
  })
  // Settings page reads (Stage 5): scopes and one-scope editor state, behind the session gate.
  registerThemeEditorRoutes(app, {
    providerRegistry: opts.providerRegistry,
    instanceConfig: opts.instanceConfig,
    spaces: opts.spaces,
    access,
    canWrite,
    getUserProvider: userProvider,
  })
  // Contrast thresholds (Stage 4.2): GET always; PUT/DELETE only with auth
  // (`canWrite`/`userProvider`), committing with the caller's own token.
  registerThemeContrastRoutes(app, {
    providerRegistry: opts.providerRegistry,
    instanceConfig: opts.instanceConfig,
    canWrite,
    getUserProvider: userProvider,
  })

  // Webhook-, Admin- und Lese-Routen nur registrieren, wenn Space-Konfiguration +
  // Provider-Registry vorhanden sind (alles optional, Plan Task 4/5/6 —
  // Bestands-Tests unverändert).
  if (db && opts.spaces && opts.providerRegistry) {
    registerWebhookRoutes(app, {
      db,
      spaces: opts.spaces,
      providerRegistry: opts.providerRegistry,
      secrets: opts.webhookSecrets ?? {},
      onIndexed: opts.onIndexed,
      onCleanup: opts.onCleanup,
      counters: opsCounters,
    })
    registerAdminRoutes(app, {
      db,
      spaces: opts.spaces,
      providerRegistry: opts.providerRegistry,
      adminToken: opts.adminToken,
      counters: opsCounters,
    })
    registerPagesRoutes(app, {
      db,
      spaces: opts.spaces,
      providerRegistry: opts.providerRegistry,
      access,
      // `workflow`-Feld (Phase 2d Task 2): dieselbe gecachte Schreibrechte-
      // Probe wie bei Draft-/Lock-/Media-Routen — Entwurfs-/Review-Auskunft
      // ist Teil des Schreib-Workflows, nie an reine Leser durchgereicht.
      canWrite,
    })
    // Seitenversionierung Etappe 2: Versionsliste und -diff, nur Leserecht.
    registerVersionRoutes(app, { db, spaces: opts.spaces, providerRegistry: opts.providerRegistry, access })
    registerSearchRoutes(app, {
      db,
      spaces: opts.spaces,
      access,
      canWrite,
      rateLimit: rateLimits.search,
      providerRegistry: opts.providerRegistry,
    })
    registerBrokenLinksRoutes(app, { db, spaces: opts.spaces, access })
    registerMetadataSchemaRoutes(app, {
      spaces: opts.spaces,
      providerRegistry: opts.providerRegistry,
      access,
      // PUT .../metadata-schema (Schema-Editor-UI, Metadaten-Feature M4): NUR
      // registriert, wenn Auth aktiv ist (dieselbe Bedingung wie bei
      // `registerTemplatesRoutes`s POST-Zweig) — Nutzer-Provider bewusst NICHT
      // `opts.providerRegistry` (Service-Account, bleibt dem GET-Lesepfad
      // vorbehalten), der Commit läuft mit den echten Provider-Rechten des Nutzers.
      canWrite,
      getUserProvider: userProvider,
    })
    registerGraphRoutes(app, { db, spaces: opts.spaces, providerRegistry: opts.providerRegistry, access, canWrite })
    registerTemplatesRoutes(app, {
      spaces: opts.spaces,
      providerRegistry: opts.providerRegistry,
      access,
      globalTemplates: opts.globalTemplates,
      // POST .../templates ("Als Template speichern", Phase 3c Task 4): NUR
      // registriert, wenn Auth aktiv ist (dieselbe Bedingung wie Draft-/Lock-/
      // Workflow-/Create-Page-Routen unten — `canWrite`/`userProvider` sind
      // sonst `undefined`, `registerTemplatesRoutes` lässt den POST-Zweig dann
      // aus). Nutzer-Provider bewusst NICHT `opts.providerRegistry` (Service-
      // Account, bleibt dem GET-Lesepfad vorbehalten) — der Commit nach
      // `_templates/` läuft mit den echten Provider-Rechten des Nutzers.
      canWrite,
      getUserProvider: userProvider,
    })
    registerMediaRoutes(app, {
      db,
      spaces: opts.spaces,
      providerRegistry: opts.providerRegistry,
      access,
      // `?ref=draft`-Gate (Task 1): Schreibrecht, konsistent zur Draft-Suche.
      canWrite,
    })

    // Draft-Routen (Phase 2a Task 2) erfordern echte Nutzer-Autorschaft (Plan
    // Global Constraints) — ohne Auth gibt es keinen Nutzer, dessen Token
    // verwendet werden könnte, daher nur registriert, wenn `opts.auth` (und
    // damit `access`/`canWrite`/`userProvider`) gesetzt ist. Der Schutz-Matrix-
    // Hook oben (nur registriert, wenn `opts.auth` gesetzt ist) garantiert
    // bereits `req.user !== null` innerhalb der Handler.
    if (access && canWrite && userProvider) {
      registerDraftsRoutes(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
        maxUploadMb: opts.maxUploadMb,
      })
      // Lock-Routen (Phase 2a Task 4) teilen sich dieselben Gates/Deps wie die
      // Draft-Routen (siehe `resolveWriteContext`, `routes/drafts.ts`).
      registerLocksRoutes(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
      })
      // Workflow-Routen (Phase 2d Task 3) teilen sich dieselben Gates/Deps
      // ebenfalls (siehe `resolveWriteContext`, `routes/drafts.ts`).
      registerWorkflowRoutes(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
        publicBaseUrl: opts.publicBaseUrl,
      })
      // Seite löschen (`DELETE /api/pages/:id`) teilt sich dieselbe Gate-Basis
      // (`resolveWriteContext`, `routes/drafts.ts`) wie die übrigen Draft-/
      // Workflow-Routen.
      registerDeletePageRoute(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
      })
      // Seitenanlage (Phase 2d Task 5, `POST /api/pages`) teilt sich dieselben
      // Deps/Gate-Basis (`resolveNewPageWriteContext`, `routes/drafts.ts`).
      registerCreatePageRoute(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
        // Template-Auflösung (`templateId`, Phase 3c Task 3) nutzt dieselbe
        // Service-Account-Registry wie `registerTemplatesRoutes` — NICHT die
        // nutzer-eigene `getUserProvider` (Lesen der Vorlage ist kein
        // Schreibzugriff auf das Nutzer-Repo).
        providerRegistry: opts.providerRegistry,
        globalTemplates: opts.globalTemplates,
      })
      // Seite verschieben/umbenennen (Phase 3.2, `POST /api/pages/:id/move`)
      // teilt sich dieselbe Gate-Basis (`resolveWriteContext`, `routes/drafts.ts`).
      registerMovePageRoute(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
      })
      // Seite aus dem Archiv holen (Feature „Unarchive", `POST
      // /api/pages/:id/unarchive`) teilt sich dieselbe Gate-Basis
      // (`resolveWriteContext`, `routes/drafts.ts`) wie die übrigen
      // Schreib-Routen.
      registerUnarchivePageRoute(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
      })
      // Baum-Umsortierung (Phase 3.3, `PUT /api/spaces/:space/order`) teilt sich
      // dieselbe Gate-Basis wie die Seitenanlage (`resolveNewPageWriteContext`,
      // `routes/drafts.ts`) — Einstiegspunkt ist der Space, nicht eine bereits
      // bekannte Seiten-Id.
      registerReorderRoute(app, {
        db,
        spaces: opts.spaces,
        access,
        canWrite,
        getUserProvider: userProvider,
      })
    }
  }

  app.addHook('onClose', async () => {
    await pool?.end()
  })

  return app
}
