import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { branchExists, cleanupMergedDraft, findPageIdForDraftBranch } from '../drafts/lifecycle.js'
import { indexChangedFiles, type IncrementalReport } from '../indexer/incremental.js'
import type { OpsCounters } from '../ops/counters.js'
import type { SpaceConfig } from '../spaces/config.js'
import { invalidateSpaceTheme, SPACE_THEME_PATH } from '../theme/space-theme.js'

export interface WebhookSecrets {
  forgejo?: string
  github?: string
}

export type WebhookIndexResult =
  | { space: string; report: IncrementalReport }
  | { space: string; error: unknown }

/** Ergebnis eines webhook-getriebenen Nach-Merge-Cleanups (Phase 2d Task 2,
 *  `pull_request`-Event) — Test-Hook-Pendant zu `WebhookIndexResult`. `pageId`
 *  ist `null`, wenn die Rückwärts-Suche (`findPageIdForDraftBranch`, Fix-Runde
 *  1) keine offene Draft-Zeile/keinen Lock fand, die zum Head-Branch passt —
 *  dann lief nur ein Branch-only-Fallback-Cleanup, siehe `handlePullRequest`. */
export type WebhookCleanupResult =
  | { space: string; pageId: string | null }
  | { space: string; pageId: string | null; error: unknown }

export interface WebhookDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  secrets: WebhookSecrets
  /** Test-Hook: wird nach jeder (asynchron angestoßenen) Indexierung aufgerufen. */
  onIndexed?: (result: WebhookIndexResult) => void
  /** Test-Hook: wird nach jedem (asynchron angestoßenen) Nach-Merge-Cleanup
   *  eines `pull_request`-Events aufgerufen (Phase 2d Task 2). */
  onCleanup?: (result: WebhookCleanupResult) => void
  /** Task 5 (Betrieb): `webhookErrors` wird in den beiden echten
   *  Fehlerpfaden erhöht — asynchrones Indexieren (`handlePush`) und
   *  Nach-Merge-Cleanup (`cleanupAfterMerge`) — NICHT bei ignorierten/
   *  erwarteten 202-Antworten (kaputtes JSON, unbekanntes Repo, kein
   *  main-Branch/-Base, PR nicht gemergt). `buildApp` reicht dieselbe
   *  `OpsCounters`-Instanz durch, die auch `GET /admin/status` beliefert. */
  counters: OpsCounters
}

interface PushCommitPayload {
  added?: string[]
  modified?: string[]
  removed?: string[]
}

interface PushPayload {
  ref?: string
  repository?: {
    name?: string
    owner?: { login?: string; username?: string; name?: string }
  }
  commits?: PushCommitPayload[]
}

export interface NormalizedPush {
  owner: string
  repo: string
  /** Branch-Name ohne `refs/heads/`-Präfix, oder null bei Nicht-Branch-Refs (z. B. Tags). */
  branch: string | null
  changedPaths: string[]
  removedPaths: string[]
}

/**
 * Normalisiert ein GitHub-/Forgejo-Push-Payload zu einer providerneutralen
 * Sicht. `commits[].added/modified/removed` werden über alle Commits des
 * Push aggregiert und dedupliziert; taucht ein Pfad sowohl geändert als auch
 * entfernt auf, gewinnt der Endzustand (letzter Commit in der Liste zählt).
 */
export function normalizePushEvent(payload: PushPayload): NormalizedPush {
  const owner =
    payload.repository?.owner?.login
    ?? payload.repository?.owner?.username
    ?? payload.repository?.owner?.name
    ?? ''
  const repo = payload.repository?.name ?? ''
  const ref = payload.ref ?? ''
  const match = /^refs\/heads\/(.+)$/.exec(ref)
  const branch = match ? match[1]! : null

  const state = new Map<string, 'changed' | 'removed'>()
  for (const commit of payload.commits ?? []) {
    for (const p of commit.added ?? []) state.set(p, 'changed')
    for (const p of commit.modified ?? []) state.set(p, 'changed')
    for (const p of commit.removed ?? []) state.set(p, 'removed')
  }

  const changedPaths: string[] = []
  const removedPaths: string[] = []
  for (const [p, s] of state) {
    if (s === 'changed') changedPaths.push(p)
    else removedPaths.push(p)
  }

  return { owner, repo, branch, changedPaths, removedPaths }
}

/**
 * `pull_request`-Webhook-Payload (Phase 2d Task 2) — GitHub-Form laut GitHub-
 * Doku (`action`, `pull_request.merged`, `pull_request.head.ref`,
 * `pull_request.base.ref`, `repository.owner.login`, siehe
 * https://docs.github.com/webhooks/webhook-events-and-payloads#pull_request).
 * Forgejo/Gitea spiegelt exakt dieselbe Form (`api.PullRequestPayload`:
 * `action`, `pull_request.merged` als Bool, `pull_request.head.ref`,
 * `pull_request.base.ref`) — ANGENOMMENE Form, mangels Gitea-Testcontainer-
 * Abdeckung für `pull_request`-Events NICHT gegen einen echten Forgejo-
 * Container verifiziert (nur `push` läuft containerbasiert, siehe
 * `webhooks.test.ts`); `normalizePullRequestEvent` wird daher NUR mit von
 * Hand gebauten Payloads getestet, dort explizit dokumentiert. Ein
 * abweichendes Feld auf einer Provider-Seite bräuchte einen eigenen Zweig
 * (analog zu `payload.repository?.owner?.username` bei `normalizePushEvent`).
 */
interface PullRequestPayload {
  action?: string
  pull_request?: {
    merged?: boolean
    head?: { ref?: string }
    base?: { ref?: string }
  }
  repository?: {
    name?: string
    owner?: { login?: string; username?: string; name?: string }
  }
}

export interface NormalizedPullRequestEvent {
  owner: string
  repo: string
  /** `true` gdw. `action === 'closed' && pull_request.merged === true`. */
  merged: boolean
  headBranch: string | null
  baseBranch: string | null
}

/** Normalisiert ein GitHub-/Forgejo-`pull_request`-Payload — reine
 *  Feld-Extraktion, keine Cleanup-Entscheidung (die trifft `handlePullRequest`
 *  anhand von `merged` + Branch-Mustern, analog zu `normalizePushEvent`). */
export function normalizePullRequestEvent(payload: PullRequestPayload): NormalizedPullRequestEvent {
  const owner =
    payload.repository?.owner?.login
    ?? payload.repository?.owner?.username
    ?? payload.repository?.owner?.name
    ?? ''
  const repo = payload.repository?.name ?? ''
  const merged = payload.action === 'closed' && payload.pull_request?.merged === true
  const headBranch = payload.pull_request?.head?.ref ?? null
  const baseBranch = payload.pull_request?.base?.ref ?? null
  return { owner, repo, merged, headBranch, baseBranch }
}

/** true, wenn der Branch nach dem Muster `draft/<slug>` aussieht — reine
 *  Präfix-Prüfung, KEINE pageId-Extraktion (Fix-Runde 1, Important-Review-
 *  Befund): der Slug ist für den NORMALFALL (Seiten ohne Frontmatter-`id`,
 *  Fallback-Id `path:<space>/<datei>` aus `indexer/index-space.ts`) durch den
 *  irreversiblen Hash-Suffix aus `drafts/branch-name.ts` NICHT mehr zur
 *  ursprünglichen pageId rückrechenbar — naives Strippen von `draft/` lieferte
 *  hier bisher eine falsche Id, die `cleanupMergedDraft`s DB-Aufräumen
 *  (`clearDraftIndex`/`clearLock`) verfehlen ließ (Branch wurde zwar
 *  gelöscht, DB-Zeilen blieben verwaist). Die echte pageId ermittelt
 *  `handlePullRequest` seither per Rückwärts-Suche über die offenen Drafts
 *  des Space (`findPageIdForDraftBranch`, `drafts/lifecycle.ts`). */
function isDraftBranch(branch: string | null): branch is string {
  return branch !== null && branch.startsWith('draft/')
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 über den Raw-Body. */
function verifyGitHubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  return safeCompare(header, expected)
}

/** Forgejo/Gitea: `X-Gitea-Signature: <hex>` (kein Präfix), HMAC-SHA256 über den Raw-Body. */
function verifyForgejoSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  return safeCompare(header, expected)
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Registriert `POST /webhooks/forgejo` und `POST /webhooks/github`. Raw-Body-
 * HMAC-Prüfung ist per `addContentTypeParser` NUR auf diese beiden Routen
 * skaliert (eigenes Sub-Plugin), damit andere Routen von der normalen
 * JSON-Verarbeitung unberührt bleiben.
 *
 * Ablauf je Request: Signatur prüfen (fehlt/ungültig → 401, keine
 * Verarbeitung, UNVERÄNDERT seit Phase 1c — greift für beide Event-Typen
 * gleichermaßen) → Event-Typ-Header auswerten (Forgejo/Gitea `X-Gitea-Event`,
 * GitHub `X-GitHub-Event`; fehlt der Header oder ist er nicht `pull_request`,
 * bleibt es beim Bestandsverhalten: `push` — der Header war vorher implizit
 * `push`, ohne ihn zu lesen) → Payload normalisieren → nur relevante Events
 * verarbeiten (sonst 202 „ignoriert“) → sofort 202 antworten → Folgearbeit
 * asynchron anstoßen (fire-and-forget, Fehler geloggt, Test-Hook nach
 * Abschluss: `onIndexed` für `push`, `onCleanup` für `pull_request`, Phase 2d
 * Task 2).
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDeps): void {
  app.register(async (instance) => {
    // Nur innerhalb dieses Sub-Plugins: Raw-Body statt geparstem JSON, da wir
    // die exakten Bytes für die HMAC-Prüfung brauchen.
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body)
    })

    instance.post('/webhooks/forgejo', async (req, reply) => {
      const raw = req.body as Buffer
      const header = req.headers['x-gitea-signature']
      const secret = deps.secrets.forgejo
      if (!secret || !verifyForgejoSignature(secret, raw, headerValue(header))) {
        return reply.code(401).send({ status: 'unauthorized', reason: 'ungültige oder fehlende Signatur' })
      }
      if (headerValue(req.headers['x-gitea-event']) === 'pull_request') {
        return handlePullRequest(deps, 'forgejo', raw, req, reply)
      }
      return handlePush(deps, 'forgejo', raw, req, reply)
    })

    instance.post('/webhooks/github', async (req, reply) => {
      const raw = req.body as Buffer
      const header = req.headers['x-hub-signature-256']
      const secret = deps.secrets.github
      if (!secret || !verifyGitHubSignature(secret, raw, headerValue(header))) {
        return reply.code(401).send({ status: 'unauthorized', reason: 'ungültige oder fehlende Signatur' })
      }
      if (headerValue(req.headers['x-github-event']) === 'pull_request') {
        return handlePullRequest(deps, 'github', raw, req, reply)
      }
      return handlePush(deps, 'github', raw, req, reply)
    })
  })
}

function headerValue(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h
}

async function handlePush(
  deps: WebhookDeps,
  provider: 'forgejo' | 'github',
  rawBody: Buffer,
  req: FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<void> {
  let payload: PushPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as PushPayload
  } catch {
    reply.code(202).send({ status: 'ignored', reason: 'ungültiges JSON' })
    return
  }

  const normalized = normalizePushEvent(payload)

  if (normalized.branch !== 'main') {
    reply.code(202).send({ status: 'ignored', reason: 'kein main-Branch' })
    return
  }

  const space = deps.spaces.find(
    (s) => s.provider === provider && s.owner === normalized.owner && s.repo === normalized.repo,
  )
  if (!space) {
    reply.code(202).send({ status: 'ignored', reason: 'unbekanntes Repository' })
    return
  }

  reply.code(202).send({ status: 'accepted' })

  // A push that touches the space theme or its templates empties that
  // space's theme cache (July spec, "Zwischenspeicherung"); the next read
  // loads the file again instead of waiting for the five-minute expiry.
  if ([...normalized.changedPaths, ...normalized.removedPaths].some(isThemePath)) {
    invalidateSpaceTheme(space.id)
  }

  // Asynchron: Antwort ist bereits raus, Indexierung läuft im Hintergrund.
  const gitProvider = deps.providerRegistry(space)
  indexChangedFiles(
    { db: deps.db, provider: gitProvider, counters: deps.counters },
    space,
    normalized.changedPaths,
    normalized.removedPaths,
  )
    .then((report) => {
      deps.onIndexed?.({ space: space.id, report })
    })
    .catch((error: unknown) => {
      req.log.error({ err: error, space: space.id }, 'webhook: inkrementelles Indexieren fehlgeschlagen')
      // Task 5 (Betrieb): echter Fehlerpfad — das Indexieren selbst ist
      // gescheitert (z. B. DB nicht erreichbar), nicht bloß ein ignoriertes Event.
      deps.counters.increment('webhook_errors')
      deps.onIndexed?.({ space: space.id, error })
    })
}

/**
 * Verarbeitet ein `pull_request`-Event (Phase 2d Task 2, Spec §4 „Nach Merge:
 * Webhook → […] Draft-Branch löschen"): nach einem NATIV (im Forgejo-/GitHub-
 * UI) gemergeten Review-PR räumt `cleanupMergedDraft` Branch, Draft-Index und
 * Lock auf — derselbe Cleanup-Pfad, den ab Task 3 auch die synchrone Release-
 * Route nutzt. Das Neu-Rendern der main-Seite übernimmt NICHT dieser Handler,
 * sondern der ohnehin eintreffende `push`-auf-`main`-Webhook (jeder Merge ist
 * zugleich ein Push auf `main`) — bewusst kein doppelter Indexierungs-Pfad.
 *
 * Nicht-gemergete `closed`-Events (PR abgelehnt/geschlossen ohne Merge) → nur
 * 202 „ignoriert“, der Draft bleibt unangetastet stehen (Autor kann
 * weiterarbeiten, Spec-Vorgabe: kein automatisches Aufräumen ohne Merge).
 */
async function handlePullRequest(
  deps: WebhookDeps,
  provider: 'forgejo' | 'github',
  rawBody: Buffer,
  req: FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<void> {
  let payload: PullRequestPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as PullRequestPayload
  } catch {
    reply.code(202).send({ status: 'ignored', reason: 'ungültiges JSON' })
    return
  }

  const normalized = normalizePullRequestEvent(payload)

  if (!normalized.merged) {
    reply.code(202).send({ status: 'ignored', reason: 'PR nicht gemergt' })
    return
  }
  if (normalized.baseBranch !== 'main') {
    reply.code(202).send({ status: 'ignored', reason: 'kein main-Base' })
    return
  }

  const space = deps.spaces.find(
    (s) => s.provider === provider && s.owner === normalized.owner && s.repo === normalized.repo,
  )
  if (!space) {
    reply.code(202).send({ status: 'ignored', reason: 'unbekanntes Repository' })
    return
  }

  const headBranch = normalized.headBranch
  if (!isDraftBranch(headBranch)) {
    reply.code(202).send({ status: 'ignored', reason: 'Head-Branch ist kein Draft-Branch' })
    return
  }

  reply.code(202).send({ status: 'accepted' })

  // Asynchron: Antwort ist bereits raus, Cleanup läuft im Hintergrund.
  const gitProvider = deps.providerRegistry(space)
  void cleanupAfterMerge(deps, gitProvider, space, headBranch, req)
}

/**
 * Führt den eigentlichen Nach-Merge-Cleanup durch (Fix-Runde 1, Important-
 * Review-Befund): ermittelt zunächst per Rückwärts-Suche
 * (`findPageIdForDraftBranch`) die echte pageId zum Head-Branch — das
 * reversiert dabei auch den irreversiblen Hash-Suffix, den `draftBranchName`
 * für Ids mit git-unsicheren Zeichen anhängt (der NORMALFALL, siehe
 * `isDraftBranch`-Kommentar). Ein Treffer → `cleanupMergedDraft` räumt Branch,
 * Draft-Index und Lock wie gehabt auf. KEIN Treffer (z. B. ein Retry nach
 * bereits erfolgtem Cleanup, oder ein Branch, der nicht aus diesem Workflow
 * stammt) → nur der Branch wird (tolerant, ggf. ist er schon weg) entfernt,
 * mit Log — kein Schaden, aber auch kein Aufräumen von DB-Zeilen, die die
 * Suche nicht zuordnen konnte.
 */
async function cleanupAfterMerge(
  deps: WebhookDeps,
  provider: GitProvider,
  space: SpaceConfig,
  headBranch: string,
  req: FastifyRequest,
): Promise<void> {
  let pageId: string | null = null
  try {
    pageId = await findPageIdForDraftBranch({ db: deps.db }, space.id, headBranch)
    if (pageId === null) {
      req.log.warn(
        { space: space.id, headBranch },
        'webhook: Rückwärts-Suche fand keine offene Draft-Zeile/keinen Lock zu diesem Head-Branch ' +
          '— nur Branch-Cleanup (DB ggf. bereits sauber, oder der Branch stammt nicht aus diesem Workflow)',
      )
      if (await branchExists(provider, space.repoRef, headBranch)) {
        await provider.deleteBranch(space.repoRef, headBranch)
      }
    } else {
      await cleanupMergedDraft({ db: deps.db }, provider, space.repoRef, pageId)
    }
    deps.onCleanup?.({ space: space.id, pageId })
  } catch (error) {
    req.log.error(
      { err: error, space: space.id, pageId, headBranch },
      'webhook: Draft-Cleanup nach Merge fehlgeschlagen',
    )
    // Task 5 (Betrieb): echter Fehlerpfad — der Cleanup nach einem echten Merge ist
    // gescheitert (Branch-Löschung/DB-Aufräumen), nicht der harmlose "kein Treffer"-Fall oben.
    deps.counters.increment('webhook_errors')
    deps.onCleanup?.({ space: space.id, pageId, error })
  }
}

/** `_meta/theme.yaml`, the template library `_meta/themes/*` and the brand files `_meta/brand/*`. */
function isThemePath(path: string): boolean {
  return path === SPACE_THEME_PATH || path.startsWith('_meta/themes/') || path.startsWith('_meta/brand/')
}
