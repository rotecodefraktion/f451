import type { FastifyInstance, FastifyReply } from 'fastify'
import { NotFoundError } from '@f451/git-provider'
import { requestDeletion } from '../drafts/request-deletion.js'
import { resolveWriteContext } from './drafts.js'
import type { WorkflowDeps } from './workflow.js'

/**
 * `DELETE /api/pages/:id` — request the deletion of a page through review
 * (f451#155). Same gate chain as the other write routes (`resolveWriteContext`).
 *
 * - Page released at least once: its whole folder is deleted on the draft
 *   branch and a review is opened → `200 { ok: true, review: { number, url } }`.
 *   `main` stays untouched until the review is released.
 * - Draft-only page (never released): the draft is discarded → `200 { ok: true }`.
 * - Refusals → `409 { status: 'root_page' | 'draft_pending' | 'subpage_busy',
 *   reason, pages? }` (`pages` only for `subpage_busy`).
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

const scopePageSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' } },
  required: ['id', 'title', 'path'],
} as const

const deletePageResultSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    review: {
      type: 'object',
      properties: { number: { type: 'integer' }, url: { type: 'string' } },
      required: ['number', 'url'],
    },
  },
  required: ['ok'],
} as const

const refusedSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['root_page', 'draft_pending', 'subpage_busy'] },
    reason: { type: 'string' },
    pages: { type: 'array', items: scopePageSchema },
  },
  required: ['status', 'reason'],
} as const

const deletePageSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  response: {
    200: deletePageResultSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: refusedSchema,
    502: errorSchema,
  },
} as const

/** Unexpected provider error → 502 (pattern of `routes/drafts.ts`). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider error: ${message}` })
}

export function registerDeletePageRoute(app: FastifyInstance, deps: WorkflowDeps): void {
  app.register(async (instance) => {
    instance.delete<{ Params: { id: string } }>(
      '/api/pages/:id',
      { schema: deletePageSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          const result = await requestDeletion({ db: deps.db, now: deps.now }, ctx.provider, ctx.space.repoRef, ctx.row, {
            userId: req.user!.id,
            publicBaseUrl: deps.publicBaseUrl,
          })
          switch (result.kind) {
            case 'discarded':
              return { ok: true }
            case 'review':
              return { ok: true, review: { number: result.number, url: result.url } }
            case 'refused':
              return reply.code(409).send({
                status: result.code,
                reason: result.reason,
                ...(result.pages ? { pages: result.pages } : {}),
              })
          }
        } catch (err) {
          if (err instanceof NotFoundError) {
            return reply.code(404).send({ status: 'not_found', reason: err.message })
          }
          return providerErrorReply(reply, err)
        }
      },
    )
  })
}
