import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import {
  compareClassifications,
  effectiveClassification,
  type Classification,
  type PageFrontmatter,
} from '@f451/markdown'
import type { Db } from '../db/client.js'
import { pages } from '../db/schema.js'
import type { SpaceConfig } from '../spaces/config.js'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'

/**
 * Token classification limit (#39): an API token only reaches pages up to its
 * `maxClassification`. Sessions have no limit. Repository permissions are
 * checked by the routes as before; this gate only narrows what a token sees.
 *
 * `GET /api/pages/:id` is left to its route, which answers with a `restricted`
 * envelope (title and class, no content) so an agent can tell its human the
 * token is too narrow. Every other page-scoped route (source, diff, review,
 * drafts, release, media upload, …) answers 403 `token_classification_limit`.
 */

export interface ClassificationGateDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  /** Optional like in `AppOptions`; without it no space schema is known and
   *  the gate stays open (no classes configured anywhere). */
  providerRegistry?: (space: SpaceConfig) => GitProvider
}

type Log = { warn: (obj: unknown, msg: string) => void }

/** Effective class of a page, `null` when unknown or the space has classes off. */
export async function pageClassification(
  deps: ClassificationGateDeps,
  pageId: string,
  log: Log,
): Promise<Classification | null> {
  if (!deps.providerRegistry) return null
  const rows = await deps.db
    .select({ spaceId: pages.spaceId, frontmatter: pages.frontmatter, ref: pages.ref })
    .from(pages)
    .where(eq(pages.id, pageId))
  // main wins over draft; a draft-only page (never released) still has a class.
  const row = rows.find((r) => r.ref === 'main') ?? rows[0]
  if (!row) return null
  const space = deps.spaces.find((s) => s.id === row.spaceId)
  if (!space) return null
  const schema = await loadMetadataSchema({ providerRegistry: deps.providerRegistry }, space, 'main', log)
  return effectiveClassification((row.frontmatter as PageFrontmatter).classification, schema.classification)
}

/** `true` when `classification` is above the token limit of this request. */
export function exceedsTokenLimit(req: FastifyRequest, classification: Classification | null): boolean {
  const limit = req.apiTokenMaxClassification
  return Boolean(limit && classification && compareClassifications(classification, limit) > 0)
}

export function createClassificationGate(deps: ClassificationGateDeps) {
  return async function classificationGate(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (!req.apiTokenMaxClassification) return
    const route = req.routeOptions.url
    if (!route || !route.startsWith('/api/pages/:id')) return
    if (route === '/api/pages/:id' && req.method === 'GET') return
    const id = (req.params as { id?: string }).id
    if (!id) return
    if (!exceedsTokenLimit(req, await pageClassification(deps, id, req.log))) return
    // String payload: bypasses each route's own 403 schema (same reason as the
    // read-scope gate in app.ts).
    reply.header('content-type', 'application/json; charset=utf-8')
    return reply.code(403).send(
      JSON.stringify({
        status: 'forbidden',
        reason: 'token_classification_limit',
        message: 'This page is classified above the limit of this API token.',
      }),
    )
  }
}
