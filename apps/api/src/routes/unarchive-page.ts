import type { FastifyInstance, FastifyReply } from 'fastify'
import { NotFoundError } from '@f451/git-provider'
import { UnarchiveBlockedError, unarchivePage } from '../drafts/unarchive-page.js'
import { resolveWriteContext, type DraftsDeps } from './drafts.js'

/**
 * `POST /api/pages/:id/unarchive` (Feature „Unarchive"): eigenes, kleines
 * Routen-Modul (Muster `routes/move-page.ts`/`routes/delete-page.ts`), teilt
 * sich dieselbe Gate-Kette (`resolveWriteContext`) wie die übrigen
 * Schreib-Routen. Eine archivierte Seite blendet den „Bearbeiten"-Link in der
 * Leseansicht aus (`components/page-view.tsx`) — diese Route ist der einzige
 * Weg zurück, OHNE den Editor zu öffnen.
 */

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

const unarchivePageResultSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    path: { type: 'string' },
  },
  required: ['id', 'path'],
} as const

const unarchivePageSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  response: {
    200: unarchivePageResultSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: errorSchema,
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Muster `routes/drafts.ts`/
 *  `routes/move-page.ts`: „Provider nicht erreichbar → 502, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

export function registerUnarchivePageRoute(app: FastifyInstance, deps: DraftsDeps): void {
  app.register(async (instance) => {
    instance.post<{ Params: { id: string } }>(
      '/api/pages/:id/unarchive',
      { schema: unarchivePageSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          const result = await unarchivePage(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.space,
            ctx.row.id,
            ctx.row.path,
          )
          return result
        } catch (err) {
          if (err instanceof UnarchiveBlockedError) {
            return reply.code(409).send({ status: 'conflict', reason: err.message })
          }
          if (err instanceof NotFoundError) {
            return reply.code(404).send({ status: 'not_found', reason: err.message })
          }
          return providerErrorReply(reply, err)
        }
      },
    )
  })
}
