import { posix } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import {
  EMPTY_METADATA_SCHEMA,
  IMPLICIT_VERSION,
  type MetadataSchema,
  type PageFrontmatter,
} from '@f451/markdown'
import type { Db } from '../db/client.js'
import { edges, pageReleases, pages, pageVersions, tags } from '../db/schema.js'
import type { SpaceAccess } from '../auth/permissions.js'
import { getWorkflowState, loadFreshLock } from '../drafts/lifecycle.js'
import { applyAutoMetadata } from '../spaces/metadata-auto.js'
import {
  classificationFields,
  classificationViolation,
  classificationViolationMessage,
} from '../spaces/classification.js'
import { exceedsTokenLimit } from '../auth/classification-gate.js'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'
import type { SpaceConfig } from '../spaces/config.js'

export interface PagesDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  /**
   * Zugriffsprüfer (Plan Task 5). Nur gesetzt, wenn Auth aktiv ist. Ist er
   * gesetzt, filtern `/api/spaces` und `tree` auf zugängliche Spaces und
   * `Page`/`Raw` liefern 404 ohne Zugriff (kein Existenz-Orakel — 404, nicht
   * 403). Ist er `undefined` (kein Auth), bleibt alles offen (1c-Verhalten).
   */
  access?: SpaceAccess
  /**
   * Schreibrechte-Probe (Phase 2d Task 2, gecacht 5 min — `auth/permissions.ts#canWriteSpace`),
   * NUR für das `workflow`-Feld von `GET /api/pages/:id`: Entwurfs-/Review-Auskunft
   * ist Teil des Schreib-Workflows und darf reinen Lesern NIE zugänglich sein
   * (kein Informationsleck über Entwürfe, Plan Task 2 Interface). Wie `access`
   * nur gesetzt, wenn Auth aktiv ist — ohne sie (oder ohne `req.user`) bleibt
   * `workflow` immer `null`.
   */
  canWrite?: (userId: string, space: SpaceConfig) => Promise<boolean>
}

/** Ein Knoten im Navigationsbaum eines Space. */
export interface TreeNode {
  id: string
  title: string
  path: string
  archived: boolean
  hasChildren: boolean
  children: TreeNode[]
}

type PageRow = typeof pages.$inferSelect

/** `workflow`-Feld von `GET /api/pages/:id` (Plan Task 2 Interface). */
export interface PageWorkflowField {
  state: 'working' | 'review'
  pr: { number: number; url: string } | null
  lock: { user: string; mine: boolean } | null
}

/**
 * Berechnet das `workflow`-Feld (Phase 2d Task 2): NUR für eingeloggte Nutzer
 * mit (gecachtem) Schreibrecht auf den Space der Seite — Leser/Anonyme
 * bekommen immer `null` (kein Informationsleck über Entwürfe, Plan Task 2
 * Interface). Provider-Fehler beim Zustandsermitteln werden abgefangen und
 * geloggt statt den Request scheitern zu lassen: „Lesen darf nie ausfallen"
 * (Spec §9) — die Seite selbst kommt bereits vollständig aus dem Index, das
 * `workflow`-Feld ist reine Zusatzauskunft.
 */
async function resolveWorkflowField(
  deps: PagesDeps,
  req: FastifyRequest,
  row: PageRow,
): Promise<PageWorkflowField | null> {
  if (!deps.access || !deps.canWrite || !req.user) return null

  const space = deps.spaces.find((s) => s.id === row.spaceId)
  if (!space) return null

  const userId = req.user.id
  if (!(await deps.canWrite(userId, space))) return null

  try {
    const provider = deps.providerRegistry(space)
    const state = await getWorkflowState(provider, space.repoRef, row.id)
    if (!state) return null

    const lock = await loadFreshLock({ db: deps.db }, row.id, userId)
    return {
      state: state.state,
      pr: state.pr,
      lock: lock ? { user: lock.user, mine: lock.mine } : null,
    }
  } catch (err) {
    req.log.error({ err, pageId: row.id }, 'workflow: Provider-Fehler beim Zustandsermitteln')
    return null
  }
}

/**
 * Reichert die rohen Frontmatter-Metadaten einer Seite um die schema-
 * definierten `auto`-Felder an (Metadaten-Feature M3b Teil A): lädt das
 * Space-Schema (`spaces/metadata-schema.ts#loadMetadataSchema`, gecacht 5 min
 * — die HÄUFIGE Anfrage `GET /api/pages/:id` trifft den GitProvider dadurch
 * praktisch nie, nur bei einem Cache-Miss) und setzt `last_author`/
 * `last_updated` (bzw. jedes andere `type: auto`-Feld) über
 * `applyAutoMetadata` in eine KOPIE von `rawMetadata` ein — die reine
 * Ableitungslogik selbst ist dort unit-getestet (`metadata-auto.test.ts`),
 * hier nur die Beschaffung ihrer Eingaben.
 *
 * `loadMetadataSchema` ist selbst bereits fail-soft (Provider nicht
 * erreichbar/Datei fehlt/kaputt → leeres Schema statt Wurf, s. dortiger
 * Kommentar) — „Lesen darf nie ausfallen" (Spec §9) gilt dadurch automatisch
 * auch hier, ohne einen weiteren try/catch: schlägt das Laden fehl, bleibt
 * `metadata` schlicht bei den rohen Frontmatter-Werten (Bestandsverhalten vor
 * M3b).
 */
function resolveMetadata(
  row: PageRow,
  schema: MetadataSchema,
  rawMetadata: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.fields.every((f) => f.type !== 'auto')) return rawMetadata

  return applyAutoMetadata(schema, rawMetadata, {
    lastAuthor: row.lastAuthor,
    lastUpdatedIso: row.updatedAt.toISOString(),
  })
}

/**
 * Lädt das Space-Schema (`spaces/metadata-schema.ts#loadMetadataSchema`,
 * gecacht 5 min — die HÄUFIGE Anfrage `GET /api/pages/:id` trifft den
 * GitProvider dadurch praktisch nie, nur bei einem Cache-Miss) EINMAL pro
 * Anfrage für sowohl `metadata` (Auto-Felder, M3b Teil A) als auch die
 * Versionsanzeige (`versioning`, Task 8) — beide lesen dieselbe Datei
 * (`_meta/schema.yaml`), ein zweiter Ladevorgang wäre unnötig (wenn auch
 * dank Cache günstig).
 *
 * `loadMetadataSchema` ist selbst bereits fail-soft (Provider nicht
 * erreichbar/Datei fehlt/kaputt → leeres Schema statt Wurf, s. dortiger
 * Kommentar) — „Lesen darf nie ausfallen" (Spec §9) gilt dadurch automatisch
 * auch hier, ohne einen weiteren try/catch.
 */
async function loadSpaceSchema(
  deps: PagesDeps,
  req: FastifyRequest,
  space: SpaceConfig | undefined,
): Promise<MetadataSchema> {
  if (!space) return EMPTY_METADATA_SCHEMA
  return loadMetadataSchema({ providerRegistry: deps.providerRegistry }, space, 'main', req.log)
}

/** `version`/`versioning`/`changedSinceRelease`-Felder von `GET /api/pages/:id`
 *  (Seitenversionierung Etappe 1, Task 8, Plan-Interface). */
export interface PageVersionFields {
  versioning: boolean
  version?: string
  /** `true` when `version` is not in the frontmatter but derived: the page
   *  exists on `main` without `version` and therefore counts as
   *  {@link IMPLICIT_VERSION} (spec addendum 2026-10-02). Absent otherwise. */
  implicitVersion?: true
  changedSinceRelease: boolean
}

/**
 * Versionsanzeige (Seitenversionierung Etappe 1, Task 8): Die Version steht im
 * Frontmatter (Quelle der Wahrheit, `PageFrontmatter.version`, systemverwaltet
 * bei der Freigabe); `page_versions` liefert den zugehörigen Blob-SHA, um einen
 * Direkt-Commit an der Freigabe vorbei zu erkennen — bewusst ein BLOB-Vergleich
 * (Dateiinhalt), NICHT `page_versions.mergeSha` (Commit-SHA, andere SHA-Art,
 * wäre nie gleich `pages.lastBlobSha`; genau diese Verwechslung war bereits
 * zweimal ein Bug in diesem Feature).
 *
 * `versioning` kommt aus dem Space-Schema (`_meta/schema.yaml`,
 * `loadMetadataSchema`, gecacht) — ist der Schalter aus, bleibt die Antwort
 * frei von Versionsfeldern (`version` fehlt ganz statt `undefined`
 * mitzuschicken, `changedSinceRelease` bleibt `false`).
 *
 * `changedSinceRelease` wird NUR gesetzt, wenn BEIDE Blob-SHAs bekannt sind:
 * fehlt einer (z. B. `lastBlobSha === null`, weil die Seite bisher nur per
 * Voll-Reindex erfasst wurde, s. `pages.lastBlobSha`-Kommentar in
 * `db/schema.ts`), wäre "geändert" eine Falschaussage — dann lieber `false`
 * (keine Anzeige) statt eines falschen Hinweises.
 *
 * EXPORTIERT (Befund 3, Final-Review): `GET /api/pages/:id/review`
 * (`routes/workflow.ts`) braucht `versioning`/`version` für den Freigabe-
 * Dialog und lud sie bisher über einen ZWEITEN Fetch auf `GET /api/pages/:id`
 * mit `.catch(() => null)` nach — fiel der aus, verschwand der Versions-
 * abschnitt lautlos, und der Freigebende veröffentlichte mit dem Server-
 * Default `patch` statt der beabsichtigten Sprunggröße. Die Route ruft diese
 * Funktion jetzt direkt auf (derselbe gecachte `loadMetadataSchema`-Pfad,
 * s. dort), EIN Aufruf statt eines zweiten, ausfallanfälligen HTTP-Roundtrips.
 * Nimmt bewusst nur `{ db }` (nicht das volle `PagesDeps`) entgegen — die
 * einzige Abhängigkeit ist die DB, `routes/workflow.ts` hat kein `PagesDeps`.
 */
export async function resolveVersionFields(
  deps: { db: Db },
  row: PageRow,
  schema: MetadataSchema,
): Promise<PageVersionFields> {
  const versioning = schema.versioning
  if (!versioning) return { versioning, changedSinceRelease: false }

  const version = (row.frontmatter as PageFrontmatter | null)?.version
  if (!version) {
    // An existing page (on `main`) without `version` counts as 0.1.0 — derived,
    // never written. A draft-only page (`ref: 'draft'`) has no version yet.
    if (row.ref === 'main') {
      return { versioning, version: IMPLICIT_VERSION, implicitVersion: true, changedSinceRelease: false }
    }
    return { versioning, changedSinceRelease: false }
  }

  const [latest] = await deps.db
    .select({ blobSha: pageVersions.blobSha })
    .from(pageVersions)
    .where(and(eq(pageVersions.pageId, row.id), eq(pageVersions.version, version)))

  const changedSinceRelease = !!latest?.blobSha && !!row.lastBlobSha && latest.blobSha !== row.lastBlobSha
  return { versioning, version, changedSinceRelease }
}

/**
 * Redirect-Lookup für überholte `path:`-Fallback-Ids (Phase 3.1, „Stabile
 * Seiten-Id + Backfill + Redirect"): `GET /api/pages/:id` ruft dies NUR auf,
 * wenn `id` keine Zeile trifft. Fallback-Ids haben die Form
 * `path:<spaceId>/<filePath>` (`derivePageId`, `indexer/index-space.ts`) —
 * `spaceId` selbst enthält laut Space-Konfiguration nie `/`, das ERSTE `/`
 * nach dem `path:`-Präfix trennt daher zuverlässig `spaceId` von `filePath`.
 * Ein Backfill-Lauf (`POST /admin/backfill-ids`) ändert NUR die `id` einer
 * Seite (Frontmatter-Injektion + Reindex), NIE ihren `path` — ein Treffer per
 * `(spaceId, path)` liefert daher zuverlässig die aktuelle, kanonische Id
 * derselben Seite (kein Move, das ist Phase 3.2).
 *
 * Dieselbe Zugriffsprüfung wie der Haupt-Handler (`deps.access`): eine Seite
 * in einem für den Nutzer unsichtbaren Space darf über den Redirect-Umweg
 * nicht plötzlich doch eine Id preisgeben (kein Existenz-Orakel, wie überall
 * sonst in dieser Datei).
 */
async function lookupRedirectTarget(deps: PagesDeps, req: FastifyRequest, id: string): Promise<string | null> {
  if (!id.startsWith('path:')) return null
  const rest = id.slice('path:'.length)
  const slashIdx = rest.indexOf('/')
  if (slashIdx <= 0) return null
  const spaceId = rest.slice(0, slashIdx)
  const filePath = rest.slice(slashIdx + 1)
  if (filePath.length === 0) return null

  const space = deps.spaces.find((s) => s.id === spaceId)
  if (!space) return null
  if (deps.access && !(await deps.access.canRead(req.user!.id, space))) return null

  const row = (
    await deps.db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.spaceId, spaceId), eq(pages.path, filePath), eq(pages.ref, 'main')))
      .limit(1)
  )[0]
  return row?.id ?? null
}

/** Dateiname für den Markdown-Export (`?download=1`, s. `rawSchema` unten):
 *  das Verzeichnis der Seiten-Datei (jede Seite ist `index.md` oder
 *  `<Verzeichnis>/index.md`, s. `drafts/create-page.ts#directoryOf`) statt
 *  der rohen `pageId` — Fallback-Ids (kein Frontmatter-`id`) haben die Form
 *  `path:<space>/<Pfad>` (`:`/`/`), ein untaugliches `<a download>`-Ziel.
 *  Die Space-Wurzel (`index.md`, kein Verzeichnis) liefert `index.md`. */
function downloadFilename(pagePath: string): string {
  const dir = posix.dirname(pagePath)
  const base = dir === '.' ? 'index' : posix.basename(dir)
  return `${base}.md`
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const spaceListSchema = {
  tags: ['pages'],
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          defaultLang: { type: 'string' },
        },
        required: ['id', 'name', 'defaultLang'],
      },
    },
  },
} as const

const treeSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { space: { type: 'string' } },
    required: ['space'],
  },
  response: {
    // `children` ist rekursiv (beliebige Tiefe) — als offenes Schema deklariert
    // (`{}` = "beliebig"), damit fast-json-stringify verschachtelte Kinder nicht
    // stillschweigend abschneidet, weil sie nicht explizit im Schema stehen.
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          archived: { type: 'boolean' },
          hasChildren: { type: 'boolean' },
          children: { type: 'array', items: {} },
        },
        required: ['id', 'title', 'path', 'archived', 'hasChildren', 'children'],
      },
    },
    404: errorSchema,
  },
} as const

/** Nur die UI-relevanten PR-Felder (Nummer + Link) — siehe `lifecycle.ts#WorkflowPrInfo`. */
const workflowPrSchema = {
  type: 'object',
  properties: { number: { type: 'number' }, url: { type: 'string' } },
  required: ['number', 'url'],
} as const

/** Schmalere Lock-Auskunft als `draftLockSchema` (drafts.ts): kein `heartbeatAt`
 *  nötig, das `workflow`-Feld dient nur der Lese-/Notice-Anzeige, nicht dem
 *  Autosave-Vertrag. */
const workflowLockSchema = {
  type: 'object',
  properties: { user: { type: 'string' }, mine: { type: 'boolean' } },
  required: ['user', 'mine'],
} as const

const workflowSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['working', 'review'] },
    pr: { anyOf: [workflowPrSchema, { type: 'null' }] },
    lock: { anyOf: [workflowLockSchema, { type: 'null' }] },
  },
  required: ['state', 'pr', 'lock'],
} as const

/**
 * Redirect-Hinweis (Phase 3.1, „Stabile Seiten-Id + Backfill + Redirect"):
 * Antwortform, wenn `:id` eine ALTE pfadbasierte Fallback-Id (`path:<space>/
 * <Datei>`) ist, die seit einem Backfill-Lauf (`POST /admin/backfill-ids`)
 * keine Zeile mehr trifft — die Seite existiert weiterhin, aber unter einer
 * NEUEN, stabilen Frontmatter-Id. Bewusst 200 (statt echtem HTTP-Redirect):
 * der Client (`apps/web/.../[pageId]/page.tsx`) wertet `redirectTo` selbst
 * aus und ruft `next/navigation#redirect`, damit sich auch die BROWSER-URL
 * ändert (ein reiner HTTP-Redirect würde `fetch` auf dem Server transparent
 * folgen, ohne dass sich die vom Nutzer gesehene `/wiki/…`-URL aktualisiert —
 * alte Lesezeichen blieben dann dauerhaft auf der alten `path:`-URL). */
const redirectHintSchema = {
  type: 'object',
  properties: { redirectTo: { type: 'string' } },
  required: ['redirectTo'],
} as const

const pageSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  response: {
    200: {
      anyOf: [
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            space: { type: 'string' },
            path: { type: 'string' },
            title: { type: 'string' },
            html: { type: 'string' },
            headings: { type: 'array', items: {} },
            tags: { type: 'array', items: { type: 'string' } },
            relations: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
            frontmatterErrors: { type: 'array', items: { type: 'string' } },
            errorStatus: { type: ['string', 'null'] },
            archived: { type: 'boolean' },
            updatedAt: { type: 'string' },
            brokenLinks: { type: 'array', items: { type: 'string' } },
            // Phase 2d Task 2: NUR für eingeloggte Nutzer mit Schreibrecht befüllt
            // (siehe `PagesDeps.canWrite`-Kommentar) — Leser/Anonyme bekommen immer
            // `null`, kein Informationsleck über Entwürfe.
            workflow: { anyOf: [workflowSchema, { type: 'null' }] },
            // Metadaten-Feature M1 (Backend-Fundament): die geschema-freien
            // Frontmatter-Zusatzfelder der Seite (`PageFrontmatter.metadata`,
            // z. B. `process_id`/`approved_by` einer SAP-Prozess-Seite), roh
            // durchgereicht — offenes Schema wie `headings`/`children` (treeSchema),
            // da die Form von der (space-spezifischen) `_meta/schema.yaml` abhängt.
            // Auto-Felder (`last_author`/`last_updated`) werden HIER NUR
            // durchgereicht, falls sie bereits im Frontmatter stehen — die
            // tatsächliche Ableitung aus der Git-Historie ist M3 (noch offen).
            metadata: { type: 'object', additionalProperties: true },
            // Seitenversionierung Etappe 1 (Task 8): `versioning` kommt aus dem
            // Space-Schema (`_meta/schema.yaml`, `MetadataSchema.versioning`) und
            // wird IMMER mitgeliefert — der Freigabe-Dialog UND die Leseansicht
            // nutzen dieselbe Datenquelle. `version` (aus dem Frontmatter,
            // Semver der letzten Freigabe) fehlt bewusst GANZ statt `null`/
            // `undefined` mitzuschicken, wenn keine Version bekannt ist (nie
            // freigegeben oder Space unversioniert) — daher NICHT in `required`.
            // `changedSinceRelease` markiert einen Direkt-Commit an der Freigabe
            // vorbei (Blob-SHA-Vergleich, s. `resolveVersionFields`-Kommentar in
            // dieser Datei) und ist immer ein Bool (nie `undefined`).
            versioning: { type: 'boolean' },
            version: { type: 'string' },
            // Only present (true) when `version` is derived: page on `main`
            // without `version` counts as 0.1.0 (spec addendum 2026-10-02).
            implicitVersion: { type: 'boolean' },
            changedSinceRelease: { type: 'boolean' },
            // Security classifications: only present when the space enables them.
            classification: { type: 'string' },
            classificationSettings: {
              type: 'object',
              properties: { default: { type: 'string' }, max: { type: 'string' } },
            },
            // API token below the page's class (#39): content fields are empty.
            restricted: { type: 'boolean' },
            // Newest frozen release of the page (#40), if any.
            latestRelease: { type: 'string' },
          },
          required: [
            'id', 'space', 'path', 'title', 'html', 'headings', 'tags', 'relations',
            'frontmatterErrors', 'errorStatus', 'archived', 'updatedAt', 'brokenLinks', 'workflow',
            'metadata', 'versioning', 'changedSinceRelease',
          ],
        },
        // Redirect-Hinweis (s. `redirectHintSchema`-Kommentar oben) — ALTERNATIVE
        // 200-Form, wenn `:id` eine überholte `path:`-Fallback-Id ist.
        redirectHintSchema,
      ],
    },
    404: errorSchema,
  },
} as const

const rawSchema = {
  tags: ['pages'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  querystring: {
    type: 'object',
    properties: {
      // Feature „Markdown-Export": mit `download=1` setzt die Antwort
      // zusätzlich `Content-Disposition: attachment` (Muster
      // `routes/media.ts`s Nicht-Bild-Fallback), damit der Browser die Datei
      // herunterlädt statt sie inline zu öffnen. Ohne den Parameter bleibt
      // das Verhalten unverändert (der Interop-Endpunkt selbst ist NICHT
      // betroffen).
      download: { type: 'string' },
    },
  },
  response: {
    200: {
      description: 'Rohes Markdown der Seite, frisch vom Provider gelesen (main-Ref).',
      content: {
        'text/markdown': { schema: { type: 'string' } },
      },
    },
    404: errorSchema,
    502: errorSchema,
  },
} as const

/**
 * Registriert die Lese-API für Spaces und Seiten (Plan Task 6): `GET /api/spaces`
 * (aus der Space-Konfiguration, nicht der DB), `GET /api/spaces/:space/tree`
 * (verschachtelter Baum aus den Hierarchie-Kanten des Index), `GET /api/pages/:id`
 * (Index-Cache) und `GET /api/pages/:id/raw` (immer frisch vom Provider — der
 * Interop-Endpunkt liest nie aus dem Cache). Alle Routen lesen nur `ref='main'`.
 */
export function registerPagesRoutes(app: FastifyInstance, deps: PagesDeps): void {
  // Wie `registerWebhookRoutes`: als eigenes (asynchron bootendes) Sub-Plugin
  // registrieren, NICHT direkt auf `app`. Fastifys `onRoute`-Hook von
  // `@fastify/swagger` wird erst beim (asynchronen) Boot des Swagger-Plugins
  // angehängt — Routen, die synchron vorher direkt auf `app` registriert
  // werden, fehlen sonst in der generierten OpenAPI-Spec (siehe Kommentar zu
  // `/healthz`/`/readyz` oben in dieser Datei).
  app.register(async (instance) => {
    instance.get('/api/spaces', { schema: spaceListSchema }, async (req) => {
      let spaces = deps.spaces
      if (deps.access) {
        // Proben parallel (Plan Task 5) — je Space eine Provider-Probe (gecacht).
        const userId = req.user!.id
        const allowed = await Promise.all(deps.spaces.map((s) => deps.access!.canRead(userId, s)))
        spaces = deps.spaces.filter((_, i) => allowed[i])
      }
      return spaces.map((s) => ({ id: s.id, name: s.name, defaultLang: s.defaultLang }))
    })

    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/tree',
      { schema: treeSchema },
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
            id: pages.id,
            title: pages.title,
            path: pages.path,
            archived: pages.archived,
            orderKey: pages.orderKey,
          })
          .from(pages)
          .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main')))

        // Hierarchie-Kanten sind bereits vom Indexer aufgelöst (index-space.ts,
        // `replaceEdgesForPage`): jede Nicht-Wurzel-Seite hat genau eine ausgehende
        // `hierarchy`-Kante auf ihre Elternseite. Der Baum wird daraus rekonstruiert,
        // statt Pfade erneut zu parsen.
        const hierarchyRows = await deps.db
          .select({ from: edges.fromPageId, to: edges.toPageId })
          .from(edges)
          .innerJoin(pages, eq(edges.fromPageId, pages.id))
          .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main'), eq(edges.type, 'hierarchy')))

        const byId = new Map(rows.map((r) => [r.id, r]))
        const childrenOf = new Map<string, string[]>()
        const hasParent = new Set<string>()
        for (const e of hierarchyRows) {
          if (e.to === null) continue
          hasParent.add(e.from)
          const arr = childrenOf.get(e.to) ?? []
          arr.push(e.from)
          childrenOf.set(e.to, arr)
        }

        // Geschwister-Sortierung (Phase 3.3, „Baum-Umsortierung über `.order`-
        // Dateien"): primär nach `orderKey` (vom Indexer aus der `.order`-Datei
        // des Elternverzeichnisses berechnet, s. `indexer/order-file.ts`),
        // NULLS LAST — Kinder ohne `.order`-Eintrag (kein `.order` vorhanden
        // ODER dort nicht gelistet) landen dadurch NACH allen explizit
        // geordneten Geschwistern. Bei Gleichstand (beide `orderKey === null`,
        // ODER — kann laut `computeOrderKeys` nicht vorkommen — derselbe Wert)
        // entscheidet der Titel (`localeCompare`, unverändertes Bestandsverhalten).
        const bySibling = (a: string, b: string): number => {
          const orderA = byId.get(a)?.orderKey ?? null
          const orderB = byId.get(b)?.orderKey ?? null
          if (orderA !== null && orderB !== null) return orderA - orderB
          if (orderA !== null) return -1
          if (orderB !== null) return 1
          return (byId.get(a)?.title ?? '').localeCompare(byId.get(b)?.title ?? '')
        }

        const build = (id: string): TreeNode => {
          const row = byId.get(id)!
          const childIds = [...(childrenOf.get(id) ?? [])].sort(bySibling)
          const children = childIds.map(build)
          return {
            id: row.id,
            title: row.title,
            path: row.path,
            archived: row.archived,
            hasChildren: children.length > 0,
            children,
          }
        }

        const rootIds = rows.map((r) => r.id).filter((id) => !hasParent.has(id)).sort(bySibling)
        return rootIds.map(build)
      },
    )

    instance.get<{ Params: { id: string } }>('/api/pages/:id', { schema: pageSchema }, async (req, reply) => {
      const id = req.params.id
      const row = (
        await deps.db
          .select()
          .from(pages)
          .where(and(eq(pages.id, id), eq(pages.ref, 'main')))
          .limit(1)
      )[0]
      if (!row) {
        // Redirect-Lookup (Phase 3.1): evtl. eine überholte `path:`-Fallback-Id
        // (Bookmark von vor einem Backfill-Lauf) — s. `lookupRedirectTarget`.
        const canonicalId = await lookupRedirectTarget(deps, req, id)
        if (canonicalId) {
          return reply.code(200).send({ redirectTo: canonicalId })
        }
        return reply.code(404).send({ status: 'not_found', reason: `Seite "${id}" ist nicht bekannt.` })
      }

      const space = deps.spaces.find((s) => s.id === row.spaceId)

      // Kein Zugriff auf den Space der Seite → 404 wie „unbekannte Seite"
      // (kein Existenz-Orakel: ununterscheidbar von einer nicht vorhandenen Seite).
      if (deps.access) {
        if (!space || !(await deps.access.canRead(req.user!.id, space))) {
          return reply.code(404).send({ status: 'not_found', reason: `Seite "${id}" ist nicht bekannt.` })
        }
      }

      const tagRows = await deps.db.select({ tag: tags.tag }).from(tags).where(eq(tags.pageId, id))
      const brokenRows = await deps.db
        .select({ rawTarget: edges.rawTarget })
        .from(edges)
        .where(and(eq(edges.fromPageId, id), eq(edges.type, 'link'), isNull(edges.toPageId)))

      const frontmatter = row.frontmatter as PageFrontmatter
      const workflow = await resolveWorkflowField(deps, req, row)
      const schema = await loadSpaceSchema(deps, req, space)
      const metadata = resolveMetadata(row, schema, frontmatter.metadata ?? {})
      // Versionsanzeige (Seitenversionierung Etappe 1, Task 8): `versioning`
      // wird IMMER mitgeliefert (auch `false`) — der Freigabe-Dialog und die
      // Review-Ansicht nutzen dieselbe Seitendatenquelle und brauchen den
      // Schalter, um Versionsfelder ein-/auszublenden.
      const { versioning, version, implicitVersion, changedSinceRelease } = await resolveVersionFields(
        deps,
        row,
        schema,
      )
      const violation = classificationViolation(frontmatter.classification, schema)
      const classFields = classificationFields(frontmatter.classification, schema)
      const [latest] = await deps.db
        .select({ version: pageReleases.version })
        .from(pageReleases)
        .where(eq(pageReleases.pageId, id))
        .orderBy(desc(pageReleases.major), desc(pageReleases.minor), desc(pageReleases.patch))
        .limit(1)

      // Token classification limit (#39): the page exists for this user, only
      // the token is too narrow — say so instead of a 404.
      if (exceedsTokenLimit(req, classFields.classification ?? null)) {
        return {
          id: row.id,
          space: row.spaceId,
          path: row.path,
          title: row.title,
          html: '',
          headings: [],
          tags: [],
          relations: {},
          frontmatterErrors: [],
          errorStatus: null,
          archived: row.archived,
          updatedAt: row.updatedAt.toISOString(),
          brokenLinks: [],
          workflow: null,
          metadata: {},
          versioning,
          changedSinceRelease: false,
          ...classFields,
          restricted: true,
        }
      }

      return {
        id: row.id,
        space: row.spaceId,
        path: row.path,
        title: row.title,
        html: row.htmlRendered,
        headings: row.headings,
        tags: tagRows.map((t) => t.tag).sort(),
        relations: frontmatter.relations ?? {},
        frontmatterErrors: violation
          ? [...(row.frontmatterErrors as string[]), classificationViolationMessage(violation)]
          : row.frontmatterErrors,
        errorStatus: row.errorStatus,
        archived: row.archived,
        updatedAt: row.updatedAt.toISOString(),
        brokenLinks: brokenRows.map((b) => b.rawTarget),
        workflow,
        metadata,
        versioning,
        ...(version ? { version } : {}),
        ...(implicitVersion ? { implicitVersion } : {}),
        changedSinceRelease,
        ...classFields,
        ...(latest ? { latestRelease: latest.version } : {}),
      }
    })

    instance.get<{ Params: { id: string }; Querystring: { download?: string } }>(
      '/api/pages/:id/raw',
      { schema: rawSchema },
      async (req, reply) => {
        const id = req.params.id
        const row = (
          await deps.db
            .select()
            .from(pages)
            .where(and(eq(pages.id, id), eq(pages.ref, 'main')))
            .limit(1)
        )[0]
        if (!row) {
          return reply.code(404).send({ status: 'not_found', reason: `Seite "${id}" ist nicht bekannt.` })
        }

        const space = deps.spaces.find((s) => s.id === row.spaceId)
        // Kein Zugriff → 404 wie „unbekannte Seite" (kein Existenz-Orakel).
        // Vor der 502-Prüfung, damit fehlender Zugriff nie einen konfigurierten
        // Space durch einen abweichenden Statuscode verrät.
        if (deps.access && (!space || !(await deps.access.canRead(req.user!.id, space)))) {
          return reply.code(404).send({ status: 'not_found', reason: `Seite "${id}" ist nicht bekannt.` })
        }
        if (!space) {
          return reply
            .code(502)
            .send({ status: 'error', reason: `Space "${row.spaceId}" der Seite ist nicht konfiguriert.` })
        }

        try {
          const provider = deps.providerRegistry(space)
          const file = await provider.readFile(space.repoRef, row.path, 'main')
          if (req.query.download === '1') {
            reply.header('Content-Disposition', `attachment; filename="${downloadFilename(row.path)}"`)
          }
          return reply.type('text/markdown; charset=utf-8').send(file.content)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return reply
            .code(502)
            .send({ status: 'error', reason: `Provider-Fehler beim Lesen von "${row.path}": ${message}` })
        }
      },
    )
  })
}
