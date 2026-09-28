import type { FastifyInstance, FastifyReply } from 'fastify'
import { NotFoundError } from '@f451/git-provider'
import {
  CircularMoveError,
  InvalidTitleError,
  MoveBlockedError,
  movePage,
  PageCollisionError,
  ParentPageNotFoundError,
  RootPageMoveError,
} from '../drafts/move-page.js'
import { resolveWriteContext, type DraftsDeps } from './drafts.js'

/**
 * `POST /api/pages/:id/move` (Phase 3.2, „Seite verschieben/umbenennen"):
 * eigenes, kleines Routen-Modul (Muster `routes/create-page.ts`/
 * `routes/delete-page.ts`), teilt sich dieselbe Gate-Kette
 * (`resolveWriteContext`) wie die übrigen Schreib-Routen. `id` bleibt in der
 * Antwort UNVERÄNDERT (Phase 3.1: stabile Id übersteht den Move) — die UI
 * bleibt dadurch auf derselben `/wiki/<space>/<id>`-Route.
 *
 * Body `{ title?, parentId? }`: `title` (Rename) und `parentId` (Move-Ziel,
 * `null` = Space-Wurzel) können einzeln oder gemeinsam angegeben werden.
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

const collisionSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, pageId: { type: 'string' } },
  required: ['error', 'pageId'],
} as const

const blockedSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    reason: { type: 'string' },
    blockedPageIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'reason', 'blockedPageIds'],
} as const

const movePageBodySchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    parentId: { type: ['string', 'null'] },
  },
} as const

const movePageResultSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    space: { type: 'string' },
    path: { type: 'string' },
    movedCount: { type: 'number' },
  },
  required: ['id', 'space', 'path', 'movedCount'],
} as const

const movePageSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  body: movePageBodySchema,
  response: {
    200: movePageResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: { anyOf: [collisionSchema, blockedSchema] },
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Muster `routes/drafts.ts`/
 *  `routes/create-page.ts`: „Provider nicht erreichbar → 502, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

export function registerMovePageRoute(app: FastifyInstance, deps: DraftsDeps): void {
  app.register(async (instance) => {
    instance.post<{ Params: { id: string }; Body: { title?: string; parentId?: string | null } }>(
      '/api/pages/:id/move',
      { schema: movePageSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          const result = await movePage(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.space,
            ctx.row.id,
            ctx.row.path,
            ctx.row.title,
            { title: req.body.title, parentId: req.body.parentId },
          )
          return result
        } catch (err) {
          if (err instanceof PageCollisionError) {
            return reply.code(409).send({ error: err.message, pageId: err.pageId })
          }
          if (err instanceof MoveBlockedError) {
            return reply
              .code(409)
              .send({ status: 'conflict', reason: err.message, blockedPageIds: err.blockedPageIds })
          }
          if (err instanceof ParentPageNotFoundError) {
            return reply.code(404).send({ status: 'not_found', reason: err.message })
          }
          if (err instanceof InvalidTitleError || err instanceof CircularMoveError || err instanceof RootPageMoveError) {
            return reply.code(400).send({ status: 'bad_request', reason: err.message })
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
