import type { FastifyInstance, FastifyReply } from 'fastify'
import { createPage, InvalidTitleError, ParentPageNotFoundError, PageCollisionError } from '../drafts/create-page.js'
import { readTemplateBody, type TemplatesDeps } from '../templates/registry.js'
import { resolveNewPageWriteContext, type DraftsDeps } from './drafts.js'

/**
 * `POST /api/pages` (Phase 2d Task 5): legt eine neue Seite als Draft-only-
 * Seite an — eigenes, kleines Routen-Modul statt Anbau an `routes/pages.ts`
 * (trägt ausschließlich die main-only-Lese-API, siehe deren Kopf-Kommentar)
 * oder `routes/drafts.ts` (bereits 300+ Zeilen, fünf bestehende Routen): die
 * Anlage ist eine eigenständige Schreib-Operation mit eigenem Gate-Einstieg
 * (`space` statt einer bereits bekannten `pageId`, siehe
 * `resolveNewPageWriteContext`), Business-Logik liegt wie bei den übrigen
 * Schreib-Routen unter `drafts/` (`drafts/create-page.ts`). Teilt sich
 * `DraftsDeps` mit den Draft-/Lock-/Workflow-Routen (dieselbe Gate-Basis).
 *
 * `templateId` (Phase 3c Task 3, optional): wird per `readTemplateBody`
 * (`templates/registry.ts`) aufgelöst — deshalb zusätzlich `TemplatesDeps`
 * (`providerRegistry`/`globalTemplates`, dieselbe Service-Account-Registry
 * wie `routes/templates.ts`, NICHT die Nutzer-Provider-Factory).
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

const createPageBodySchema = {
  type: 'object',
  properties: {
    space: { type: 'string' },
    parentId: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    // Bewusst OHNE Typ-Constraint (Plan Global Constraints): AJV soll ein
    // falsches JSON (Array, Zahl, …) NICHT ablehnen — der Handler validiert
    // selbst und antwortet mit dem projektweiten `{status,reason}`-Format
    // statt Fastifys generischer Schema-Fehlermeldung.
    templateId: {},
  },
  required: ['space', 'title'],
} as const

const createPageResultSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    space: { type: 'string' },
    path: { type: 'string' },
    branch: { type: 'string' },
    baseSha: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['id', 'space', 'path', 'branch', 'baseSha', 'content'],
} as const

const createPageSchema = {
  tags: ['pages'],
  body: createPageBodySchema,
  response: {
    201: createPageResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: collisionSchema,
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (wie `routes/drafts.ts`/
 *  `routes/workflow.ts`: „Provider nicht erreichbar → 502, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

export function registerCreatePageRoute(app: FastifyInstance, deps: DraftsDeps & TemplatesDeps): void {
  app.register(async (instance) => {
    instance.post<{ Body: { space: string; parentId?: string; title: string; templateId?: unknown } }>(
      '/api/pages',
      { schema: createPageSchema },
      async (req, reply) => {
        const ctx = await resolveNewPageWriteContext(deps, req.user!.id, req.body.space)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        // `templateId` trägt bewusst KEIN Schema-Typ-Constraint (siehe
        // `createPageBodySchema`) — die Validierung passiert hier, damit ein
        // falscher Typ dasselbe `{status,reason}`-Format wie eine unbekannte
        // Id bekommt statt Fastifys generischer Schema-Fehlerantwort.
        let template: { body: string; autor: string } | undefined
        const { templateId } = req.body
        if (templateId !== undefined) {
          if (Array.isArray(templateId) || typeof templateId !== 'string') {
            return reply.code(400).send({ status: 'bad_request', reason: 'templateId muss ein String sein.' })
          }
          // Provider-Fehler beim Template-Lesen (Timeout/5xx/Netz) ist ein 502,
          // kein 500 (Phase-3b-Lehre / Projekt-Fehlervertrag) — `readTemplateBody`
          // fängt selbst nur `NotFoundError` (→ null, unten als 400 „unbekanntes
          // Template" behandelt), jeder andere Fehler muss hier auf denselben
          // `providerErrorReply`-Vertrag gemappt werden wie beim `createPage`-Block
          // unten (Muster: `routes/drafts.ts`).
          let t: Awaited<ReturnType<typeof readTemplateBody>>
          try {
            t = await readTemplateBody(deps, ctx.space, templateId)
          } catch (err) {
            return providerErrorReply(reply, err)
          }
          if (!t) {
            return reply
              .code(400)
              .send({ status: 'bad_request', reason: `Unbekanntes Template "${templateId}".` })
          }
          template = { body: t.body, autor: req.user!.displayName }
        }

        try {
          const result = await createPage(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.space,
            req.body.parentId,
            req.body.title,
            template,
          )
          return reply.code(201).send(result)
        } catch (err) {
          if (err instanceof PageCollisionError) {
            return reply.code(409).send({ error: err.message, pageId: err.pageId })
          }
          if (err instanceof ParentPageNotFoundError) {
            return reply.code(404).send({ status: 'not_found', reason: err.message })
          }
          if (err instanceof InvalidTitleError) {
            return reply.code(400).send({ status: 'bad_request', reason: err.message })
          }
          return providerErrorReply(reply, err)
        }
      },
    )
  })
}
