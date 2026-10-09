import { posix } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import {
  draftRequestClassification,
  exceedsTokenLimit,
  requestClassification,
  sendTokenLimit,
} from '../auth/classification-gate.js'
import type { SpaceAccess } from '../auth/permissions.js'
import type { SpaceConfig } from '../spaces/config.js'
import { draftBranchName } from '../drafts/branch-name.js'
import { findPageRowWithDraftFallback } from './drafts.js'

export interface MediaDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  /** Zugriffsprüfer (wie bei pages.ts): nur gesetzt, wenn Auth aktiv ist. Ohne
   *  Zugriff liefert die Route 404 statt 403 (kein Existenz-Orakel). */
  access?: SpaceAccess
  /** Schreibrechte-Probe (Task 1) — Gate für `?ref=draft`, konsistent zur
   *  Draft-Suche (`search.ts`): Draft-Medien sind Teil des Schreib-Workflows,
   *  daher Schreibrecht statt Leserecht. Nur für `ref=draft` genutzt; die
   *  main-Auslieferung bleibt unverändert bei `access.canRead`. Ohne sie
   *  (keine Auth-Wiring) fail-closed: `ref=draft` liefert immer 404, statt
   *  fälschlich offen zu sein. */
  canWrite?: (userId: string, space: SpaceConfig) => Promise<boolean>
}

/** Bild-Extensions (Spec Abschnitt 3: PNG, JPEG, SVG, WebP, GIF) — werden INLINE
 *  mit ihrem korrekten MIME-Type ausgeliefert (kein `Content-Disposition`). */
const INLINE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** MIME-Types je bekannter Extension — Bilder (inline, s. `INLINE_IMAGE_EXTENSIONS`)
 *  UND die erlaubten Nicht-Bild-Anhänge (Editor-Erweiterung „Datei-Anhänge":
 *  PDF/Office/ZIP/Text, s. `drafts/upload.ts#DOCUMENT_EXTENSION_WHITELIST`).
 *  Dokument-Typen bekommen trotz bekanntem MIME-Type IMMER `Content-Disposition:
 *  attachment` (Download, kein Inline-Rendering) — s. Auslieferungslogik unten.
 *  Alles außerhalb dieser Liste läuft als `application/octet-stream` + Download. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
}

/** Baut den `Content-Disposition`-Header für Downloads: ASCII-Fallback
 *  (`filename=`, Anführungszeichen/Backslashes/Nicht-ASCII durch `_` ersetzt)
 *  PLUS RFC-5987-kodierte Fassung (`filename*=UTF-8''…`) für den vollständigen
 *  Namen — Browser bevorzugen `filename*`, wenn vorhanden, und fallen sonst auf
 *  das gequotete `filename` zurück (älterer Browser/Downloader). Exportiert für
 *  gezielte Unit-Tests (media-guards.test.ts). */
export function buildContentDisposition(basename: string): string {
  const asciiFallback = basename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(basename)}`
}

/** Exportiert für gezielte Unit-Tests (media-guards.test.ts): `app.inject()` in
 *  vitest normalisiert Pfade bereits über den WHATWG-`URL`-Konstruktor (entfernt
 *  `..`-Segmente vor dem Routing) — ein HTTP-Ende-zu-Ende-Test würde diesen Pfad
 *  daher nie mit einem echten `..` im Wildcard erreichen. Ein Client, der den
 *  rohen Request-Target ohne Normalisierung sendet, tut das aber sehr wohl. */
export function extensionOf(wildcardPath: string): string {
  const base = wildcardPath.split('/').pop() ?? ''
  const dotIndex = base.lastIndexOf('.')
  return dotIndex === -1 ? '' : base.slice(dotIndex + 1).toLowerCase()
}

/** Traversal-Schutz: kein Segment leer, '.' oder '..'. Fastify/find-my-way
 *  dekodiert den Wildcard-Parameter bereits (z. B. %2e%2e → ..), sodass diese
 *  Prüfung auch encodete Traversal-Versuche abdeckt. */
export function isSafeWildcard(wildcardPath: string): boolean {
  if (wildcardPath.length === 0) return false
  return wildcardPath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const mediaSchema = {
  tags: ['media'],
  params: {
    type: 'object',
    properties: { pageId: { type: 'string' }, '*': { type: 'string' } },
    required: ['pageId', '*'],
  },
  querystring: {
    type: 'object',
    properties: {
      // Task 1 (Phase 2c-Vorarbeiten): 'draft' liest vom Draft-Branch statt
      // main — Gate ist Schreibrecht (siehe `MediaDeps.canWrite`). Default
      // bleibt 'main' — unverändertes main-only-Verhalten ohne den Parameter.
      ref: { type: 'string', enum: ['main', 'draft'] },
      // Release archive (#40): serve from `_releases/<version>/_media/` on main.
      release: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    },
  },
  response: {
    200: {
      description: 'Binärer Datei-Inhalt aus `<Seitenordner>/_media/<Pfad>` auf main (oder dem Draft-Branch bei `?ref=draft`).',
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    },
    404: errorSchema,
  },
} as const

/**
 * Registriert `GET /media/:pageId/*` (Zusatz-Task Phase 1e, erweitert um
 * `?ref=draft` in Task 1/Phase 2c): liefert Bilder aus
 * `<Seitenordner>/_media/<Wildcard>` aus — ohne den Parameter unverändert von
 * main (die Lücke, die der Indexer beim Umschreiben von Bild-Srcs auf
 * `/media/<pageId>/<datei>` hinterlassen hat, index-space.ts), mit
 * `?ref=draft` vom Draft-Branch (`draft/<pageId>`) — nötig, damit frisch
 * hochgeladene Draft-Bilder im Editor rendern, bevor der Draft gemerged ist.
 * Sicherheits-Header (nosniff, sandboxed CSP) sind IMMER gesetzt, auch für
 * inline angezeigte Typen, damit ein direkt aufgerufenes SVG kein
 * eingebettetes Skript ausführen kann.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaDeps): void {
  // Als eigenes Sub-Plugin registrieren (wie die übrigen Routen-Module) — der
  // onRoute-Hook von @fastify/swagger hängt erst nach dem asynchronen Boot des
  // Swagger-Plugins, siehe Kommentar in app.ts bei /healthz.
  app.register(async (instance) => {
    instance.get<{ Params: { pageId: string; '*': string }; Querystring: { ref?: 'main' | 'draft'; release?: string } }>(
      '/media/:pageId/*',
      { schema: mediaSchema },
      async (req, reply) => {
        const { pageId } = req.params
        const wildcard = req.params['*']
        const ref = req.query.ref === 'draft' ? 'draft' : 'main'

        const notFound = () =>
          reply.code(404).send({ status: 'not_found', reason: 'Medium ist nicht bekannt.' })

        if (!isSafeWildcard(wildcard)) return notFound()

        // Fix Review-Befund 2 (Phase 2d Task 5): main bevorzugt, sonst
        // Draft-only-Fallback (geteilter Helfer mit `resolveWriteContext`,
        // siehe dessen Kommentar in `routes/drafts.ts`) — sonst wäre eine
        // Draft-only-Seite hier IMMER "unbekannt", obwohl der Upload
        // (`POST /api/pages/:id/draft/media`) für sie funktioniert. Die
        // Branch-Wahl weiter unten (main vs. `draft/<pageId>`) UND das
        // Schreibrecht-Gate für `ref=draft` bleiben unverändert Sache von
        // `ref` — für `ref=main` auf einer Draft-only-Seite liefert der
        // anschließende `readFileBinary` auf dem main-Branch weiterhin 404
        // (die Datei existiert dort nicht), die Lese-API bleibt main-only.
        const row = await findPageRowWithDraftFallback(deps.db, pageId)
        if (!row) return notFound()

        const space = deps.spaces.find((s) => s.id === row.spaceId)
        if (!space) return notFound()

        // Zugriffs-Gate — main prüft Leserecht (unverändertes 1e-Verhalten,
        // offen ohne Auth-Wiring); `ref=draft` prüft stattdessen Schreibrecht
        // (konsistent zur Draft-Suche, `search.ts`) und ist OHNE Auth-Wiring
        // fail-closed: kein Nutzer, dessen Recht geprüft werden könnte, also
        // nie zugänglich. Beide Fälle liefern denselben 404 wie „unbekannte
        // Seite" (kein Existenz-Orakel).
        if (ref === 'draft') {
          if (!deps.access || !deps.canWrite || !(await deps.canWrite(req.user!.id, space))) return notFound()
        } else if (deps.access) {
          if (!(await deps.access.canRead(req.user!.id, space))) return notFound()
        }

        // Token classification limit (#39): attachments follow their page,
        // and a frozen copy's own class if it is stricter; draft media also
        // the draft's class if it is stricter (F-04).
        if (req.apiTokenMaxClassification) {
          const releaseParam = ref === 'main' ? req.query.release : undefined
          const cls =
            ref === 'draft'
              ? await draftRequestClassification(deps, pageId, req.log)
              : await requestClassification(deps, pageId, releaseParam, req.log)
          if (exceedsTokenLimit(req, cls)) return sendTokenLimit(reply)
        }

        const dir = posix.dirname(row.path)
        const base = dir === '.' ? '' : `${dir}/`
        const release = ref === 'main' ? req.query.release : undefined
        const mediaDir = release ? `${base}_releases/${release}/_media` : `${base}_media`
        const filePath = `${mediaDir}/${wildcard}`
        const branch = ref === 'draft' ? draftBranchName(pageId) : 'main'

        let file: { content: Buffer; sha: string }
        try {
          const provider = deps.providerRegistry(space)
          file = await provider.readFileBinary(space.repoRef, filePath, branch)
        } catch (err) {
          if (err instanceof NotFoundError) return notFound()
          throw err
        }

        // Sicherheits-Header IMMER, unabhängig vom Content-Type (Review-Vorgabe):
        // SVGs dürfen bei Direktaufruf kein eingebettetes Skript ausführen.
        reply.header('X-Content-Type-Options', 'nosniff')
        reply.header('Content-Security-Policy', "sandbox; default-src 'none'")

        if (ref === 'draft') {
          // Draft-Inhalte ändern sich bei jedem Diagramm-/Media-Speichern → nie
          // cachen (Phase 3e).
          reply.header('Cache-Control', 'no-store')
        } else {
          // main: content-adressierte Revalidierung statt fixem `max-age`
          // (Bugfix Leseansicht-Frische). Die gerenderte Bild-URL bleibt nach
          // einer Diagramm-Änderung identisch (`/media/<id>/<datei>`, ohne
          // Cache-Bust) — mit `max-age=300` zeigte der Browser bis zu 5 min die
          // ALTE SVG. `file.sha` ist der Git-Blob-SHA der Media-Datei, also ein
          // echter Content-Hash: er wird als starker `ETag` gesetzt und mit
          // `no-cache` (speichern erlaubt, aber JEDER Zugriff revalidiert)
          // kombiniert. So sieht der Leser eine geänderte Datei sofort, während
          // eine UNveränderte Datei per `304 Not Modified` ohne erneuten
          // Body-Transfer bedient wird (Bandbreiten-effizient). Ein
          // content-adressierter `?v=<hash>` an der URL wäre nicht möglich, weil
          // der Media-Hash beim Rendern (`buildResolveImage`) nicht vorliegt und
          // der Seiten-Commit sich bei einer reinen Media-Änderung gar nicht
          // ändert; hier am Auslieferungspunkt ist der Hash dagegen vorhanden.
          const etag = `"${file.sha}"`
          reply.header('ETag', etag)
          reply.header('Cache-Control', 'private, no-cache')
          if (req.headers['if-none-match'] === etag) {
            return reply.code(304).send()
          }
        }

        const ext = extensionOf(wildcard)
        const mime = MIME_BY_EXT[ext]
        if (mime && INLINE_IMAGE_EXTENSIONS.has(ext)) {
          reply.type(mime)
        } else {
          // Dokument-Anhänge (bekannter MIME-Type, aber kein Bild) UND wirklich
          // unbekannte Extensions landen beide als Download — ersteres mit
          // ihrem korrekten MIME-Type, letzteres mit `application/octet-stream`
          // (unverändertes Bestandsverhalten). BEIDE bekommen jetzt einen
          // `filename=`/`filename*=`-Content-Disposition (vorher fehlte er
          // ganz — ein Download landete im Browser ohne sinnvollen Dateinamen).
          reply.type(mime ?? 'application/octet-stream')
          const basename = wildcard.split('/').pop() ?? ''
          reply.header('Content-Disposition', buildContentDisposition(basename))
        }

        return reply.send(file.content)
      },
    )
  })
}
