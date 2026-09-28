import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import type { SpaceAccess } from '../auth/permissions.js'
import type { Db } from '../db/client.js'
import { pages } from '../db/schema.js'
import { draftBranchName } from '../drafts/branch-name.js'
import {
  applyWorkflowStatus,
  buildSpaceGraph,
  GRAPH_EDGE_TYPES,
  neighborhood,
  type GraphData,
  type GraphEdgeType,
} from '../graph/space-graph.js'
import type { SpaceConfig } from '../spaces/config.js'

export interface GraphDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  /** 404-statt-403 wie überall; ungesetzt (kein Auth) ⇒ offen (1c-Verhalten). */
  access?: SpaceAccess
  /** Schreibrechte-Probe — NUR mit ihr wird working/review angereichert
   *  (2d-Grundsatz: Entwurfs-/Review-Info nie an reine Leser). */
  canWrite?: (userId: string, space: SpaceConfig) => Promise<boolean>
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const graphResponseSchema = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          status: { type: 'string', enum: ['released', 'working', 'review', 'archived'] },
          tags: { type: 'array', items: { type: 'string' } },
          updatedAt: { type: 'string' },
        },
        required: ['id', 'title', 'path', 'status', 'tags', 'updatedAt'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string', enum: [...GRAPH_EDGE_TYPES] },
          label: { type: 'string' },
        },
        required: ['from', 'to', 'type', 'label'],
      },
    },
  },
  required: ['nodes', 'edges'],
} as const

const DEFAULT_TYPES: readonly GraphEdgeType[] = ['hierarchy', 'link', 'relation']

/** Parst `?types=` (CSV). Rückgabe `null` bei unbekanntem Wert — die Route
 *  macht daraus ihre 400 mit dem unbekannten Wert im reason-Text.
 *  Erwartet bereits einen einzelnen String — Mehrfach-Vorkommen (`?types=a&types=b`,
 *  von Fastify/qs als Array geparst) prüft die Route VORHER separat (siehe
 *  Kommentar an der Schema-Deklaration unten). */
function parseTypes(raw: string | undefined): readonly GraphEdgeType[] | { invalid: string } | null {
  if (!raw) return DEFAULT_TYPES
  const parts = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
  if (parts.length === 0) return DEFAULT_TYPES
  for (const p of parts) {
    if (!(GRAPH_EDGE_TYPES as readonly string[]).includes(p)) return { invalid: p }
  }
  return parts as GraphEdgeType[]
}

/**
 * Status-Anreicherung (working/review) — bewusst NICHT pro Knoten beim
 * Provider nachfragen (das wäre N Roundtrips; siehe Backlog-Befund zum
 * workflow-Feld der Lese-API): working kommt aus den `ref='draft'`-Zeilen
 * der DB (ein SELECT), review aus EINEM `listPullRequests`-Call pro Load,
 * gematcht über `draftBranchName(pageId)` der Draft-Seiten. Provider-Fehler
 * degradieren den Status (nur DB-Wissen) — Lesen fällt nie aus.
 */
async function workflowSets(
  deps: GraphDeps,
  space: SpaceConfig,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<{ working: Set<string>; review: Set<string> }> {
  const draftRows = await deps.db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), eq(pages.ref, 'draft')))
  const working = new Set(draftRows.map((r) => r.id))
  const review = new Set<string>()
  if (working.size === 0) return { working, review }
  const branchToPage = new Map<string, string>()
  for (const id of working) branchToPage.set(draftBranchName(id), id)
  try {
    const provider = deps.providerRegistry(space)
    const openPrs = await provider.listPullRequests(space.repoRef, { base: 'main', state: 'open' })
    for (const pr of openPrs) {
      const pageId = branchToPage.get(pr.headBranch)
      if (pageId) review.add(pageId)
    }
  } catch (err) {
    log.warn({ err, space: space.id }, 'Graph: PR-Abfrage fehlgeschlagen — Status degradiert (working aus DB bleibt)')
  }
  return { working, review }
}

/** Gemeinsame Anreicherungs-Entscheidung beider Routen. */
async function maybeEnrich(
  deps: GraphDeps,
  space: SpaceConfig,
  userId: string | undefined,
  graph: GraphData,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<GraphData> {
  if (!deps.access || !deps.canWrite || !userId) return graph
  if (!(await deps.canWrite(userId, space))) return graph
  const { working, review } = await workflowSets(deps, space, log)
  return applyWorkflowStatus(graph, working, review)
}

/**
 * Registriert die Graph-API (Spec §5, Phase 3b):
 * `GET /api/spaces/:space/graph?types=…` (ganzer Space, Kantentypen schaltbar)
 * und `GET /api/pages/:id/graph?depth=1..4&types=…` (Nachbarschaft inkl.
 * eingehender Kanten — „wer hängt von mir ab?"). Pfad-Konvention wie
 * tree/broken-links (`/api/spaces/:space/<feature>`) statt des Spec-Wortlauts
 * `/graph/space/{s}` — projektweit einheitlich.
 */
export function registerGraphRoutes(app: FastifyInstance, deps: GraphDeps): void {
  // Sub-Plugin wie alle Routen-Module (OpenAPI-Sichtbarkeit, s. pages.ts).
  app.register(async (instance) => {
    instance.get<{ Params: { space: string }; Querystring: { types?: string | string[] } }>(
      '/api/spaces/:space/graph',
      // `types` bewusst OHNE Schema-Typ-Constraint (kein `type: 'string'`):
      // dieselbe AJV-Kollisionsklasse wie bei `depth` unten (siehe dortiger
      // Kommentar) — inkl. Array-Koerzierung. Fastify parst wiederholte
      // Query-Keys (`?types=a&types=b`) als Array; ein `type: 'string'`-
      // Constraint würde daran scheitern, AJVs Fehlerbody kollidiert mit dem
      // deklarierten `400`-`errorSchema` (`{status, reason}` required) →
      // Serialisierung der 400-Antwort scheitert selbst → 500
      // (FST_ERR_FAILED_ERROR_SERIALIZATION) statt der gewollten 400. Deshalb
      // `types: {}` (kein Typ) im Schema, vollständige manuelle Prüfung im
      // Handler — Array zuerst, danach die bestehende `parseTypes`-Prüfung.
      { schema: { tags: ['graph'], params: { type: 'object', properties: { space: { type: 'string' } }, required: ['space'] }, querystring: { type: 'object', properties: { types: {} } }, response: { 200: graphResponseSchema, 400: errorSchema, 404: errorSchema } } },
      async (req, reply) => {
        const spaceId = req.params.space
        const space = deps.spaces.find((s) => s.id === spaceId)
        if (!space) {
          return reply.code(404).send({ status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` })
        }
        // Kein Zugriff → dieselbe 404 (kein Existenz-Orakel).
        if (deps.access && !(await deps.access.canRead(req.user!.id, space))) {
          return reply.code(404).send({ status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` })
        }
        if (Array.isArray(req.query.types)) {
          return reply.code(400).send({ status: 'bad_request', reason: 'types darf nur einmal angegeben werden.' })
        }
        const types = parseTypes(req.query.types)
        if (types && 'invalid' in types) {
          return reply.code(400).send({ status: 'bad_request', reason: `Unbekannter Kantentyp "${types.invalid}".` })
        }
        const graph = await buildSpaceGraph(deps.db, spaceId, types ?? DEFAULT_TYPES)
        return maybeEnrich(deps, space, req.user?.id, graph, req.log)
      },
    )

    instance.get<{ Params: { id: string }; Querystring: { depth?: string | string[]; types?: string | string[] } }>(
      '/api/pages/:id/graph',
      // `depth` und `types` bewusst OHNE jeden Typ-Constraint (`type: 'integer'`/
      // `minimum`/`maximum`/`type: 'string'`) im JSON-Schema (`{}` = kein
      // Typ), sondern vollständig manuell im Handler geprüft: Fastifys
      // eingebaute AJV-Validierung würde bei einem Verstoß (z. B.
      // `depth=abc`/`depth=1.5`, nicht-koerzierbar zu integer) ihre eigene
      // Fehlerform (`{statusCode, error, message}`) senden, die nicht zum
      // projektweiten `{status, reason}`-Vertrag (`errorSchema`) passt —
      // die Serialisierung der 400-Antwort würde dann selbst scheitern
      // ("status" is required!) und Fastify fällt auf 500 zurück
      // (FST_ERR_FAILED_ERROR_SERIALIZATION). Dieselbe Kollisionsklasse
      // trifft auch ein `type: 'string'`-Constraint: Fastify parst
      // wiederholte Query-Keys (`?depth=1&depth=2`, `?types=a&types=b`) als
      // Array, das gegen `type: 'string'` genauso an AJV scheitert wie ein
      // falscher Skalarwert. Deshalb bleiben beide Felder OHNE
      // Schema-Typ-Constraint; der Handler prüft zuerst `Array.isArray`
      // (Mehrfachangabe → 400) und danach den (Einzel-)Wert wie gehabt.
      // Projektweit gibt es noch keinen Schema-Error-Formatter, der AJV-
      // Fehler ins `{status, reason}`-Format umwandeln würde — bis es den
      // gibt, bleiben `depth`/`types` ohne Schema-Typ-Constraint.
      { schema: { tags: ['graph'], params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, querystring: { type: 'object', properties: { depth: {}, types: {} } }, response: { 200: graphResponseSchema, 400: errorSchema, 404: errorSchema } } },
      async (req, reply) => {
        const id = req.params.id
        const rows = await deps.db
          .select({ spaceId: pages.spaceId })
          .from(pages)
          .where(and(eq(pages.id, id), eq(pages.ref, 'main')))
        const spaceId = rows[0]?.spaceId
        const space = spaceId ? deps.spaces.find((s) => s.id === spaceId) : undefined
        // Unbekannte Seite, unkonfigurierter Space und fehlendes Leserecht
        // antworten identisch (kein Existenz-Orakel).
        const notFound = () => reply.code(404).send({ status: 'not_found', reason: `Seite "${id}" ist nicht indexiert.` })
        if (!space) return notFound()
        if (deps.access && !(await deps.access.canRead(req.user!.id, space))) return notFound()
        if (Array.isArray(req.query.types)) {
          return reply.code(400).send({ status: 'bad_request', reason: 'types darf nur einmal angegeben werden.' })
        }
        const types = parseTypes(req.query.types)
        if (types && 'invalid' in types) {
          return reply.code(400).send({ status: 'bad_request', reason: `Unbekannter Kantentyp "${types.invalid}".` })
        }
        if (Array.isArray(req.query.depth)) {
          return reply.code(400).send({ status: 'bad_request', reason: 'depth darf nur einmal angegeben werden.' })
        }
        const rawDepth = req.query.depth
        let depth = 2
        if (rawDepth !== undefined) {
          if (!/^[1-4]$/.test(rawDepth)) {
            return reply.code(400).send({ status: 'bad_request', reason: `depth muss eine ganze Zahl zwischen 1 und 4 sein (erhalten: "${rawDepth}").` })
          }
          depth = Number(rawDepth)
        }
        const graph = neighborhood(await buildSpaceGraph(deps.db, space.id, types ?? DEFAULT_TYPES), id, depth)
        return maybeEnrich(deps, space, req.user?.id, graph, req.log)
      },
    )
  })
}
