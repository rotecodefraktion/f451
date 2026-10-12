/**
 * Backlinks of a page (f451#97): `GET /api/pages/:id/backlinks` feeds the
 * backlinks section of the page rail — which pages link to this one, with a
 * short excerpt around each link. Only links in the page body count
 * (`edges.type = 'link'`); relations, hierarchy and shared tags do not.
 * Hidden pages (strictly confidential, or above an API token's limit) are
 * dropped as sources, exactly like in the page graph (`hiddenPageIds`).
 */
import { and, asc, eq, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { edges, pages } from '../db/schema.js'
import { hiddenPageIds, type GraphDeps } from './graph.js'

const MAX_EXCERPTS = 3

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const backlinksResponseSchema = {
  type: 'object',
  properties: {
    backlinks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'excerpts'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          excerpts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  required: ['backlinks'],
} as const

interface Backlink {
  id: string
  title: string
  excerpts: string[]
}

export function registerBacklinkRoutes(app: FastifyInstance, deps: GraphDeps): void {
  // Sub-plugin like every route module (OpenAPI visibility, see pages.ts).
  app.register(async (instance) => {
    instance.get<{ Params: { id: string } }>(
      '/api/pages/:id/backlinks',
      { schema: { tags: ['graph'], params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, response: { 200: backlinksResponseSchema, 404: errorSchema } } },
      async (req, reply) => {
        const id = req.params.id
        const rows = await deps.db
          .select({ spaceId: pages.spaceId })
          .from(pages)
          .where(and(eq(pages.id, id), eq(pages.ref, 'main')))
        const spaceId = rows[0]?.spaceId
        const space = spaceId ? deps.spaces.find((s) => s.id === spaceId) : undefined
        // Unknown page, unconfigured space and missing read access answer
        // identically (no existence oracle).
        const notFound = () => reply.code(404).send({ status: 'not_found', reason: `Seite "${id}" ist nicht indexiert.` })
        if (!space) return notFound()
        if (deps.access && !(await deps.access.canRead(req.user!.id, space))) return notFound()

        const linkRows = await deps.db
          .select({ fromPageId: edges.fromPageId, title: pages.title, context: edges.context })
          .from(edges)
          .innerJoin(pages, and(eq(pages.id, edges.fromPageId), eq(pages.ref, 'main')))
          .where(and(eq(edges.toPageId, id), eq(edges.ref, 'main'), eq(edges.type, 'link'), ne(edges.fromPageId, id)))
          .orderBy(asc(edges.fromPageId), asc(edges.rawTarget))

        const hidden = await hiddenPageIds(deps, space, req, req.log, id)
        const bySource = new Map<string, Backlink>()
        for (const r of linkRows) {
          if (hidden.has(r.fromPageId)) continue
          let entry = bySource.get(r.fromPageId)
          if (!entry) {
            entry = { id: r.fromPageId, title: r.title, excerpts: [] }
            bySource.set(r.fromPageId, entry)
          }
          if (r.context && entry.excerpts.length < MAX_EXCERPTS && !entry.excerpts.includes(r.context)) {
            entry.excerpts.push(r.context)
          }
        }
        const backlinks = [...bySource.values()].sort((a, b) => a.title.localeCompare(b.title))
        return { backlinks }
      },
    )
  })
}
