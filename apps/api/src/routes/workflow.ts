import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import type { GitProvider, PullRequestInfo, RepoRef } from '@f451/git-provider'
import { ConflictError, NotFoundError, ProviderError } from '@f451/git-provider'
import { diffMarkdown, parsePage, parseVersion, type VersionBump } from '@f451/markdown'
import { branchExists, cleanupMergedDraft } from '../drafts/lifecycle.js'
import { draftBranchName } from '../drafts/branch-name.js'
import { DraftUpdateContentLostError, updateDraft, type UpdateStrategy } from '../drafts/update.js'
import { applyVersionOnDraft, fillReleaseMetadataOnDraft } from '../drafts/release-metadata.js'
import { pages, pageVersions } from '../db/schema.js'
import { indexChangedFiles } from '../indexer/incremental.js'
import { buildResolveImage, buildResolveLink, LinkResolver, type ResolvablePage } from '../indexer/resolve-links.js'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'
import { resolveWriteContext, type DraftsDeps } from './drafts.js'
// Befund 3 (Final-Review): dieselbe Versionsfeld-Ermittlung wie `GET
// /api/pages/:id` — s. Kommentar an `resolveVersionFields` in `pages.ts`.
import { resolveVersionFields } from './pages.js'

/**
 * Workflow-Routen (Plan Task 3, Spec §4): „Review anfordern" (PR eröffnen),
 * „Freigeben & mergen" (approve + merge + synchroner Cleanup/Reindex) und
 * „Entwurf aktualisieren" (Draft↔main-Randfall). Dieselbe Gate-Kette wie
 * Draft-/Lock-Routen (`resolveWriteContext`, `routes/drafts.ts`) — bewusst
 * wiederverwendet statt dupliziert.
 */

/** Erweitert `DraftsDeps` (dieselbe Gate-Kette braucht dieselben Felder) um
 *  `publicBaseUrl` (Finding 2, Fix-Runde 1) — NICHT auf `DraftsDeps` selbst
 *  gepackt, das ist reines Workflow-Bedürfnis (Review-PR-Body-Link), keine
 *  Draft-Route braucht es. */
export type WorkflowDeps = DraftsDeps & {
  /** Öffentliche Basis-URL der f451-Oberfläche (`F451_PUBLIC_BASE_URL`, siehe
   *  `AppOptions.publicBaseUrl` in `app.ts`). Optional — ohne sie bleibt der
   *  bisherige, linklose Standardtext im Review-PR-Body (Bestandsverhalten,
   *  keine Konfigurationspflicht). */
  publicBaseUrl?: string
  /** Injectbare Uhr (Default `Date.now`, Muster `auth/permissions.ts`) — NUR
   *  für die `fillOnRelease`-Freigabedatum-Vorbelegung (Metadaten-Feature M3b
   *  Teil B, `POST /release`) gebraucht, damit Tests ein deterministisches
   *  Freigabedatum erwarten können. */
  now?: () => number
}

/** ISO-Datum OHNE Uhrzeit (`"2026-07-16"`) — Format für `type: date`-Felder
 *  im Metadaten-Erfass-Formular (Metadaten-Feature M3, `apps/web/lib/metadata-form.ts`),
 *  hier für die `fillOnRelease: 'date'`-Vorbelegung (Teil B) nachgebildet. */
function isoDateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Backoff-Rahmen für das Mergebarkeits-Polling nach `POST /review` (Plan Task 3:
 *  "~5s Poll-Budget", knapper als `forgejo.ts`s Merge-internes Backoff [15s] —
 *  hier nur Auskunft für die Review-Anzeige, kein Merge-Versuch). */
const REVIEW_MERGEABLE_POLL_BUDGET_MS = 5_000
const REVIEW_MERGEABLE_POLL_START_MS = 200

/** Poll-Budget, bis Forgejo den ALTEN Review-PR nach der Branch-Löschung
 *  tatsächlich geschlossen hat (`POST /draft/update`, s.
 *  {@link waitForPrClosed}) — die Schließung läuft providerseitig asynchron
 *  (im Task-7-Dev-Smoke ~1 s nach `discardDraft`); 10 s als großzügige
 *  Obergrenze. */
const UPDATE_PR_CLOSE_POLL_BUDGET_MS = 10_000
const UPDATE_PR_CLOSE_POLL_START_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Pollt `getPullRequest`, bis `mergeable` nicht mehr `null` ist oder das Budget
 *  ausgeschöpft ist. Liefert `null`, wenn der Provider die Mergebarkeit bis
 *  dahin nicht berechnet hat — kein Fehler, die UI zeigt dann "wird berechnet". */
async function pollMergeable(provider: GitProvider, repo: RepoRef, number: number): Promise<boolean | null> {
  const deadline = Date.now() + REVIEW_MERGEABLE_POLL_BUDGET_MS
  let delay = REVIEW_MERGEABLE_POLL_START_MS
  for (;;) {
    const pr = await provider.getPullRequest(repo, number)
    if (pr.mergeable !== null) return pr.mergeable
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await sleep(Math.min(delay, remaining))
    delay *= 2
  }
}

/**
 * Baut den Link zur Review-Ansicht einer Seite (Finding 2, Fix-Runde 1):
 * `<publicBaseUrl>/wiki/<space>/<pageId>/review`, jedes Segment einzeln
 * `encodeURIComponent`-kodiert — dasselbe Muster wie `apps/web/lib/urls.ts`
 * (`wikiPageHref`/`wikiPageEditHref`), hier lokal nachgebaut, weil `apps/api`
 * keine Abhängigkeit auf `apps/web` haben darf (getrennte Deployables,
 * Fallback-Ids wie `path:<space>/<datei>.md` enthalten `/` und `:`, die ohne
 * Kodierung zusätzliche Pfadsegmente vortäuschen würden).
 */
function reviewPageUrl(publicBaseUrl: string, spaceId: string, pageId: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '')
  return `${base}/wiki/${encodeURIComponent(spaceId)}/${encodeURIComponent(pageId)}/review`
}

/** Standardtext für neu eröffnete Review-PRs. Enthält einen klickbaren Link
 *  zur Review-Ansicht NUR, wenn `publicBaseUrl` konfiguriert ist (Finding 2,
 *  Fix-Runde 1, `F451_PUBLIC_BASE_URL`) — ohne sie kennt die API ihre eigene
 *  öffentliche Adresse nicht, der Text bleibt beim bisherigen, linklosen
 *  Standard (Titel + Seiten-Id verweisen weiterhin eindeutig auf die Seite). */
function reviewPrBody(pageId: string, title: string, spaceId: string, publicBaseUrl?: string): string {
  const base = `Review-Anfrage für „${title}" (Seite \`${pageId}\`), erstellt über die f451-Plattform.`
  if (!publicBaseUrl) return base
  return `${base}\n\n${reviewPageUrl(publicBaseUrl, spaceId, pageId)}`
}

/**
 * Findet einen bereits offenen PR mit Head `branch`/Base `main`, oder legt
 * einen neuen an — IDEMPOTENT (Plan Task 3: `POST /review` liefert bei
 * bereits offenem PR dessen Bestand statt einen zweiten anzulegen). Geteilt
 * zwischen `POST /review` und `POST /draft/update` (Randfall „war ein PR
 * offen → neuen PR eröffnen", Plan Task 3 Interface: „POST-review-Logik
 * wiederverwenden"). Exportiert für einen gezielten Unit-Test (Finding 1,
 * Fix-Runde 1 — zusammen mit {@link waitForPrClosed}: Alt-PR verschwindet aus
 * der Open-Liste → die nächste Anlage muss einen NEUEN PR erzeugen statt den
 * (dann nicht mehr gelisteten) alten zurückzugeben).
 */
export async function findOrCreateOpenPr(
  provider: GitProvider,
  repo: RepoRef,
  branch: string,
  title: string,
  body: string,
): Promise<{ pr: PullRequestInfo; created: boolean }> {
  const open = await provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
  const existing = open[0]
  if (existing) return { pr: existing, created: false }
  const pr = await provider.createPullRequest(repo, { head: branch, base: 'main', title, body })
  return { pr, created: true }
}

/** Minimaler Logger-Vertrag für `waitForPrClosed`s Timeout-Zweig (Finding 2,
 *  Fix-Runde 1) — absichtlich nur die eine Methode, die gebraucht wird, statt
 *  ganz `FastifyBaseLogger` zu verlangen: Aufrufer außerhalb einer Route
 *  (z. B. Tests) können so einen trivialen Stub statt eines echten Loggers
 *  übergeben. */
export interface WaitForPrClosedLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

/** Injectbare Abhängigkeiten von `waitForPrClosed` (Finding 1+2, Fix-Runde 1):
 *  `now`/`sleep` machen das Poll-/Timeout-Verhalten deterministisch testbar
 *  (Muster `auth/permissions.ts`/`drafts/lifecycle.ts`: injectbare Uhr mit
 *  `Date.now`-Default; `apps/web/lib/editor/autosave.ts`: Zeit nie direkt aus
 *  dem Modul heraus). `log` ist der Timeout-Zweig-Kanal (Finding 2) — ohne
 *  Angabe (z. B. ein künftiger Nicht-Route-Aufrufer) bleibt er stumm statt zu
 *  crashen. */
export interface WaitForPrClosedDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: WaitForPrClosedLogger
}

/**
 * Wartet, bis PR `number` NICHT mehr in der Open-Liste des Branches auftaucht
 * (Race-Fix, Phase 2d Task 7 — im Dev-Smoke real beobachtet): Forgejo
 * schließt einen PR nach der Löschung seines Head-Branches ASYNCHRON. Ruft
 * `POST /draft/update` unmittelbar nach `discardDraft` die idempotente
 * PR-Anlage ({@link findOrCreateOpenPr}) auf, listet die den ALTEN,
 * faktisch bereits toten PR noch als offen und liefert ihn als „Bestand"
 * zurück, statt einen neuen zu eröffnen — kurz darauf schließt Forgejo ihn,
 * und es existiert GAR KEIN offener PR mehr (`GET /review` → dauerhaft 404,
 * der Review-Zustand der Seite ist verloren). Deshalb wird hier VOR der
 * Anlage-Logik auf die tatsächliche Schließung gewartet.
 *
 * TRADE-OFF (Finding 2, Fix-Runde 1), bewusst dokumentiert: das Poll-Budget
 * REDUZIERT die Race-Wahrscheinlichkeit, es beseitigt sie nicht absolut —
 * läuft das Budget ab, ohne dass der PR verschwindet (Provider hält ihn
 * wirklich offen, z. B. eine Forgejo-Version, die den PR beim schnellen
 * Branch-Neuanlegen doch weiterverwendet, ODER Forgejo braucht in diesem
 * Einzelfall länger als 10 s), ist das KEIN harter Fehler: die nachfolgende
 * idempotente Anlage (`findOrCreateOpenPr`) liefert dann eben diesen
 * weiterhin offenen PR als „Bestand" zurück statt einen neuen zu eröffnen —
 * schließt Forgejo ihn DANACH doch noch (derselbe Race, nur außerhalb des
 * Budgets), ist der zurückgegebene PR retrospektiv falsch und der
 * Review-Zustand kann wie vor Task 7 verloren gehen. Damit dieser
 * Grenzfall nicht spurlos bleibt, wird er hier geloggt; Recovery ist ein
 * erneutes `POST /review` (öffnet dann, weil kein PR mehr offen ist, einen
 * neuen).
 */
export async function waitForPrClosed(
  provider: GitProvider,
  repo: RepoRef,
  branch: string,
  number: number,
  deps: WaitForPrClosedDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now
  const doSleep = deps.sleep ?? sleep
  const deadline = now() + UPDATE_PR_CLOSE_POLL_BUDGET_MS
  let delay = UPDATE_PR_CLOSE_POLL_START_MS
  for (;;) {
    const open = await provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
    if (!open.some((pr) => pr.number === number)) return
    const remaining = deadline - now()
    if (remaining <= 0) {
      deps.log?.warn(
        { prNumber: number, branch, budgetMs: UPDATE_PR_CLOSE_POLL_BUDGET_MS },
        'waitForPrClosed: Poll-Budget ausgeschöpft, Alt-PR gilt laut Provider weiterhin als offen — wird als '
          + '„Bestand" zurückgegeben (Race-Wahrscheinlichkeit reduziert, kein absoluter Fix). Schließt der '
          + 'Provider ihn danach doch noch, kann der Review-Zustand verloren gehen; Recovery: erneutes POST review.',
      )
      return
    }
    await doSleep(Math.min(delay, remaining))
    delay *= 2
  }
}

/**
 * Entscheidet, ob ein beim Best-effort-Approve (`POST /release`) geworfener
 * Fehler toleriert werden darf (Finding 1, Fix-Runde 1). Tolerierte Klasse:
 * `ConflictError` — sowohl das Self-Review-Verbot als auch "bereits
 * approved" äußern sich providerseitig als Konflikt (409/422, siehe
 * `@f451/git-provider#toProviderError`; der Contract-Test aus Task 1 kennt
 * denselben Self-Approve-Fehler als `ConflictError`, siehe
 * `github.unit.test.ts`: "422 → ConflictError"). JEDER andere `ProviderError`
 * (Netzwerk, Rate-Limit, 5xx, ...) — und erst recht jeder Nicht-Provider-
 * Fehler — ist NICHT toleriert: der Reviewer muss davon erfahren
 * (`approveWarning`), statt in dem Glauben zu bleiben, seine Freigabe sei da.
 * Exportiert für einen gezielten Unit-Test (kein Forgejo-Container nötig).
 */
export function isTolerableApproveError(err: unknown): boolean {
  return err instanceof ConflictError
}

/**
 * Baut den Space-weiten `LinkResolver` für `diffMarkdown` (GET /review, Finding 2 Fix-
 * Runde 1) — EXAKT wie der Indexer (`indexSpace`/`upsertPage`) die Resolver-Menge
 * baut, hier auf den DB-Index statt auf frisch gelesene Repo-Dateien gestützt (der
 * Diff selbst liest main/Draft-Inhalt direkt vom Provider, siehe Kommentar oben in
 * diff.ts — der Resolver braucht dafür nur Id/Pfad/Titel ALLER Seiten des Space, nicht
 * deren Inhalt). Nimmt BEWUSST beide Refs (`main` UND `draft`) mit Dedupe auf `id`,
 * main-Zeile gewinnt bei einem Konflikt: eine ganz neue Seite existiert bis zu ihrem
 * ersten Merge nur als `ref='draft'`-Zeile — ohne sie mit aufzunehmen würde ein
 * Wikilink im Diff auf eine solche Draft-only-Seite fälschlich als `broken-link`
 * erscheinen, obwohl das Merge-Ziel sie sehr wohl kennt.
 */
export async function buildSpaceLinkResolver(db: DraftsDeps['db'], spaceId: string): Promise<LinkResolver> {
  const rows = await db
    .select({ id: pages.id, path: pages.path, title: pages.title, ref: pages.ref })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), inArray(pages.ref, ['main', 'draft'])))

  const resolverPages: ResolvablePage[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.ref !== 'main') continue
    resolverPages.push({ id: row.id, path: row.path, title: row.title })
    seen.add(row.id)
  }
  for (const row of rows) {
    if (row.ref === 'main' || seen.has(row.id)) continue
    resolverPages.push({ id: row.id, path: row.path, title: row.title })
    seen.add(row.id)
  }
  return new LinkResolver(resolverPages)
}

/** Mappt einen unerwarteten Provider-Fehler auf 502 (wie `routes/drafts.ts`:
 *  „Provider nicht erreichbar → 502 mit Meldung, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const forbiddenSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, action: { type: 'string' } },
  required: ['error'],
} as const

/** `reason` optional: deckt sowohl den einfachen "kein offener PR"-409-Fall
 *  (nur `error`) als auch den Merge-Konflikt-409-Fall (`error` + `reason:
 *  'conflict'`, Plan Task 3 Interface, wörtlich) unter demselben Response-
 *  Schema ab. */
const errorWithOptionalReasonSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, reason: { type: 'string' } },
  required: ['error'],
} as const

const paramsSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const

const reviewBodySchema = {
  type: 'object',
  properties: { reviewers: { type: 'array', items: { type: 'string' } } },
} as const

const reviewResultSchema = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    url: { type: 'string' },
    state: { type: 'string' },
    mergeable: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
  },
  required: ['number', 'url', 'state', 'mergeable'],
} as const

const reviewSchema = {
  tags: ['workflow'],
  params: paramsSchema,
  body: reviewBodySchema,
  response: {
    200: reviewResultSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: errorWithOptionalReasonSchema,
    422: errorWithOptionalReasonSchema,
    502: errorSchema,
  },
} as const

const releaseBodySchema = {
  type: 'object',
  properties: {
    comment: { type: 'string' },
    // Seitenversionierung (Task 6): `bump` steuert die Sprunggröße, `note` ist
    // der Changelog-Text der Freigabe. Beide optional — ohne `bump` gilt
    // `patch` (kleinste, unauffälligste Sprunggröße als Default), ohne `note`
    // fällt der Handler auf `comment` zurück (s. `routes/workflow.ts`-Handler).
    bump: { type: 'string', enum: ['patch', 'minor', 'major'] },
    // Befund 6 (Final-Review): `maxLength` — der Text landet DAUERHAFT im
    // Frontmatter jeder freigegebenen Seite (Changelog, bis zu `CHANGELOG_LIMIT`
    // Einträge, s. `@f451/markdown#prependChangelogEntry`), ein unbegrenzter
    // String wäre unbegrenztes Datenwachstum in Git. AJV lehnt eine Verletzung
    // über den globalen Error-Handler sauber mit 400 ab (`error-format.ts#
    // formatErrorReply`, `err.validation`-Zweig — greift VOR der Response-
    // Schema-Serialisierung, s. dortiger Kommentar zur historischen
    // FST_ERR_FAILED_ERROR_SERIALIZATION-Falle), NICHT mit 500 — getestet in
    // `workflow-routes.test.ts`.
    note: { type: 'string', maxLength: 500 },
  },
} as const

const releaseResultSchema = {
  type: 'object',
  properties: {
    mergeSha: { type: 'string' },
    /** Nur gesetzt, wenn der Best-effort-Approve mit einem NICHT tolerierten
     *  Fehler fehlgeschlagen ist (Finding 1, Fix-Runde 1) — der Merge selbst
     *  war trotzdem erfolgreich (sonst gäbe es kein 200), aber der Reviewer
     *  muss wissen, dass seine Freigabe möglicherweise fehlt. */
    approveWarning: { type: 'string' },
    /** Nur gesetzt, wenn der Space Seitenversionierung aktiviert hat
     *  (`schema.versioning === true`, Task 6) — die neue, soeben vergebene
     *  Version. Unversionierte Spaces bekommen dieses Feld NIE (Bestands-
     *  verhalten bleibt für sie exakt unverändert). */
    version: { type: 'string' },
  },
  required: ['mergeSha'],
} as const

const releaseSchema = {
  tags: ['workflow'],
  params: paramsSchema,
  body: releaseBodySchema,
  response: {
    200: releaseResultSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: errorWithOptionalReasonSchema,
    422: errorWithOptionalReasonSchema,
    502: errorSchema,
  },
} as const

const requestChangesBodySchema = {
  type: 'object',
  properties: { comment: { type: 'string' } },
  required: ['comment'],
} as const

const requestChangesSchema = {
  tags: ['workflow'],
  params: paramsSchema,
  body: requestChangesBodySchema,
  response: {
    204: { type: 'null', description: 'Änderungen wurden angefordert.' },
    403: forbiddenSchema,
    404: errorSchema,
    409: errorWithOptionalReasonSchema,
    422: errorWithOptionalReasonSchema,
    502: errorSchema,
  },
} as const

const updateBodySchema = {
  type: 'object',
  properties: { strategy: { type: 'string', enum: ['take-main', 'keep-mine'] } },
  required: ['strategy'],
} as const

const workflowPrRefSchema = {
  type: 'object',
  properties: { number: { type: 'integer' }, url: { type: 'string' } },
  required: ['number', 'url'],
} as const

const updateResultSchema = {
  type: 'object',
  properties: {
    baseSha: { type: 'string' },
    content: { type: 'string' },
    state: { type: 'string' },
    pr: { anyOf: [workflowPrRefSchema, { type: 'null' }] },
    warning: { type: 'string' },
  },
  required: ['baseSha', 'content', 'state', 'pr'],
} as const

/** 502-Antwortform für `POST /draft/update` (Finding 3, Fix-Runde 1):
 *  `preservedContent` ist optional, weil ein 502 hier ZWEI Ursachen haben
 *  kann — ein Provider-Fehler VOR dem Verwerfen (kein Inhalt zu retten, wie
 *  bei den übrigen Routen) oder ein Fehler NACH dem Verwerfen
 *  (`DraftUpdateContentLostError`, IMMER mit `preservedContent`, siehe
 *  `drafts/update.ts`). */
const updateFailureSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' }, preservedContent: { type: 'string' } },
  required: ['status', 'reason'],
} as const

/** PR-Auskunft für `GET /review` (Task 4) — anders als `workflowPrRefSchema`
 *  (Task 3, nur `number`/`url`) trägt diese hier zusätzlich `state`/`mergeable`/
 *  `title`: die Review-ANSICHT braucht mehr als nur den Link, sie zeigt den PR
 *  selbst an (Titel in der Kopfzeile, Merge-Status als Badge). */
const reviewGetPrSchema = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    url: { type: 'string' },
    state: { type: 'string' },
    mergeable: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    title: { type: 'string' },
  },
  required: ['number', 'url', 'state', 'mergeable', 'title'],
} as const

const reviewGetPageSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, space: { type: 'string' }, title: { type: 'string' } },
  required: ['id', 'space', 'title'],
} as const

const reviewGetSchema = {
  tags: ['workflow'],
  params: paramsSchema,
  response: {
    200: {
      type: 'object',
      properties: {
        pr: reviewGetPrSchema,
        authorName: { type: 'string' },
        // `diff` (MarkdownDiff aus @f451/markdown) ist strukturell verschachtelt
        // (Blöcke mit beliebigem, sanitisiertem HTML) — bewusst offenes Schema
        // ({} = "beliebig"), analog zum rekursiven `children`-Feld in
        // routes/pages.ts' treeSchema, damit fast-json-stringify nichts abschneidet.
        diff: {},
        page: reviewGetPageSchema,
        // Befund 3 (Final-Review): dieselben Versionsfelder wie `GET
        // /api/pages/:id` (Task 8) — der Freigabe-Dialog (`ReviewView`) braucht
        // sie, um seinen Sprunggrößen-Abschnitt anzuzeigen. Fehlen sie hier im
        // Response-Schema, filtert Fastify sie aus der Antwort, EGAL was der
        // Handler zurückgibt — deshalb explizit deklariert. `version` fehlt bei
        // unversionierten Spaces/vor der Erstfreigabe ganz statt `undefined`
        // mitzuschicken, daher NICHT in `required`.
        versioning: { type: 'boolean' },
        version: { type: 'string' },
      },
      required: ['pr', 'authorName', 'diff', 'page', 'versioning'],
    },
    403: forbiddenSchema,
    404: errorSchema,
    502: errorSchema,
  },
} as const

const updateSchema = {
  tags: ['workflow'],
  params: paramsSchema,
  body: updateBodySchema,
  response: {
    200: updateResultSchema,
    403: forbiddenSchema,
    404: errorSchema,
    502: updateFailureSchema,
  },
} as const

/**
 * Registriert die Workflow-API (Plan Task 3): `POST /api/pages/:id/review`,
 * `POST /api/pages/:id/release`, `POST /api/pages/:id/review/request-changes`,
 * `POST /api/pages/:id/draft/update`. Eigenes (asynchron bootendes) Sub-Plugin,
 * damit die Routen in der von `@fastify/swagger` generierten OpenAPI-Spec
 * erscheinen (siehe Kommentar in `pages.ts`/`drafts.ts`).
 */
export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowDeps): void {
  app.register(async (instance) => {
    // POST /review: eröffnet den Review-PR (idempotent — ein bereits offener
    // PR wird unverändert zurückgegeben, keine doppelte Anlage/Reviewer-Anfrage).
    instance.post<{ Params: { id: string }; Body: { reviewers?: string[] } }>(
      '/api/pages/:id/review',
      { schema: reviewSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        const repo = ctx.space.repoRef
        const branch = draftBranchName(ctx.row.id)

        try {
          if (!(await branchExists(ctx.provider, repo, branch))) {
            return reply.code(409).send({ error: 'kein Entwurf vorhanden' })
          }

          // Fix #11: ein Draft-Branch ohne jeden Commit gegenüber main lässt sich bei
          // Forgejo zwar zu einem PR machen, der Merge scheitert dann aber dauerhaft
          // mit transientem 405 (s. `ForgejoProvider#mergePullRequest`-Kommentar) —
          // die 502-Antwort, die der Aufrufer davon bisher zu sehen bekam, ist kein
          // Provider-Ausfall, sondern ein leerer Entwurf. Abgefangen VOR der PR-Anlage:
          // kein PR, den der Nutzer danach von Hand wieder schließen müsste.
          if ((await ctx.provider.countCommitsAhead(repo, 'main', branch)) === 0) {
            return reply.code(422).send({ error: 'Draft has no changes', reason: 'no_changes' })
          }

          const { pr, created } = await findOrCreateOpenPr(
            ctx.provider,
            repo,
            branch,
            ctx.row.title,
            reviewPrBody(ctx.row.id, ctx.row.title, ctx.space.id, deps.publicBaseUrl),
          )

          if (created && req.body?.reviewers && req.body.reviewers.length > 0) {
            try {
              await ctx.provider.requestReviewers(repo, pr.number, req.body.reviewers)
            } catch (err) {
              // Unbekannter Nutzer o. Ä. — der PR bleibt bestehen (Plan Task 3
              // Interface, wörtlich: "PR bleibt bestehen"), nur die Reviewer-
              // Zuweisung ist gescheitert.
              if (err instanceof ProviderError) {
                return reply.code(422).send({ error: err.message })
              }
              throw err
            }
          }

          const mergeable = await pollMergeable(ctx.provider, repo, pr.number)
          return { number: pr.number, url: pr.url, state: 'review' as const, mergeable }
        } catch (err) {
          return providerErrorReply(reply, err)
        }
      },
    )

    // GET /review: visuelles Diff für die Review-Ansicht (Task 4) — kein offener PR
    // → 404 (keine 200-Antwort mit leerem Diff, es gibt schlicht nichts zu
    // reviewen). Arbeitet auf den ROHEN main-/Draft-Ständen (nicht dem Index-HTML,
    // siehe diff.ts-Kommentar) und rendert seine Blöcke selbst über
    // `diffMarkdown` (@f451/markdown, geteilte Pipeline mit der normalen
    // Seiten-Renderung).
    instance.get<{ Params: { id: string } }>(
      '/api/pages/:id/review',
      { schema: reviewGetSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        const repo = ctx.space.repoRef
        const branch = draftBranchName(ctx.row.id)

        try {
          const open = await ctx.provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
          const pr = open[0]
          if (!pr) {
            return reply.code(404).send({ status: 'not_found', reason: 'kein offenes Review' })
          }

          const [mainFile, draftFile, draftCommits] = await Promise.all([
            // Draft-only-Seiten (Phase 2d Task 5, „+ Neue Seite") haben VOR ihrem
            // ersten Release schlicht keine Datei auf main — `readFile` wirft dafür
            // einen `NotFoundError` (Provider-404), den es hier NICHT wie einen
            // echten Provider-Ausfall zu behandeln gilt (der äußere catch würde ihn
            // sonst als 502 melden, obwohl das Review völlig regulär ist — ohne
            // diesen Fang war ein Review für eine ganz neue Seite gar nicht
            // möglich, in `workflow.spec.ts` Flow 4 real gefunden). Ein leeres
            // main-Dokument ist der korrekte Vergleichsstand: der Diff zeigt dann
            // den kompletten Inhalt als `added`-Blöcke, exakt wie bei einem Diff
            // gegen `/dev/null`.
            ctx.provider.readFile(repo, ctx.row.path, 'main').catch((err) => {
              if (err instanceof NotFoundError) return { path: ctx.row.path, content: '', sha: '' }
              throw err
            }),
            ctx.provider.readFile(repo, ctx.row.path, branch),
            // `PullRequestInfo` trägt keinen Autor (packages/git-provider/src/types.ts)
            // — der letzte Commit-Autor des Draft-Branchs ist der beste verfügbare
            // Ersatz (i. d. R. identisch mit dem PR-Ersteller).
            ctx.provider.listCommits(repo, { ref: branch, limit: 1 }),
          ])

          const resolver = await buildSpaceLinkResolver(deps.db, ctx.space.id)

          // Befund 3 (Final-Review): `versioning`/`version` jetzt HIER ermittelt
          // (derselbe gecachte `loadMetadataSchema`-Pfad wie `POST /release`
          // oben und `GET /api/pages/:id` in `pages.ts`) statt über einen
          // zweiten, fehler-toleranten Fetch aus `review/page.tsx` — dessen
          // `.catch(() => null)` ließ den Versionsabschnitt bei einem Ausfall
          // lautlos verschwinden, ohne dass der Freigebende davon erfuhr.
          const schema = await loadMetadataSchema(
            { providerRegistry: () => ctx.provider },
            ctx.space,
            'main',
            req.log,
          )
          const { versioning, version } = await resolveVersionFields(deps, ctx.row, schema)

          const diff = diffMarkdown(mainFile.content, draftFile.content, {
            // Diagramm-/Bild-/Anhang-Referenzen der VORGESCHLAGENEN Fassung
            // müssen aus dem Draft-Branch geladen werden (`?ref=draft`), sonst
            // zeigt die Review-Diff die alte `main`-Version einer im Entwurf
            // geänderten Datei (die Media-Route defaultet ohne `ref` auf
            // `main`). Die Leseansicht-Indexierung bleibt bei `main`
            // (query-freie URL). Gilt für `resolveLink` UND `resolveImage`
            // gleichermaßen, da `_media/`-Anhang-Links in `buildResolveLink`
            // über dieselbe `ref`-Logik laufen wie Bilder.
            resolveLink: buildResolveLink(resolver, ctx.row.path, ctx.space.id, ctx.row.id, 'draft'),
            resolveImage: buildResolveImage(ctx.row.id, 'draft'),
          })

          return {
            pr: { number: pr.number, url: pr.url, state: pr.state, mergeable: pr.mergeable, title: pr.title },
            authorName: draftCommits[0]?.authorName ?? 'unbekannt',
            diff,
            page: { id: ctx.row.id, space: ctx.space.id, title: ctx.row.title },
            versioning,
            ...(version ? { version } : {}),
          }
        } catch (err) {
          return providerErrorReply(reply, err)
        }
      },
    )

    // POST /release: best-effort-Approve → Merge (Nutzer-Token = Freigabe-
    // Recht-Probe, siehe Spec §7) → synchroner Cleanup + Neu-Indexierung.
    instance.post<{ Params: { id: string }; Body: { comment?: string; bump?: VersionBump; note?: string } }>(
      '/api/pages/:id/release',
      { schema: releaseSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        const repo = ctx.space.repoRef
        const branch = draftBranchName(ctx.row.id)

        try {
          const open = await ctx.provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
          const pr = open[0]
          if (!pr) {
            return reply.code(409).send({ error: 'kein offener Pull Request vorhanden' })
          }

          // Fix #11 (dieselbe Prüfung wie POST /review, hier zusätzlich für Drafts
          // nötig, deren PR vor diesem Fix ODER unabhängig von der API eröffnet wurde):
          // ein Branch ohne jeden Commit gegenüber main ist bei Forgejo zwar mergebar
          // laut `mergeable`-Feld, der eigentliche Merge-POST scheitert aber dauerhaft
          // mit transientem 405, bis das interne ~15s-Retry-Budget von
          // `mergePullRequest` ausgeschöpft ist (502 an den Aufrufer). Geprüft VOR den
          // release-eigenen Zusatz-Commits (`fillReleaseMetadataOnDraft`/
          // `applyVersionOnDraft`): die zählen nicht als "echte" Änderung des Autors —
          // ein Draft, der nur durch automatisch vorbelegte Metadaten/Versionsnummern
          // von main abweicht, hat inhaltlich nichts zu veröffentlichen, und ein
          // Zusatz-Commit VOR dieser Prüfung würde den PR erst nachträglich (und ohne
          // Autorabsicht) "echt" aussehen lassen.
          if ((await ctx.provider.countCommitsAhead(repo, 'main', branch)) === 0) {
            return reply.code(422).send({ error: 'Draft has no changes', reason: 'no_changes' })
          }

          // Freigabe-Vorbelegung (Metadaten-Feature M3b Teil B) — VOR dem Merge:
          // der Draft-Branch IST der PR-Head, ein hier committierter Zusatz-
          // Commit wird dadurch automatisch Teil des gleich folgenden Merges,
          // ohne einen eigenen Schritt danach zu brauchen. `fillReleaseMetadataOnDraft`
          // ist selbst der Kurzschluss für den (weit überwiegenden) Regelfall
          // ohne `fillOnRelease`-Feld im Schema — kein zusätzlicher Provider-
          // Aufruf, bestehendes Release-Verhalten bleibt für diese Spaces exakt
          // unverändert. `loadMetadataSchema` ist gecacht (5 min) und teilt sich
          // den Cache mit `GET /api/pages/:id` (`routes/pages.ts`, Teil A).
          const schema = await loadMetadataSchema(
            { providerRegistry: () => ctx.provider },
            ctx.space,
            'main',
            req.log,
          )
          await fillReleaseMetadataOnDraft(ctx.provider, repo, ctx.row.path, branch, schema, {
            actor: req.user!.displayName,
            date: isoDateOnly((deps.now ?? Date.now)()),
          })

          // Seitenversionierung: nur wenn der Space sie aktiviert hat. Die
          // Berechnungsbasis ist die Version in main — NICHT die im Draft
          // (s. applyVersionOnDraft).
          let releasedVersion: string | undefined
          if (schema.versioning) {
            // NUR `NotFoundError` heißt hier "Seite existiert noch nicht in main"
            // (erste Freigabe → `nextVersion(undefined, bump)` = 1.0.0, korrekt).
            // JEDER andere Fehler (Netzwerk-Timeout, Rate-Limit, transienter
            // Provider-Ausfall) MUSS durchgeworfen werden, damit ihn der äußere
            // try/catch als 502 meldet — ein pauschal geschlucktes `.catch(() =>
            // undefined)` würde `mainVersion` bei einer bereits mehrfach
            // freigegebenen Seite (main z. B. auf 2.3.1) ebenso auf `undefined`
            // fallen lassen, wodurch die Version STILL auf 1.0.0 zurückspringen
            // würde — mit einem Changelog-Eintrag, der wie eine Erstfreigabe
            // aussieht, und ohne jede Fehlermeldung. Das unterläuft genau die
            // Wiederholbarkeits-Garantie, für die hier überhaupt gegen main
            // gerechnet wird (s. Kommentar über `applyVersionOnDraft`). Analoges
            // Muster ~90 Zeilen darüber bei `GET /review` (Zeile 575 ff.) — NICHT
            // vereinfachen zu einem pauschalen Catch.
            const mainFile = await ctx.provider.readFile(repo, ctx.row.path, 'main').catch((err) => {
              if (err instanceof NotFoundError) return undefined
              throw err
            })
            const mainVersion = mainFile ? parsePage(mainFile.content).frontmatter.version : undefined
            const applied = await applyVersionOnDraft(ctx.provider, repo, ctx.row.path, branch, mainVersion, {
              bump: req.body?.bump ?? 'patch',
              note: (req.body?.note ?? req.body?.comment ?? '').trim(),
              author: req.user!.displayName,
              date: isoDateOnly((deps.now ?? Date.now)()),
            })
            releasedVersion = applied.version
          }

          // Best-effort-Approve VOR dem Merge (Plan Task 3): NUR die tolerierte
          // Fehlerklasse (Self-Review/"bereits approved" — beide äußern sich
          // providerseitig als `ConflictError`, siehe `isTolerableApproveError`
          // unten, Finding 1 Fix-Runde 1) wird still geschluckt. Jeder ANDERE
          // Fehler (Netzwerk, Rate-Limit, ...) darf den Reviewer NICHT im
          // Glauben lassen, seine Freigabe sei da — der Merge bleibt zwar
          // autoritativ und läuft trotzdem weiter, aber die Antwort trägt dann
          // `approveWarning`, damit der Aufrufer es erfährt. Fallback-Text ohne
          // `comment` (Forgejo lehnt ein APPROVE ohne Body mit einem eigenen
          // Fehler ab — sonst würde das Approve OHNE Kommentar praktisch immer
          // scheitern, obwohl es gelingen könnte).
          let approveWarning: string | undefined
          try {
            await ctx.provider.submitPullRequestReview(repo, pr.number, {
              event: 'approve',
              body: req.body?.comment ?? 'Freigegeben über die f451-Plattform.',
            })
          } catch (err) {
            if (!isTolerableApproveError(err)) {
              const message = err instanceof Error ? err.message : String(err)
              approveWarning =
                `Automatische Freigabe vor dem Merge fehlgeschlagen (${message}) — bitte manuell im `
                + 'Pull Request prüfen, ob eine Freigabe vorliegt.'
            }
            req.log.warn(
              { err, pageId: ctx.row.id, pr: pr.number, tolerated: approveWarning === undefined },
              'release: Approve vor dem Merge fehlgeschlagen (vermutlich Self-Review oder bereits '
                + 'approved) — Merge bleibt autoritativ',
            )
          }

          let merged: { mergeSha: string }
          try {
            merged = await ctx.provider.mergePullRequest(repo, pr.number)
          } catch (err) {
            if (err instanceof ConflictError) {
              return reply.code(409).send({ error: err.message, reason: 'conflict' })
            }
            if (err instanceof ProviderError && err.status === 403) {
              // Spec: Merge-Recht = Freigabe-Recht, keine eigene Probe — ein
              // Provider-403 BEIM MERGE ist die Freigabe-Recht-Antwort.
              return reply.code(403).send({ error: 'Kein Freigabe-Recht auf dieses Repository' })
            }
            throw err
          }

          // Erst NACH dem Merge: Der mergeSha existiert vorher nicht. Ein
          // Fehler hier darf die bereits vollzogene Freigabe nicht in einen
          // Fehler verwandeln — die Zeile ist ein Cache und per Reindex aus
          // der Git-Historie wiederherstellbar.
          if (releasedVersion) {
            const parts = parseVersion(releasedVersion)
            if (parts) {
              try {
                // `blobSha` (Task 4, NOT NULL) ist der Inhalt-Hash der Datei
                // GENAU im Merge-Commit — separater Read nötig, weil
                // `mergePullRequest` nur den Commit-SHA liefert, keinen
                // Blob-SHA. `readFile(ref=mergeSha)` liest exakt den Stand,
                // den dieser Merge erzeugt hat.
                const releasedFile = await ctx.provider.readFile(repo, ctx.row.path, merged.mergeSha)
                const versionValues = {
                  pageId: ctx.row.id,
                  spaceId: ctx.space.id,
                  version: releasedVersion,
                  major: parts.major,
                  minor: parts.minor,
                  patch: parts.patch,
                  mergeSha: merged.mergeSha,
                  blobSha: releasedFile.sha,
                  author: req.user!.displayName,
                  note: (req.body?.note ?? req.body?.comment ?? '').trim(),
                }
                await deps.db
                  .insert(pageVersions)
                  .values(versionValues)
                  // Befund 4 (Final-Review): `onConflictDoUpdate` statt
                  // `onConflictDoNothing` — `page_versions.pageId` hat KEINEN
                  // Fremdschlüssel auf `pages` (Seiten-Ids sind stabil, aber
                  // wiederverwendbar: Seite löschen, unter derselben `id:` neu
                  // anlegen). Wird eine SOLCHE neue Seite zum ersten Mal
                  // freigegeben, kollidiert der Insert auf `(page_id, '1.0.0')`
                  // mit der Zeile der ALTEN, gelöschten Seite — `onConflictDoNothing`
                  // hätte den Insert dann still verworfen und die Zeile mit dem
                  // `blob_sha` der ALTEN Seite behalten, wodurch die NEUE Seite ab
                  // Tag eins fälschlich "geändert seit 1.0.0" gezeigt hätte. Der
                  // soeben vollzogene Merge ist dagegen IMMER die Wahrheit für
                  // GENAU diese `(pageId, version)`-Kombination — er darf einen
                  // etwaigen Altbestand überschreiben.
                  .onConflictDoUpdate({
                    target: [pageVersions.pageId, pageVersions.version],
                    set: {
                      spaceId: versionValues.spaceId,
                      major: versionValues.major,
                      minor: versionValues.minor,
                      patch: versionValues.patch,
                      mergeSha: versionValues.mergeSha,
                      blobSha: versionValues.blobSha,
                      author: versionValues.author,
                      note: versionValues.note,
                      releasedAt: new Date(),
                    },
                  })
              } catch (err) {
                req.log.error(
                  { err, pageId: ctx.row.id, version: releasedVersion },
                  'release: page_versions-Eintrag fehlgeschlagen — Merge war erfolgreich, '
                    + 'Eintrag ist per Reindex rekonstruierbar',
                )
              }
            }
          }

          // Synchroner Cleanup + Neu-Indexierung (Plan Task 3): NICHT auf den
          // Webhook warten, die Leseansicht soll den neuen Stand sofort zeigen
          // (der `pull_request`-Webhook bleibt der Interop-/Fallback-Pfad für
          // native Merges, siehe `routes/webhooks.ts`). Der Merge selbst ist zu
          // diesem Zeitpunkt bereits geschehen (irreversibel) — ein Fehler hier
          // darf die Erfolgsantwort nicht mehr in einen Fehler verwandeln.
          try {
            await cleanupMergedDraft({ db: deps.db }, ctx.provider, repo, ctx.row.id)
            await indexChangedFiles({ db: deps.db, provider: ctx.provider }, ctx.space, [ctx.row.path], [])
          } catch (err) {
            req.log.error(
              { err, pageId: ctx.row.id },
              'release: Nach-Merge-Cleanup/Neu-Indexierung fehlgeschlagen — Merge selbst war erfolgreich',
            )
          }

          return {
            mergeSha: merged.mergeSha,
            ...(releasedVersion ? { version: releasedVersion } : {}),
            ...(approveWarning ? { approveWarning } : {}),
          }
        } catch (err) {
          return providerErrorReply(reply, err)
        }
      },
    )

    // POST /review/request-changes: fordert Änderungen an (Mockup „Änderungen
    // anfragen"), Kommentar ist Pflicht.
    instance.post<{ Params: { id: string }; Body: { comment: string } }>(
      '/api/pages/:id/review/request-changes',
      { schema: requestChangesSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        const repo = ctx.space.repoRef
        const branch = draftBranchName(ctx.row.id)

        try {
          const open = await ctx.provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
          const pr = open[0]
          if (!pr) {
            return reply.code(409).send({ error: 'kein offener Pull Request vorhanden' })
          }

          await ctx.provider.submitPullRequestReview(repo, pr.number, {
            event: 'request_changes',
            body: req.body.comment,
          })
          return reply.code(204).send()
        } catch (err) {
          if (err instanceof ProviderError) {
            // z. B. eigener PR ("Poster of PR can not ... own PR") — Provider-
            // Fehlermeldung 1:1 durchreichen (Plan Task 3 Interface, wörtlich).
            return reply.code(422).send({ error: err.message })
          }
          return providerErrorReply(reply, err)
        }
      },
    )

    // POST /draft/update: löst den Randfall "Draft↔main auseinandergelaufen"
    // (Plan Task 3) — `discardDraft` + `createOrGetDraft` (Business-Logik in
    // `drafts/update.ts`), war ein PR offen, wird er über dieselbe idempotente
    // Anlage-Logik wie POST /review neu eröffnet.
    instance.post<{ Params: { id: string }; Body: { strategy: UpdateStrategy } }>(
      '/api/pages/:id/draft/update',
      { schema: updateSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          const result = await updateDraft(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.space,
            ctx.row.id,
            ctx.row.path,
            ctx.row.title,
            req.user!.id,
            req.body.strategy,
          )

          let pr: { number: number; url: string } | null = null
          let state: 'working' | 'review' = 'working'
          const branch = draftBranchName(ctx.row.id)
          // #11: after `take-main` the draft may carry no own commits any more —
          // reopening the review would create an empty PR that can never be
          // merged. The draft then simply stays in `working`.
          const hasChanges =
            result.hadOpenPr && (await ctx.provider.countCommitsAhead(ctx.space.repoRef, 'main', branch)) > 0
          if (hasChanges) {
            // Race-Fix (Task 7, s. waitForPrClosed): erst warten, bis Forgejo
            // den alten PR wirklich geschlossen hat — sonst liefert die
            // idempotente Anlage den sterbenden Alt-PR als "Bestand" zurück
            // und es bleibt am Ende gar kein offener PR übrig.
            if (result.previousPrNumber !== undefined) {
              await waitForPrClosed(ctx.provider, ctx.space.repoRef, branch, result.previousPrNumber, {
                log: req.log,
              })
            }
            const { pr: opened } = await findOrCreateOpenPr(
              ctx.provider,
              ctx.space.repoRef,
              branch,
              ctx.row.title,
              reviewPrBody(ctx.row.id, ctx.row.title, ctx.space.id, deps.publicBaseUrl),
            )
            pr = { number: opened.number, url: opened.url }
            state = 'review'
          }

          return {
            baseSha: result.baseSha,
            content: result.content,
            state,
            pr,
            ...(result.warning ? { warning: result.warning } : {}),
          }
        } catch (err) {
          if (err instanceof DraftUpdateContentLostError) {
            // Content-Verlust-Fenster (Finding 3, Fix-Runde 1): der alte
            // Draft-Branch ist bereits weg, aber der Inhalt ist gerettet —
            // der Client kann ihn erneut speichern, sobald der Draft (durch
            // einen erneuten `POST /draft/update`-Versuch) wieder existiert.
            return reply.code(502).send({
              status: 'error',
              reason: `Provider-Fehler: ${err.message}`,
              preservedContent: err.preservedContent,
            })
          }
          if (err instanceof NotFoundError) {
            return reply
              .code(404)
              .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
          }
          return providerErrorReply(reply, err)
        }
      },
    )
  })
}
