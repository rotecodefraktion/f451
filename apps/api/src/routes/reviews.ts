/**
 * Review overview of a space (f451#131): `GET /api/spaces/:space/reviews`
 * lists every draft that has an open pull request onto main — title,
 * new/changed, last author and time — so the web page can release a
 * selection of them through the existing release route.
 *
 * Draft and review information never reaches plain readers: no read access
 * answers 404 (no existence oracle), read access without write access 403.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { pages } from '../db/schema.js'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'
import { openReviews, type OpenReview } from '../workflow/open-reviews.js'
import type { GraphDeps } from './graph.js'

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const reviewsResponseSchema = {
  type: 'object',
  properties: {
    versioning: { type: 'boolean' },
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'path', 'isNew', 'lastAuthor', 'updatedAt', 'prNumber', 'prUrl'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          isNew: { type: 'boolean' },
          lastAuthor: { type: ['string', 'null'] },
          updatedAt: { type: 'string' },
          prNumber: { type: 'integer' },
          prUrl: { type: 'string' },
        },
      },
    },
  },
  required: ['versioning', 'reviews'],
} as const

interface ReviewEntry {
  id: string
  title: string
  path: string
  isNew: boolean
  lastAuthor: string | null
  updatedAt: string
  prNumber: number
  prUrl: string
}

export function registerReviewRoutes(app: FastifyInstance, deps: GraphDeps): void {
  // Sub-plugin like every route module (OpenAPI visibility, see pages.ts).
  app.register(async (instance) => {
    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/reviews',
      {
        schema: {
          tags: ['workflow'],
          params: { type: 'object', properties: { space: { type: 'string' } }, required: ['space'] },
          response: { 200: reviewsResponseSchema, 403: errorSchema, 404: errorSchema, 502: errorSchema },
        },
      },
      async (req, reply) => {
        const spaceId = req.params.space
        const space = deps.spaces.find((s) => s.id === spaceId)
        // Unknown space and missing read access answer identically.
        const notFound = () => reply.code(404).send({ status: 'not_found', reason: `Space "${spaceId}" is not configured.` })
        if (!space) return notFound()
        if (deps.access && !(await deps.access.canRead(req.user!.id, space))) return notFound()
        if (deps.canWrite && !(await deps.canWrite(req.user!.id, space))) {
          return reply.code(403).send({ status: 'forbidden', reason: 'Reviews are only visible with write access to the space.' })
        }

        let open: OpenReview[]
        try {
          ;({ open } = await openReviews(deps.db, deps.providerRegistry(space), space))
        } catch (err) {
          req.log.warn({ err, space: space.id }, 'Reviews: listing pull requests failed')
          return reply.code(502).send({ status: 'error', reason: 'The Git provider could not list the open pull requests.' })
        }

        // One SELECT for all ids: a draft without a main row is a new page.
        const ids = open.map((o) => o.row.id)
        const onMain = new Set<string>()
        if (ids.length > 0) {
          const mainRows = await deps.db
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.spaceId, space.id), eq(pages.ref, 'main'), inArray(pages.id, ids)))
          for (const r of mainRows) onMain.add(r.id)
        }

        const reviews: ReviewEntry[] = open
          .map(({ row, pr }) => ({
            id: row.id,
            title: row.title,
            path: row.path,
            isNew: !onMain.has(row.id),
            lastAuthor: row.lastAuthor,
            updatedAt: row.updatedAt.toISOString(),
            prNumber: pr.number,
            prUrl: pr.url,
          }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

        // Same cached schema path as `GET /review` and `POST /release`.
        const schema = await loadMetadataSchema({ providerRegistry: deps.providerRegistry }, space, 'main', req.log)
        return { versioning: schema.versioning, reviews }
      },
    )
  })
}
