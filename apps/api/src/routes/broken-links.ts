import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import type { SpaceAccess } from '../auth/permissions.js'
import type { Db } from '../db/client.js'
import { edges, pages } from '../db/schema.js'
import type { SpaceConfig } from '../spaces/config.js'
import { hiddenPageIds } from './graph.js'

export interface BrokenLinksDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  /** Zugriffsprüfer — wie bei den Pages-Routen: gesetzt ⇒ 404-statt-403
   *  (kein Existenz-Orakel), ungesetzt (kein Auth) ⇒ offen (1c-Verhalten). */
  access?: SpaceAccess
  /** Service-account provider to read each space's `_meta/schema.yaml`
   *  (security classifications, #39). Without it no space has classes. */
  providerRegistry?: (space: SpaceConfig) => GitProvider
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const brokenLinksSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { space: { type: 'string' } },
    required: ['space'],
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rawTarget: { type: 'string' },
                type: { type: 'string', enum: ['link', 'relation'] },
                label: { type: 'string' },
              },
              required: ['rawTarget', 'type', 'label'],
            },
          },
        },
        required: ['pageId', 'title', 'path', 'entries'],
      },
    },
    404: errorSchema,
  },
} as const

interface ReportRow {
  pageId: string
  title: string
  path: string
  entries: Array<{ rawTarget: string; type: string; label: string }>
}

/**
 * Registriert `GET /api/spaces/:space/broken-links` (Phase 3a Task 3) — der
 * Space-weite Broken-Link-Report aus der Spec (§5: „Report pro Seite und pro
 * Space — Feature, nicht Fehler"; das Pro-Seiten-Pendant liefert bereits
 * `GET /api/pages/:id` als `brokenLinks`). Datengrundlage sind die beim
 * Indexieren geschriebenen `edges`-Zeilen mit `toPageId IS NULL`:
 * `type='link'` (Wikilinks + relative Links) und `type='relation'`
 * (Frontmatter-Beziehungen, `label` = Relationstyp). `hierarchy`-Kanten
 * bleiben außen vor: sie entstehen nie kaputt (`parentOf` liefert nur
 * existierende Eltern); eine per `ON DELETE SET NULL` genullte
 * Hierarchie-Kante ist ein transienter Zustand bis zum nächsten Reindex,
 * kein Inhaltsproblem. Nur `ref='main'` — der Report ist eine Lese-Ansicht.
 */
export function registerBrokenLinksRoutes(app: FastifyInstance, deps: BrokenLinksDeps): void {
  // Wie die übrigen Routen-Module: eigenes Sub-Plugin, damit die Route in
  // der generierten OpenAPI-Spec erscheint (siehe Kommentar in `pages.ts`).
  app.register(async (instance) => {
    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/broken-links',
      { schema: brokenLinksSchema },
      async (req, reply) => {
        const spaceId = req.params.space
        const space = deps.spaces.find((s) => s.id === spaceId)
        if (!space) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` })
        }
        // Kein Zugriff → dieselbe 404 wie „nicht konfiguriert" (kein Existenz-Orakel).
        if (deps.access && !(await deps.access.canRead(req.user!.id, space))) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` })
        }

        const rows = await deps.db
          .select({
            pageId: edges.fromPageId,
            title: pages.title,
            path: pages.path,
            rawTarget: edges.rawTarget,
            type: edges.type,
            label: edges.label,
          })
          .from(edges)
          .innerJoin(pages, and(eq(pages.id, edges.fromPageId), eq(pages.ref, edges.ref)))
          .where(
            and(
              eq(pages.spaceId, spaceId),
              eq(pages.ref, 'main'),
              isNull(edges.toPageId),
              inArray(edges.type, ['link', 'relation']),
            ),
          )
          .orderBy(asc(pages.path), asc(edges.type), asc(edges.rawTarget))

        // Security finding F-05: link targets and labels are page content —
        // drop source pages the page graph and search hide (strictly
        // confidential, and for API tokens anything above the limit).
        const hidden = await hiddenPageIds(deps, space, req, req.log)

        // Pro Seite gruppieren — die Zeilen kommen pfad-sortiert, die Map
        // erhält diese Reihenfolge (Insertion Order).
        const byPage = new Map<string, ReportRow>()
        for (const r of rows) {
          if (hidden.has(r.pageId)) continue
          let row = byPage.get(r.pageId)
          if (!row) {
            row = { pageId: r.pageId, title: r.title, path: r.path, entries: [] }
            byPage.set(r.pageId, row)
          }
          row.entries.push({ rawTarget: r.rawTarget, type: r.type, label: r.label })
        }
        return [...byPage.values()]
      },
    )
  })
}
