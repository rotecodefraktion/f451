import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { NotFoundError } from '@f451/git-provider'
import { diffMarkdown, type PageFrontmatter } from '@f451/markdown'
import { pages, pageVersions } from '../db/schema.js'
import { buildResolveImage, buildResolveLink } from '../indexer/resolve-links.js'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'
import type { PagesDeps } from './pages.js'
import { buildSpaceLinkResolver } from './workflow.js'

/**
 * Seitenversionierung Etappe 2 (Spec `2026-07-19-seitenversionierung-design.md`,
 * „Lesepfad"): Versionsliste und Versionsdiff.
 *
 * Beide Routen verlangen nur LESErecht (`deps.access`), anders als
 * `GET /api/pages/:id/review`, das am Schreibkontext hängt — zurückblicken
 * darf jeder, der die Seite sieht. 404 bleibt existenz-orakel-neutral: „gibt
 * es nicht" und „darfst du nicht sehen" sind dieselbe Antwort.
 */

const paramsSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const versionEntrySchema = {
  type: 'object',
  properties: {
    version: { type: 'string' },
    releasedAt: { type: 'string' },
    author: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['version', 'releasedAt', 'author', 'note'],
} as const

const versionsSchema = {
  tags: ['pages'],
  params: paramsSchema,
  response: {
    200: {
      type: 'object',
      properties: {
        versioning: { type: 'boolean' },
        versions: { type: 'array', items: versionEntrySchema },
      },
      required: ['versioning', 'versions'],
    },
    404: errorSchema,
  },
} as const

const diffSchema = {
  tags: ['pages'],
  params: paramsSchema,
  querystring: {
    type: 'object',
    properties: { from: { type: 'string', minLength: 1 } },
    required: ['from'],
  },
  response: {
    200: {
      type: 'object',
      properties: {
        from: versionEntrySchema,
        /** Aktuelle Version auf `main`; fehlt, wenn die Seite (noch) keine trägt. */
        to: { type: 'string' },
        /** Offenes Schema wie beim Review-Diff (`routes/workflow.ts`). */
        diff: {},
        page: {
          type: 'object',
          properties: { id: { type: 'string' }, space: { type: 'string' }, title: { type: 'string' } },
          required: ['id', 'space', 'title'],
        },
      },
      required: ['from', 'diff', 'page'],
    },
    404: errorSchema,
    410: errorSchema,
    502: errorSchema,
  },
} as const

export function registerVersionRoutes(app: FastifyInstance, deps: PagesDeps): void {
  app.register(async (instance) => {
    /** Zeile auf `main` + Space, falls der Nutzer sie lesen darf. */
    async function readablePage(userId: string, id: string) {
      const [row] = await deps.db
        .select()
        .from(pages)
        .where(and(eq(pages.id, id), eq(pages.ref, 'main')))
        .limit(1)
      if (!row) return null
      const space = deps.spaces.find((s) => s.id === row.spaceId)
      if (!space) return null
      if (deps.access && !(await deps.access.canRead(userId, space))) return null
      return { row, space }
    }

    const notFound = (id: string) => ({ status: 'not_found', reason: `Seite "${id}" ist nicht bekannt.` })

    const toEntry = (v: typeof pageVersions.$inferSelect) => ({
      version: v.version,
      releasedAt: v.releasedAt.toISOString(),
      author: v.author,
      note: v.note,
    })

    // GET /versions: direkt aus `page_versions`, ohne Git-Zugriff (Spec: keine
    // Rate-Limit-Frage bei Provider-Aufrufen). Unversionierter Space → leere
    // Liste, auch wenn aus einer früheren Phase noch Zeilen existieren (Spec
    // „Grenzfälle": zurückgeschaltet → Daten bleiben, Anzeige verschwindet).
    instance.get<{ Params: { id: string } }>(
      '/api/pages/:id/versions',
      { schema: versionsSchema },
      async (req, reply) => {
        const found = await readablePage(req.user!.id, req.params.id)
        if (!found) return reply.code(404).send(notFound(req.params.id))

        const schema = await loadMetadataSchema(deps, found.space, 'main', req.log)
        if (!schema.versioning) return { versioning: false, versions: [] }

        const rows = await deps.db
          .select()
          .from(pageVersions)
          .where(eq(pageVersions.pageId, found.row.id))
          // Nach den Zahlenspalten, nie nach dem Text: '1.10.0' gehört hinter '1.2.0'.
          .orderBy(desc(pageVersions.major), desc(pageVersions.minor), desc(pageVersions.patch))
        return { versioning: true, versions: rows.map(toEntry) }
      },
    )

    // GET /diff?from=<version>: damaliger Stand über `readFile(ref=mergeSha)`
    // — `mergeSha` ist der Commit-SHA und genau als Git-Referenz gedacht —
    // gegen den heutigen Stand auf `main`, mit derselben `diffMarkdown`-
    // Struktur wie der Review-Diff, damit die Web-Komponente geteilt bleibt.
    instance.get<{ Params: { id: string }; Querystring: { from: string } }>(
      '/api/pages/:id/diff',
      { schema: diffSchema },
      async (req, reply) => {
        const found = await readablePage(req.user!.id, req.params.id)
        if (!found) return reply.code(404).send(notFound(req.params.id))
        const { row, space } = found

        const [from] = await deps.db
          .select()
          .from(pageVersions)
          .where(and(eq(pageVersions.pageId, row.id), eq(pageVersions.version, req.query.from)))
        if (!from) {
          return reply.code(404).send({ status: 'not_found', reason: `Version ${req.query.from} ist nicht bekannt.` })
        }

        const provider = deps.providerRegistry(space)
        let oldContent: string
        try {
          oldContent = (await provider.readFile(space.repoRef, row.path, from.mergeSha)).content
        } catch (err) {
          // Force-Push oder History-Rewrite: der Stand ist weg. Kein 500 (Spec
          // „Grenzfälle"). Ein Pfad, der zu diesem Commit noch anders hieß
          // (Rename), landet ebenfalls hier.
          if (err instanceof NotFoundError) {
            return reply.code(410).send({ status: 'gone', reason: `Stand von Version ${from.version} nicht mehr verfügbar.` })
          }
          return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${err instanceof Error ? err.message : String(err)}` })
        }

        let newContent: string
        try {
          newContent = (await provider.readFile(space.repoRef, row.path, 'main')).content
        } catch (err) {
          return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${err instanceof Error ? err.message : String(err)}` })
        }

        const resolver = await buildSpaceLinkResolver(deps.db, space.id)
        // Bilder und Anhänge beider Fassungen kommen von `main`: die Media-
        // Route kennt nur `main`/`draft`, keinen beliebigen Commit. Eine seither
        // ersetzte Grafik zeigt in der alten Fassung daher den heutigen Stand.
        const diff = diffMarkdown(oldContent, newContent, {
          resolveLink: buildResolveLink(resolver, row.path, space.id, row.id, 'main'),
          resolveImage: buildResolveImage(row.id, 'main'),
        })

        const to = (row.frontmatter as PageFrontmatter | null)?.version
        return {
          from: toEntry(from),
          ...(to ? { to } : {}),
          diff,
          page: { id: row.id, space: space.id, title: row.title },
        }
      },
    )
  })
}
