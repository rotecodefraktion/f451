import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { joinFrontmatter, parsePage, setFrontmatterMetadata, splitFrontmatter } from '@f451/markdown'
import type { Db } from '../db/client.js'
import { branchExists, loadFreshLock } from '../drafts/lifecycle.js'
import { draftBranchName } from '../drafts/branch-name.js'
import { derivePageId, indexSpace, isPageFile, type IndexReport } from '../indexer/index-space.js'
import { generatePageId } from '../indexer/page-id.js'
import type { OpsCounters } from '../ops/counters.js'
import type { SpaceConfig } from '../spaces/config.js'

export interface AdminDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  /**
   * Simpler Bearer-Token-Schutz für 1c. TODO(1d): durch echte Auth (Sessions/
   * RBAC) ersetzen — dieser Vergleich ist bewusst minimal und nur eine
   * Übergangslösung, bis Phase 1d Authentifizierung liefert.
   */
  adminToken?: string
  /** Task 5 (Betrieb): dieselbe `OpsCounters`-Instanz wie die Webhook-Routen
   *  (siehe `WebhookDeps.counters`) — beliefert `GET /admin/status` UND wird
   *  an `indexSpace` durchgereicht (`POST /admin/reindex` zählt IO-Fehler
   *  beim Lesen wie jeder andere Aufrufer von `indexSpace`, siehe
   *  `index-space.ts#readPageFileSafe`). */
  counters: OpsCounters
}

interface ReindexBody {
  space?: string
}

/** Ergebnis-Eintrag je Space: entweder erfolgreicher Report oder Fehlermeldung
 *  (Fehlerisolation — ein scheiternder Space darf die Reports der übrigen nicht
 *  verhindern, siehe `registerAdminRoutes` unten). */
export type AdminReindexResult =
  | { space: string; report: IndexReport }
  | { space: string; error: string }

export type AdminReindexResponse = AdminReindexResult[]

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

// Issue #7: Seiten, deren Frontmatter-`id` bereits einem anderen Space gehört
// (siehe `IndexReport.idConflicts`-Kommentar in `indexer/index-space.ts`) — ohne
// diesen Eintrag im Response-Schema würde Fastify das Feld aus der JSON-Antwort
// entfernen (unbekannte Properties werden gegen das Schema verworfen), der
// Konflikt bliebe für `POST /admin/reindex`-Aufrufer unsichtbar.
const idConflictItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    path: { type: 'string' },
    ownerSpace: { type: 'string' },
  },
  required: ['id', 'path', 'ownerSpace'],
} as const

const indexReportSchema = {
  type: 'object',
  properties: {
    pagesIndexed: { type: 'number' },
    pagesWithErrors: { type: 'number' },
    brokenLinks: { type: 'number' },
    filesSkippedIo: { type: 'number' },
    headSha: { type: 'string' },
    idConflicts: { type: 'array', items: idConflictItemSchema },
  },
  required: [
    'pagesIndexed',
    'pagesWithErrors',
    'brokenLinks',
    'filesSkippedIo',
    'headSha',
    'idConflicts',
  ],
} as const

const reindexResultItemSchema = {
  type: 'object',
  properties: {
    space: { type: 'string' },
    report: indexReportSchema,
    error: { type: 'string' },
  },
  required: ['space'],
} as const

const reindexSchema = {
  tags: ['admin'],
  body: {
    type: 'object',
    properties: { space: { type: 'string' } },
  },
  response: {
    200: { type: 'array', items: reindexResultItemSchema },
    401: errorSchema,
    404: errorSchema,
    // 502: alle angefragten Spaces sind beim Reindex gescheitert (Fehlerisolation
    // unten) — Teilberichte gibt es dann keine, nur Fehler je Space.
    502: { type: 'array', items: reindexResultItemSchema },
    503: errorSchema,
  },
} as const

/** Ergebnis-Eintrag je Space (Phase 3.1, `POST /admin/backfill-ids`):
 *  `updated` = Pfade, die gerade eine neue `id` bekommen haben; `skipped` =
 *  Pfade mit offenem Draft-Branch/aktivem Lock (bewusst NICHT angefasst, s.
 *  `backfillSpace` unten); `alreadyHadId` = Anzahl Seiten, die bereits eine
 *  Frontmatter-`id` hatten (Idempotenz-Zähler: ein zweiter Lauf lässt
 *  `updated` leer und zählt diese Seiten hier mit). `error` nur bei einem
 *  gescheiterten Space gefüllt (Fehlerisolation, wie `AdminReindexResult`). */
export interface BackfillSpaceResult {
  updated: string[]
  skipped: string[]
  alreadyHadId: number
  error?: string
}

export type AdminBackfillResponse = { perSpace: Record<string, BackfillSpaceResult> }

const backfillSpaceResultSchema = {
  type: 'object',
  properties: {
    updated: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
    alreadyHadId: { type: 'number' },
    error: { type: 'string' },
  },
  required: ['updated', 'skipped', 'alreadyHadId'],
} as const

const backfillResponseSchema = {
  type: 'object',
  properties: {
    perSpace: { type: 'object', additionalProperties: backfillSpaceResultSchema },
  },
  required: ['perSpace'],
} as const

const backfillSchema = {
  tags: ['admin'],
  body: {
    type: 'object',
    properties: { space: { type: 'string' } },
  },
  response: {
    200: backfillResponseSchema,
    401: errorSchema,
    404: errorSchema,
    // 502: alle angefragten Spaces sind gescheitert (Fehlerisolation unten) —
    // dieselbe Form wie 200, `perSpace`-Einträge tragen dann nur `error`.
    502: backfillResponseSchema,
    503: errorSchema,
  },
} as const

const countersSnapshotSchema = {
  type: 'object',
  properties: {
    webhookErrors: { type: 'number' },
    indexerErrors: { type: 'number' },
    driftErrors: { type: 'number' },
    since: { type: 'string' },
  },
  required: ['webhookErrors', 'indexerErrors', 'driftErrors', 'since'],
} as const

const statusSchema = {
  tags: ['admin'],
  response: {
    200: {
      type: 'object',
      properties: { counters: countersSnapshotSchema, uptime: { type: 'number' } },
      required: ['counters', 'uptime'],
    },
    401: errorSchema,
    503: errorSchema,
  },
} as const

/**
 * Bestandsnachrüstung: injiziert eine stabile `id` ins Frontmatter jeder
 * `index.md`, die noch keine hat (Phase 3.1, `POST /admin/backfill-ids`).
 * Kein Move, keine Pfadänderung — reiner Frontmatter-Commit auf `main`, EINER
 * je betroffener Seite (Fehlerisolation je Datei wäre hier zu granular, ein
 * scheiternder `writeFile` bricht den gesamten Space-Lauf ab und propagiert
 * an den Aufrufer, der ihn wie jeden anderen Space-Fehler behandelt).
 *
 * Reihenfolge (Plan Phase 3.1 Punkt 3): ERST alle fehlenden Ids injizieren,
 * DANN — nur falls mindestens eine Injektion stattfand — EIN Voll-Reindex
 * des Space (`indexSpace`), der `pages.id`/`edges`/`tags` auf die neuen Ids
 * migriert. Ein Reindex je einzelner Injektion wäre korrekt, aber unnötig
 * teuer (N Reindexe statt 1) — der main-Indexer liest ohnehin den kompletten
 * Baum, ein Zwischenstand mit halb migrierten Ids wird nie nach außen
 * sichtbar (die gesamte Injektionsphase läuft VOR dem einzigen Reindex).
 *
 * Überspringt Seiten mit offenem Draft-Branch ODER aktivem Lock (Plan Phase
 * 3.1 Punkt 3): ihre pageId ist gerade Teil eines laufenden Arbeitsvorgangs
 * (Draft-Branch-Name `draft/<pageId>`, s. `drafts/branch-name.ts`) — würde der
 * Backfill sie trotzdem umschreiben, verlöre der offene Draft/Lock seine
 * Verbindung zur main-Seite (der Draft-Branch bliebe unter der ALTEN Id
 * benannt, main liefe unter der NEUEN). Eine übersprungene Seite bleibt beim
 * NÄCHSTEN Lauf erneut Kandidatin, sobald Draft/Lock weg sind — kein manuelles
 * Nacharbeiten nötig.
 *
 * Idempotent: eine Seite mit bereits vorhandener `frontmatter.id` wird nie
 * angefasst (zählt nur in `alreadyHadId`) — ein zweiter Lauf über denselben
 * Space ändert daher nichts mehr und ruft (mangels `updated`) auch keinen
 * erneuten Reindex auf.
 */
async function backfillSpace(deps: AdminDeps, space: SpaceConfig): Promise<BackfillSpaceResult> {
  const provider = deps.providerRegistry(space)
  const tree = await provider.listTree(space.repoRef, 'main')
  const pageFiles = tree.filter((e) => isPageFile(e.path, e.type)).map((e) => e.path)

  const updated: string[] = []
  const skipped: string[] = []
  let alreadyHadId = 0
  // Kollisionsschutz innerhalb DIESES Laufs (s. `page-id.ts`-Kommentar): bei
  // Zehntausenden Seiten in einem einzigen Backfill-Lauf ist ein doppelt
  // gezogenes `generatePageId()` astronomisch unwahrscheinlich, aber ein
  // erneutes Ziehen bei einem (theoretischen) Treffer kostet praktisch nichts.
  const usedIds = new Set<string>()

  for (const filePath of pageFiles) {
    const file = await provider.readFile(space.repoRef, filePath, 'main')
    const parsed = parsePage(file.content)
    if (parsed.frontmatter.id) {
      alreadyHadId++
      continue
    }

    // Offener Draft-Branch oder aktiver Lock → überspringen (s. Funktionskommentar
    // oben). Die aktuelle (Fallback-)Id der Seite ist `derivePageId(..., undefined)`
    // — GENAU die Id, unter der ein evtl. offener Draft-Branch/Lock benannt ist
    // (`draftBranchName`/`locks.pageId` werden immer mit der zu diesem Zeitpunkt
    // gültigen pageId angelegt).
    const fallbackId = derivePageId(space.id, filePath, undefined)
    const branch = draftBranchName(fallbackId)
    const [hasOpenDraft, lock] = await Promise.all([
      branchExists(provider, space.repoRef, branch),
      // `requestingUserId` fließt nur in `mine` ein (hier irrelevant) — ein
      // beliebiger, nie mit einem echten Nutzer kollidierender Platzhalter genügt.
      loadFreshLock({ db: deps.db }, fallbackId, '__admin_backfill__'),
    ])
    if (hasOpenDraft || lock) {
      skipped.push(filePath)
      continue
    }

    let id = generatePageId()
    while (usedIds.has(id)) id = generatePageId()
    usedIds.add(id)

    const { frontmatterRaw, body } = splitFrontmatter(file.content)
    const newContent = joinFrontmatter(setFrontmatterMetadata(frontmatterRaw, { id }), body)
    await provider.writeFile(space.repoRef, filePath, newContent, {
      branch: 'main',
      message: `docs: stabile Seiten-Id ergänzt (${filePath})`,
      sha: file.sha,
    })
    updated.push(filePath)
  }

  if (updated.length > 0) {
    await indexSpace({ db: deps.db, provider, counters: deps.counters }, space)
  }

  return { updated, skipped, alreadyHadId }
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/.exec(header)
  return match ? match[1]! : null
}

/**
 * Reiner Prädikat-Check (Issue #24, Ops-Automatisierung): „trägt diese
 * Anfrage ein gültiges Admin-Bearer-Token?" — OHNE Seiteneffekt (keine
 * Reply), damit auch `app.ts`s globaler Session-Gate-Hook ihn nutzen kann,
 * um `/admin/*` VON DER SESSIONPFLICHT auszunehmen, wenn ein gültiges Token
 * vorliegt (curl/CI/Deploy-Skript sollen die Admin-Routen ALLEIN per Token
 * bedienen können, ohne eingeloggte Browser-Session). Kein `adminToken`
 * konfiguriert → immer `false` (Fail-Closed bleibt Fail-Closed: ohne Token
 * gibt es keinen Bypass, weder hier noch in `requireAdminToken` unten).
 * Derselbe zeitkonstante Vergleich (`safeCompare`/`timingSafeEqual`) wie das
 * eigentliche Gate — hier NICHT neu erfunden, nur wiederverwendet.
 */
export function hasValidAdminToken(adminToken: string | undefined, authorizationHeader: string | undefined): boolean {
  if (!adminToken || adminToken.trim().length === 0) return false
  const provided = extractBearerToken(authorizationHeader)
  return provided !== null && safeCompare(provided, adminToken)
}

/**
 * Admin-Gate — GEMEINSAM für `POST /admin/reindex` und `GET /admin/status`
 * (Task 5, Betrieb): identisches Fail-Closed-Verhalten (kein `adminToken`
 * konfiguriert → 503, statt ein fehlendes Token als „offen" zu werten) und
 * derselbe zeitkonstante Bearer-Token-Vergleich (`hasValidAdminToken` oben).
 * Sendet die Fehlerantwort bei Ablehnung selbst und liefert `false` — der
 * Aufrufer muss den Handler dann sofort verlassen (`if (!requireAdminToken(...)) return`).
 * Bleibt die ALLEINIGE Quelle der Wahrheit für gültig/ungültig/nicht-
 * konfiguriert — der Session-Gate-Hook in `app.ts` prüft das Token zusätzlich
 * VORAB nur, um die Sessionpflicht bedingt zu überspringen, ersetzt dieses
 * Gate hier aber nicht (läuft bei jedem Aufruf erneut).
 */
function requireAdminToken(deps: AdminDeps, req: FastifyRequest, reply: FastifyReply): boolean {
  if (!deps.adminToken || deps.adminToken.trim().length === 0) {
    void reply.code(503).send({
      status: 'unavailable',
      reason: 'F451_ADMIN_TOKEN ist nicht gesetzt — der Admin-Endpunkt ist deaktiviert (Fail-Closed).',
    })
    return false
  }

  if (!hasValidAdminToken(deps.adminToken, req.headers.authorization)) {
    void reply.code(401).send({ status: 'unauthorized', reason: 'ungültiges oder fehlendes Admin-Token' })
    return false
  }
  return true
}

/**
 * Registriert `POST /admin/reindex` (Body optional `{space?: string}` — ein
 * bestimmter Space oder, ohne Angabe, alle konfigurierten Spaces).
 *
 * Fail-Closed (Plan Task 5): ist `F451_ADMIN_TOKEN` nicht gesetzt, lehnt der
 * Endpunkt JEDE Anfrage mit 503 ab — ein fehlendes Token wird nie als „offen“
 * interpretiert. Ist ein Token konfiguriert, aber das mitgeschickte Bearer-Token
 * stimmt nicht überein (Vergleich über `timingSafeEqual`), antwortet der
 * Endpunkt mit 401.
 *
 * Fehlerisolation im Multi-Space-Reindex (Task-7-Härtung): jeder Space wird
 * einzeln in try/catch reindexiert, sodass ein scheiternder Space (z. B. Provider
 * nicht erreichbar) die Reports der übrigen nicht verhindert — Antwort ist immer
 * ein Teilbericht-Array `[{space, report}|{space, error}]`. Statuscode 200, wenn
 * mindestens ein Space erfolgreich war (oder gar keiner angefragt wurde), 502
 * nur wenn ALLE angefragten Spaces gescheitert sind.
 *
 * Wie `registerPagesRoutes`/`registerSearchRoutes`/`registerWebhookRoutes`: als
 * eigenes (asynchron bootendes) Sub-Plugin registriert, NICHT direkt auf `app`
 * — sonst fehlt die Route in der von `@fastify/swagger` generierten OpenAPI-Spec
 * (siehe Kommentar in `pages.ts`; vorbestehende Lücke aus Task 5, hier behoben).
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.register(async (instance) => {
    instance.post<{ Body: ReindexBody }>('/admin/reindex', { schema: reindexSchema }, async (req, reply) => {
      if (!requireAdminToken(deps, req, reply)) return

      const targetId = req.body?.space
      const targets = targetId ? deps.spaces.filter((s) => s.id === targetId) : deps.spaces

      if (targetId && targets.length === 0) {
        return reply.code(404).send({ status: 'not_found', reason: `Space "${targetId}" ist nicht konfiguriert.` })
      }

      const results: AdminReindexResponse = []
      for (const space of targets) {
        try {
          const provider = deps.providerRegistry(space)
          const report = await indexSpace({ db: deps.db, provider, counters: deps.counters }, space)
          results.push({ space: space.id, report })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          req.log.error({ err, space: space.id }, 'admin/reindex: Space fehlgeschlagen')
          results.push({ space: space.id, error: message })
        }
      }

      const allFailed = results.length > 0 && results.every((r) => 'error' in r)
      return reply.code(allFailed ? 502 : 200).send(results)
    })

    // `POST /admin/backfill-ids` (Phase 3.1, „Stabile Seiten-Id + Backfill +
    // Redirect"): Bestandsnachrüstung fehlender Frontmatter-`id`s, s.
    // `backfillSpace` oben für den vollständigen Ablauf (Injektion, Skip bei
    // offenem Draft/Lock, Idempotenz, abschließender Reindex). Gate/Body/
    // Fehlerisolation identisch zu `/admin/reindex` oben (dasselbe Muster,
    // bewusst NICHT extrahiert — beide Handler sind kurz genug, dass eine
    // gemeinsame Abstraktion mehr Indirektion als Nutzen brächte).
    instance.post<{ Body: ReindexBody }>(
      '/admin/backfill-ids',
      { schema: backfillSchema },
      async (req, reply) => {
        if (!requireAdminToken(deps, req, reply)) return

        const targetId = req.body?.space
        const targets = targetId ? deps.spaces.filter((s) => s.id === targetId) : deps.spaces

        if (targetId && targets.length === 0) {
          return reply.code(404).send({ status: 'not_found', reason: `Space "${targetId}" ist nicht konfiguriert.` })
        }

        const perSpace: AdminBackfillResponse['perSpace'] = {}
        let anySucceeded = false
        for (const space of targets) {
          try {
            perSpace[space.id] = await backfillSpace(deps, space)
            anySucceeded = true
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            req.log.error({ err, space: space.id }, 'admin/backfill-ids: Space fehlgeschlagen')
            perSpace[space.id] = { updated: [], skipped: [], alreadyHadId: 0, error: message }
          }
        }

        const allFailed = targets.length > 0 && !anySucceeded
        return reply.code(allFailed ? 502 : 200).send({ perSpace })
      },
    )

    // Task 5 (Betrieb, Spec §9/§11): Betriebssicht auf die In-Memory-Fehlerzähler
    // (`ops/counters.ts`) + Prozess-Uptime — DASSELBE Admin-Gate wie oben (kein
    // separates, schwächeres Auth-Muster für einen "nur lesenden" Endpunkt: die
    // Zähler sind selbst schon ein Betriebssignal, das nicht unauthentifiziert
    // nach außen soll).
    instance.get('/admin/status', { schema: statusSchema }, async (req, reply) => {
      if (!requireAdminToken(deps, req, reply)) return
      return reply.code(200).send({ counters: deps.counters.snapshot(), uptime: Math.floor(process.uptime()) })
    })
  })
}
