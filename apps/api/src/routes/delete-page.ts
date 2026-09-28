import type { FastifyInstance, FastifyReply } from 'fastify'
import { deletePage } from '../drafts/delete-page.js'
import { resolveWriteContext, type DraftsDeps } from './drafts.js'

/**
 * `DELETE /api/pages/:id` (Feature „Seite löschen"): eigenes, kleines
 * Routen-Modul (Muster `routes/create-page.ts`) statt Anbau an
 * `routes/pages.ts` (trägt ausschließlich die main-only-Lese-API) oder
 * `routes/drafts.ts` (verwirft nur den DRAFT, nicht die Seite selbst) —
 * teilt sich dieselbe Gate-Kette (`resolveWriteContext`) wie die übrigen
 * Schreib-Routen.
 *
 * Löscht die Markdown-Datei per Commit DIREKT auf `main` — bewusst KEIN
 * Review-Umweg (anders als der reguläre Editier-Workflow): eine Löschung
 * ist ein Einzelschritt, kein Inhalt, der noch begutachtet werden müsste,
 * und ein Review-PR für eine gelöschte Datei hätte ohnehin nichts mehr zu
 * diffen. Räumt zusätzlich Index/Lock/einen evtl. offenen Draft-Branch auf
 * (`drafts/delete-page.ts`). Antwortet `200 {ok:true}`.
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

const deletePageResultSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
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
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Muster `routes/drafts.ts`/
 *  `routes/create-page.ts`: „Provider nicht erreichbar → 502, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

export function registerDeletePageRoute(app: FastifyInstance, deps: DraftsDeps): void {
  app.register(async (instance) => {
    instance.delete<{ Params: { id: string } }>(
      '/api/pages/:id',
      { schema: deletePageSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          await deletePage({ db: deps.db }, ctx.provider, ctx.space.repoRef, ctx.row.id, ctx.row.path)
          return { ok: true }
        } catch (err) {
          return providerErrorReply(reply, err)
        }
      },
    )
  })
}
