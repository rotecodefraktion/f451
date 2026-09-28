import type { FastifyInstance, FastifyReply } from 'fastify'
import { InvalidOrderError, ParentPageNotFoundError, reorderChildren } from '../drafts/reorder-children.js'
import { resolveNewPageWriteContext, type DraftsDeps } from './drafts.js'

/**
 * `PUT /api/spaces/:space/order` (Phase 3.3, „Baum-Umsortierung über
 * `.order`-Dateien"): eigenes, kleines Routen-Modul (Muster
 * `routes/create-page.ts`/`routes/move-page.ts`). Anders als bei
 * `resolveWriteContext` (Seite bereits über eine `pages`-Zeile bekannt) startet
 * das Gate hier vom `space`-Parameter der URL — `parentId` (Body, `null` =
 * Space-Wurzel) referenziert einen ELTERNKNOTEN, dessen Kinder umsortiert
 * werden, nicht die zu ändernde Seite selbst; `resolveNewPageWriteContext`
 * (dieselbe Gate-Kette wie die Seitenanlage, `routes/create-page.ts`) passt
 * daher besser als `resolveWriteContext`.
 *
 * Body `{ parentId: string | null, orderedIds: string[] }`: `orderedIds` sind
 * die Kind-Ids in gewünschter Reihenfolge. Business-Logik (Validierung,
 * `.order`-Datei schreiben, `orderKey` gezielt aktualisieren) liegt wie bei
 * den übrigen Schreib-Routen unter `drafts/` (`drafts/reorder-children.ts`).
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

const reorderBodySchema = {
  type: 'object',
  properties: {
    parentId: { type: ['string', 'null'] },
    orderedIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['parentId', 'orderedIds'],
} as const

const reorderResultSchema = {
  type: 'object',
  properties: {
    parentId: { type: ['string', 'null'] },
    path: { type: 'string' },
    orderedIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['parentId', 'path', 'orderedIds'],
} as const

const reorderSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { space: { type: 'string' } },
    required: ['space'],
  },
  body: reorderBodySchema,
  response: {
    200: reorderResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Muster `routes/drafts.ts`/
 *  `routes/move-page.ts`: „Provider nicht erreichbar → 502, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

export function registerReorderRoute(app: FastifyInstance, deps: DraftsDeps): void {
  app.register(async (instance) => {
    instance.put<{ Params: { space: string }; Body: { parentId: string | null; orderedIds: string[] } }>(
      '/api/spaces/:space/order',
      { schema: reorderSchema },
      async (req, reply) => {
        const ctx = await resolveNewPageWriteContext(deps, req.user!.id, req.params.space)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          const result = await reorderChildren(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.space,
            req.body.parentId,
            req.body.orderedIds,
          )
          return result
        } catch (err) {
          if (err instanceof ParentPageNotFoundError) {
            return reply.code(404).send({ status: 'not_found', reason: err.message })
          }
          if (err instanceof InvalidOrderError) {
            return reply.code(400).send({ status: 'bad_request', reason: err.message })
          }
          return providerErrorReply(reply, err)
        }
      },
    )
  })
}
