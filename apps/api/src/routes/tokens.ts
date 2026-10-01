import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { generateApiToken, generateSessionId, hashApiToken } from '../auth/crypto.js'
import { requireBrowserSession } from '../auth/sessions.js'
import { apiTokens } from '../db/schema.js'
import { CLASSIFICATIONS, DEFAULT_CLASSIFICATION, type Classification } from '@f451/markdown'

export interface TokensRoutesDeps {
  db: Db
}

/** Sanity-Obergrenze gegen absurde/Integer-Overflow-Eingaben — keine
 *  fachliche Vorgabe, nur ein großzügiger, aber endlicher Deckel (10 Jahre). */
const MAX_EXPIRES_IN_DAYS = 3650

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const createBodySchema = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    scope: { type: 'string', enum: ['read', 'write'] },
    expiresInDays: { type: 'number' },
    maxClassification: { type: 'string', enum: [...CLASSIFICATIONS] },
  },
  required: ['label', 'scope'],
} as const

const createResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string' },
    expiresAt: { type: ['string', 'null'] },
    // Klartext-Token — erscheint EXAKT HIER und nie wieder (weder in einer
    // späteren Antwort noch in der DB, die nur `token_hash` speichert).
    token: { type: 'string' },
  },
  required: ['id', 'label', 'scope', 'expiresAt', 'token'],
} as const

const listItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string' },
    maxClassification: { type: 'string' },
    createdAt: { type: 'string' },
    lastUsedAt: { type: ['string', 'null'] },
    expiresAt: { type: ['string', 'null'] },
    revoked: { type: 'boolean' },
  },
  required: ['id', 'label', 'scope', 'maxClassification', 'createdAt', 'lastUsedAt', 'expiresAt', 'revoked'],
} as const

const deleteResponseSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
} as const

const createSchema = {
  tags: ['tokens'],
  body: createBodySchema,
  response: { 200: createResponseSchema, 400: errorSchema, 403: errorSchema },
} as const

const listSchema = {
  tags: ['tokens'],
  response: { 200: { type: 'array', items: listItemSchema }, 403: errorSchema },
} as const

const deleteSchema = {
  tags: ['tokens'],
  params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  response: { 200: deleteResponseSchema, 403: errorSchema, 404: errorSchema },
} as const

/**
 * Persönliche API-Token-Verwaltung (MCP-Phase 0) — das Fundament, auf dem der
 * spätere MCP-Server als der jeweilige Nutzer liest/schreibt: ein Token
 * authentifiziert exakt wie eine Session (`auth/sessions.ts
 * #createSessionAuthHook`), sodass sämtliche bestehenden Schreibrouten (die
 * nur an `req.user.id` hängen) unverändert bleiben.
 *
 * ALLE drei Routen verlangen eine ECHTE Browser-Session
 * (`requireBrowserSession`, NICHT `requireSession`) — ein API-Token darf sich
 * nicht selbst verwalten (erzeugen/einsehen/widerrufen), sonst könnte ein
 * einmal ausgestelltes Token sich beliebig weitere, z. B. mit mehr Rechten,
 * ausstellen (Bootstrapping-Lücke).
 *
 * Der Klartext eines neuen Tokens erscheint EXAKT EINMAL — in der Antwort von
 * `POST /api/tokens` — danach ist nur noch `sha256(token)` in der DB
 * (`api_tokens.token_hash`, Unique-Index) vorhanden; er ist aus der DB nicht
 * rekonstruierbar.
 */
export function registerTokensRoutes(app: FastifyInstance, deps: TokensRoutesDeps): void {
  app.register(async (instance) => {
    instance.post<{ Body: { label: string; scope: 'read' | 'write'; expiresInDays?: number; maxClassification?: Classification } }>(
      '/api/tokens',
      { schema: createSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const { scope, expiresInDays } = req.body
        const maxClassification = req.body.maxClassification ?? DEFAULT_CLASSIFICATION
        const label = req.body.label.trim()

        if (!label) {
          return reply.code(400).send({ status: 'bad_request', reason: 'label darf nicht leer sein.' })
        }
        if (scope !== 'read' && scope !== 'write') {
          return reply.code(400).send({ status: 'bad_request', reason: 'scope muss "read" oder "write" sein.' })
        }
        if (
          expiresInDays !== undefined &&
          (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > MAX_EXPIRES_IN_DAYS)
        ) {
          return reply.code(400).send({
            status: 'bad_request',
            reason: `expiresInDays muss zwischen 1 und ${MAX_EXPIRES_IN_DAYS} liegen.`,
          })
        }

        const token = generateApiToken()
        const id = generateSessionId()
        const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null

        await deps.db.insert(apiTokens).values({
          id,
          userId: req.user!.id,
          tokenHash: hashApiToken(token),
          label,
          scope,
          maxClassification,
          expiresAt,
        })

        return reply.code(200).send({
          id,
          label,
          scope,
          maxClassification,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          token,
        })
      },
    )

    instance.get('/api/tokens', { schema: listSchema, preHandler: requireBrowserSession }, async (req) => {
      const rows = await deps.db.select().from(apiTokens).where(eq(apiTokens.userId, req.user!.id))
      // NIE tokenHash (oder gar Klartext) in der Liste — nur Metadaten.
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        scope: row.scope,
        maxClassification: row.maxClassification,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        revoked: row.revokedAt !== null,
      }))
    })

    instance.delete<{ Params: { id: string } }>(
      '/api/tokens/:id',
      { schema: deleteSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        // Soft-Revoke, GESCOPT auf den eigenen Nutzer (WHERE userId = ...) —
        // fremde Tokens sind über diese Route unsichtbar (404, kein 403, um
        // nicht einmal die Existenz einer fremden Token-Id zu bestätigen).
        const updated = await deps.db
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.id, req.params.id), eq(apiTokens.userId, req.user!.id)))
          .returning({ id: apiTokens.id })

        if (updated.length === 0) {
          return reply.code(404).send({ status: 'not_found', reason: 'Token nicht gefunden.' })
        }
        return reply.code(200).send({ ok: true })
      },
    )
  })
}
