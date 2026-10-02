import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
// Nur für die Fastify-Modul-Augmentation (req.file()/reply-Typen,
// fastify.multipartErrors) benötigt — die eigentliche Plugin-Registrierung
// passiert in app.ts.
import type {} from '@fastify/multipart'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { pages } from '../db/schema.js'
import type { SpaceAccess } from '../auth/permissions.js'
import type { SpaceConfig } from '../spaces/config.js'
import { createOrGetDraft, discardDraft, getDraft } from '../drafts/lifecycle.js'
import { DraftConflictError, saveDraft } from '../drafts/save.js'
import { classificationViolationInMarkdown, classificationViolationReply } from '../spaces/classification.js'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'
import {
  InvalidSvgError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  maxUploadBytes,
  uploadMedia,
} from '../drafts/upload.js'
import { DiagramExistsError, DiagramPathError, saveDiagram } from '../drafts/diagram.js'

export interface DraftsDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  /** Lesezugriff (wie bei pages.ts/media.ts): Space nicht konfiguriert oder für
   *  den Nutzer nicht lesbar → 404 (kein Existenz-Orakel). */
  access: SpaceAccess
  /** Schreibrechte-Probe (Task 1): Space sichtbar, aber Nutzer-Token darf das
   *  Repo nicht schreiben → 403. */
  canWrite(userId: string, space: SpaceConfig): Promise<boolean>
  /** Nutzer-Provider-Factory (Task 1): kein verknüpftes Provider-Konto → `null`
   *  → 403 mit „Konto verknüpfen"-Hinweis (Plan Global Constraints — bewusst
   *  KEIN 404, die Seite ist lesend sichtbar, Schreiben ist eine explizite,
   *  eigene Aktion). */
  getUserProvider(userId: string, space: SpaceConfig): Promise<GitProvider | null>
  /** Media-Upload-Größenlimit in MiB (Plan Task 5, `F451_MAX_UPLOAD_MB`,
   *  Default 10 — siehe `drafts/upload.ts#DEFAULT_MAX_UPLOAD_MB`). Gelesen aus
   *  `process.env` in `server.ts` (Konvention: `app.ts` selbst liest keine
   *  Env-Variablen, siehe `AppOptions`), hier optional für Bestände/Tests ohne
   *  explizite Angabe. */
  maxUploadMb?: number
}

export type PageRow = typeof pages.$inferSelect

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

const draftLockSchema = {
  type: 'object',
  properties: { user: { type: 'string' }, heartbeatAt: { type: 'string' }, mine: { type: 'boolean' } },
  required: ['user', 'heartbeatAt', 'mine'],
} as const

const draftInfoSchema = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    baseSha: { type: 'string' },
    content: { type: 'string' },
    lock: { anyOf: [draftLockSchema, { type: 'null' }] },
  },
  required: ['branch', 'baseSha', 'content', 'lock'],
} as const

const paramsSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const

const draftSchema = {
  tags: ['drafts'],
  params: paramsSchema,
  response: {
    200: draftInfoSchema,
    403: forbiddenSchema,
    404: errorSchema,
    502: errorSchema,
  },
} as const

const saveDraftBodySchema = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    baseSha: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['content', 'baseSha'],
} as const

const saveDraftResultSchema = {
  type: 'object',
  properties: {
    newSha: { type: 'string' },
    savedAt: { type: 'string' },
  },
  required: ['newSha', 'savedAt'],
} as const

const conflictSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    currentSha: { type: 'string' },
    currentContent: { type: 'string' },
  },
  required: ['error', 'currentSha', 'currentContent'],
} as const

const saveDraftSchema = {
  tags: ['drafts'],
  params: paramsSchema,
  body: saveDraftBodySchema,
  response: {
    200: saveDraftResultSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: conflictSchema,
    422: {
      type: 'object',
      properties: { error: { type: 'string' }, reason: { type: 'string' } },
      required: ['error'],
    },
    502: errorSchema,
  },
} as const

const deleteDraftSchema = {
  tags: ['drafts'],
  params: paramsSchema,
  response: {
    204: { type: 'null', description: 'Draft-Branch, Draft-Index und Lock wurden entfernt.' },
    403: forbiddenSchema,
    404: errorSchema,
    502: errorSchema,
  },
} as const

const uploadMediaResultSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    markdown: { type: 'string' },
    // 'image' (setImage im Editor) vs. 'file' (Datei-Link, s. drafts/upload.ts).
    kind: { type: 'string', enum: ['image', 'file'] },
  },
  required: ['path', 'markdown', 'kind'],
} as const

// KEIN `body`-Schema: `@fastify/multipart` befüllt `request.body` in diesem
// (Default-)Modus nicht (nur bei explizitem `attachFieldsToBody`) — ein
// striktes JSON-`body`-Schema würde Ajv gegen ein `undefined`-Body validieren
// lassen und JEDEN gültigen Multipart-Upload mit einem Validierungsfehler
// ablehnen, bevor der Handler überhaupt läuft. `consumes` reicht für die
// OpenAPI-Dokumentation.
const uploadMediaSchema = {
  tags: ['drafts'],
  params: paramsSchema,
  consumes: ['multipart/form-data'],
  response: {
    200: uploadMediaResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    413: errorSchema,
    415: errorSchema,
    422: errorSchema,
    502: errorSchema,
  },
} as const

const saveDiagramResultSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
} as const

// KEIN `body`-Schema (Präzedenzfall `uploadMediaSchema` oben bzw.
// `routes/graph.ts` für `depth`/`types`) — bewusst OHNE JEDEN AJV-Constraint,
// auch ohne `type: 'object'`/`required`/Property-Typen: JEDER
// AJV-Validierungsfehler (fehlendes `content`, `ifAbsent: "yes"`, `content`
// als Zahl, Body kein JSON-Objekt, …) würde Fastifys eigene Fehlerform
// (`{statusCode, error, message}`) senden, die nicht zum deklarierten
// `400`-`errorSchema` (`{status, reason}` required) passt — die
// Serialisierung der 400-Antwort scheitert dann selbst und Fastify fällt auf
// 500 zurück (FST_ERR_FAILED_ERROR_SERIALIZATION). Das trifft nicht nur
// format-/pattern-Constraints (Lehre Phase 3b), sondern genauso
// `type`-/`required`-Constraints. Ein Schema nur mit leeren
// Property-Deklarationen (`path: {}` …) wäre zwar AJV-neutral, provoziert
// aber AJVs strict-mode-Warnung („missing type object for keyword
// properties") bei jedem App-Start — daher gar kein Body-Schema; der Body
// (Form: `{ path: string, content: string, ifAbsent?: boolean }`) wird
// vollständig manuell im Handler validiert. Projektweit gibt es noch keinen
// Schema-Error-Formatter, der AJV-Fehler ins `{status, reason}`-Format
// umwandeln würde — bis es den gibt, bleibt die Route ohne Body-Schema.
const saveDiagramSchema = {
  tags: ['drafts'],
  summary: 'Diagramm (.drawio.svg/.excalidraw.svg) auf dem Draft-Branch anlegen/überschreiben',
  params: paramsSchema,
  response: {
    200: saveDiagramResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: errorSchema,
    413: errorSchema,
    415: errorSchema,
    422: errorSchema,
    502: errorSchema,
  },
} as const

function notFoundBody(pageId: string): { status: string; reason: string } {
  return { status: 'not_found', reason: `Seite "${pageId}" ist nicht bekannt.` }
}

/**
 * Sucht eine Seiten-Zeile über beide Refs (main bevorzugt, sonst draft-only)
 * (Fix Review-Befund 2, Phase 2d Task 5): Draft-only-Seiten (`POST /api/pages`,
 * `drafts/create-page.ts`) haben KEINE `ref='main'`-Zeile — nur die
 * Draft-Indexzeile (`ref='draft'`, von `indexDraftPage` beim Anlegen/jedem
 * Autosave geschrieben). Ohne diesen Fallback gilt so eine Seite als
 * "unbekannt", obwohl Editor (GET/PUT Draft), Locks, Media-Upload UND die
 * Media-Auslieferung (`routes/media.ts`, `?ref=draft`) sie genauso brauchen
 * wie eine bereits released Seite. Exportiert, damit `resolveWriteContext`
 * (hier) UND die Media-Route denselben Fallback nutzen statt ihn zu
 * duplizieren — die Branch-/Gate-Entscheidung (main vs. draft, Lese- vs.
 * Schreibrecht) bleibt jeweils Sache des Aufrufers, dieser Helfer liefert nur
 * die Zeile.
 */
export async function findPageRowWithDraftFallback(db: Db, pageId: string): Promise<PageRow | undefined> {
  let row = (
    await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.ref, 'main')))
      .limit(1)
  )[0]
  if (!row) {
    row = (
      await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, pageId), eq(pages.ref, 'draft')))
        .limit(1)
    )[0]
  }
  return row
}

export type ResolveOutcome =
  | { ok: true; row: PageRow; space: SpaceConfig; provider: GitProvider }
  | { ok: false; status: number; body: unknown }

/**
 * Gemeinsame Vorbedingungs-Kette für alle drei Draft-Routen (Plan Global
 * Constraints): Seite bekannt (main-Ref) → Space konfiguriert + lesbar (sonst
 * 404, kein Existenz-Orakel, wie bei `pages.ts`/`media.ts`) → Nutzer hat ein
 * verknüpftes Provider-Konto (sonst 403 mit Connect-Hinweis) → Nutzer-Token
 * darf das Repo schreiben (sonst 403). Drafts sind Teil des Schreib-
 * Workflows (Spec: nur für Schreibberechtigte auffindbar/nutzbar, siehe auch
 * Task 3 Draft-Suche) — daher gilt die Schreibrechte-Probe für POST, GET UND
 * DELETE gleichermaßen, nicht nur für die eigentliche Änderung.
 *
 * Exportiert, weil `routes/locks.ts` (Task 4) dieselbe Gate-Kette braucht
 * (requireSession global in app.ts + Space-Zugriff + Schreibrecht) — bewusst
 * wiederverwendet statt für die Lock-Routen dupliziert.
 */
export async function resolveWriteContext(deps: DraftsDeps, userId: string, pageId: string): Promise<ResolveOutcome> {
  const row = await findPageRowWithDraftFallback(deps.db, pageId)
  if (!row) return { ok: false, status: 404, body: notFoundBody(pageId) }

  const space = deps.spaces.find((s) => s.id === row.spaceId)
  if (!space || !(await deps.access.canRead(userId, space))) {
    return { ok: false, status: 404, body: notFoundBody(pageId) }
  }

  const gate = await resolveSpaceWriteGate(deps, userId, space)
  if (!gate.ok) return gate

  return { ok: true, row, space, provider: gate.provider }
}

type SpaceWriteGateOutcome =
  | { ok: true; provider: GitProvider }
  | { ok: false; status: number; body: unknown }

/**
 * Der Provider-/Schreibrecht-Teil der Gate-Kette (Konto verknüpft → 403
 * "connect", sonst Schreibrecht → 403), OHNE die Seiten-/Leserecht-Vorprüfung
 * davor — extrahiert (Phase 2d Task 5), damit `resolveWriteContext` (Seite
 * bereits über eine `pages`-Zeile bekannt) UND `resolveNewPageWriteContext`
 * (Seitenanlage: noch KEINE `pages`-Zeile, der Space selbst ist bereits
 * aufgelöst) exakt dieselbe Provider-/Schreibrecht-Prüfung teilen, statt sie
 * zu duplizieren.
 *
 * Exported for the theme write routes (`routes/theme.ts`): the instance repo is
 * not a configured space, so its pseudo space skips the read check and only
 * goes through this part of the chain.
 */
export async function resolveSpaceWriteGate(
  deps: NewPageGateDeps,
  userId: string,
  space: SpaceConfig,
): Promise<SpaceWriteGateOutcome> {
  const provider = await deps.getUserProvider(userId, space)
  if (!provider) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'Kein verknüpftes Provider-Konto. Bitte zuerst dein Konto verknüpfen, um Entwürfe zu bearbeiten.',
        action: 'connect',
      },
    }
  }

  if (!(await deps.canWrite(userId, space))) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Das verknüpfte Konto darf nicht in dieses Repository schreiben.' },
    }
  }

  return { ok: true, provider }
}

export type NewPageWriteOutcome =
  | { ok: true; space: SpaceConfig; provider: GitProvider }
  | { ok: false; status: number; body: unknown }

/** Schmalere Abhängigkeits-Form für `resolveNewPageWriteContext` (Phase 3c
 *  Task 4): die Funktion rührt weder `db` noch `maxUploadMb` an — ein `Pick`
 *  auf `DraftsDeps` statt der vollen Schnittstelle, damit Aufrufer OHNE
 *  Datenbank-Bezug (z. B. `routes/templates.ts#registerTemplatesRoutes`s
 *  POST-Handler, „Als Template speichern" committet direkt auf main, ohne die
 *  `pages`-Tabelle zu berühren) das Gate wiederverwenden können, ohne eine
 *  ungenutzte `db`-Instanz vortäuschen zu müssen. `DraftsDeps` erfüllt diesen
 *  Typ strukturell weiterhin, bestehende Aufrufer (`routes/create-page.ts`)
 *  bleiben unverändert. */
export type NewPageGateDeps = Pick<DraftsDeps, 'spaces' | 'access' | 'canWrite' | 'getUserProvider'>

/**
 * Gate-Kette für die Seitenanlage (`POST /api/pages`, Phase 2d Task 5):
 * anders als `resolveWriteContext` (Seite bereits bekannt) startet sie vom
 * `space`-Feld des Requests statt einer `pageId` — es gibt noch keine Seite,
 * die angelegt werden soll. Dieselben Gates wie bei den übrigen Schreib-
 * Routen: Space konfiguriert + lesbar (sonst 404, kein Existenz-Orakel für
 * nicht konfigurierte/unsichtbare Spaces) → verknüpftes Konto (sonst 403
 * "connect") → Schreibrecht (sonst 403) — über `resolveSpaceWriteGate`
 * geteilt, nicht dupliziert.
 *
 * Wiederverwendet von `routes/templates.ts` (Phase 3c Task 4, „Als Template
 * speichern"): identische Gate-Kette, nur der Ziel-Pfad unter dem Space
 * (`_templates/<slug>.md` statt einer Seite) unterscheidet sich.
 */
export async function resolveNewPageWriteContext(
  deps: NewPageGateDeps,
  userId: string,
  spaceId: string,
): Promise<NewPageWriteOutcome> {
  const space = deps.spaces.find((s) => s.id === spaceId)
  if (!space || !(await deps.access.canRead(userId, space))) {
    return {
      ok: false,
      status: 404,
      body: { status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` },
    }
  }

  const gate = await resolveSpaceWriteGate(deps, userId, space)
  if (!gate.ok) return gate

  return { ok: true, space, provider: gate.provider }
}

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Plan Global Constraints:
 *  „Provider nicht erreichbar → 502 mit Meldung, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

/**
 * Registriert die Draft-API: Lebenszyklus (Plan Task 2, `POST/GET/DELETE
 * /api/pages/:id/draft`) sowie Autosave (Plan Task 3, `PUT`, 409-Vertrag +
 * Draft-Indexierung). Wie die übrigen Routen-Module: eigenes (asynchron
 * bootendes) Sub-Plugin, damit die Routen in der von `@fastify/swagger`
 * generierten OpenAPI-Spec erscheinen (siehe Kommentar in `pages.ts`).
 */
export function registerDraftsRoutes(app: FastifyInstance, deps: DraftsDeps): void {
  app.register(async (instance) => {
    // POST: legt den Draft-Branch vom main-HEAD an, falls er nicht existiert —
    // idempotent, ein wiederholter Aufruf liefert 200 mit dem Bestand (Plan
    // Task 2 Interface).
    instance.post<{ Params: { id: string } }>(
      '/api/pages/:id/draft',
      { schema: draftSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          return await createOrGetDraft(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.row.id,
            ctx.row.path,
            req.user!.id,
          )
        } catch (err) {
          if (err instanceof NotFoundError) {
            // Seitendatei fehlt auf dem (ggf. gerade erst abgeleiteten) Branch —
            // z. B. zwischen Index-Lookup und Zugriff aus main gelöscht.
            // Final-Review-Befund 1: dieselbe 404-Semantik wie GET/PUT/DELETE,
            // kein 502 (kein Provider-Fehler, sondern "kein lesbarer Entwurf").
            return reply
              .code(404)
              .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
          }
          return providerErrorReply(reply, err)
        }
      },
    )

    // GET: liefert den aktuellen Draft-Stand oder 404, wenn (noch) kein Draft-
    // Branch existiert.
    instance.get<{ Params: { id: string } }>(
      '/api/pages/:id/draft',
      { schema: draftSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          const info = await getDraft(
            { db: deps.db },
            ctx.provider,
            ctx.space.repoRef,
            ctx.row.id,
            ctx.row.path,
            req.user!.id,
          )
          if (!info) {
            return reply
              .code(404)
              .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
          }
          return info
        } catch (err) {
          return providerErrorReply(reply, err)
        }
      },
    )

    // PUT: Autosave (Plan Task 3) — schreibt den Inhalt auf den Draft-Branch
    // (SHA-Vertrag, 409 bei Abweichung) und indexiert die Seite anschließend
    // inkrementell mit ref='draft' (Draft-Suche, Lese-API bleibt main-only).
    instance.put<{
      Params: { id: string }
      Body: { content: string; baseSha: string; message?: string }
    }>('/api/pages/:id/draft', { schema: saveDraftSchema }, async (req, reply) => {
      const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
      if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

      const schema = await loadMetadataSchema({ providerRegistry: () => ctx.provider }, ctx.space, 'main', req.log)
      const violation = classificationViolationInMarkdown(req.body.content, schema)
      if (violation) return reply.code(422).send(classificationViolationReply(violation))

      try {
        return await saveDraft(
          { db: deps.db },
          ctx.provider,
          ctx.space.repoRef,
          ctx.space,
          ctx.row.id,
          ctx.row.path,
          ctx.row.title,
          req.body.content,
          req.body.baseSha,
          req.body.message,
        )
      } catch (err) {
        if (err instanceof DraftConflictError) {
          return reply.code(409).send({
            error: err.message,
            currentSha: err.currentSha,
            currentContent: err.currentContent,
          })
        }
        if (err instanceof NotFoundError) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
        }
        return providerErrorReply(reply, err)
      }
    })

    // DELETE: verwirft den Draft vollständig — Branch, Draft-Index-Zeilen
    // (ref='draft') und Lock (Plan Task 2 Interface).
    instance.delete<{ Params: { id: string } }>(
      '/api/pages/:id/draft',
      { schema: deleteDraftSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        try {
          await discardDraft({ db: deps.db }, ctx.provider, ctx.space.repoRef, ctx.row.id)
          return reply.code(204).send()
        } catch (err) {
          if (err instanceof NotFoundError) {
            return reply
              .code(404)
              .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
          }
          return providerErrorReply(reply, err)
        }
      },
    )

    // POST /media: Media-Upload in den Draft (Plan Task 5) — Multipart-Feld
    // `file`. Durchläuft dieselbe Gate-Kette wie die übrigen Draft-Routen
    // (`resolveWriteContext`), committet dann mit dem Nutzer-Token nach
    // `<Seitenordner>/_media/<Name>` auf den Draft-Branch (siehe
    // `drafts/upload.ts`).
    instance.post<{ Params: { id: string } }>(
      '/api/pages/:id/draft/media',
      { schema: uploadMediaSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        const maxBytes = maxUploadBytes(deps.maxUploadMb)
        let part: Awaited<ReturnType<typeof req.file>>
        try {
          part = await req.file({ limits: { fileSize: maxBytes } })
        } catch (err) {
          // Fehler HIER (z. B. kein/ungültiger multipart/form-data-Content-
          // Type) sind ausschließlich Anfrage-Fehler des Clients — der
          // GitProvider wurde noch gar nicht berührt, daher NICHT
          // `providerErrorReply` (502 wäre irreführend: kein Provider-Problem).
          const message = err instanceof Error ? err.message : String(err)
          return reply.code(400).send({ status: 'bad_request', reason: `Multipart-Anfrage ungültig: ${message}` })
        }
        if (!part) {
          return reply.code(400).send({ status: 'bad_request', reason: 'Multipart-Feld "file" fehlt.' })
        }

        let buffer: Buffer
        try {
          buffer = await part.toBuffer()
        } catch (err) {
          // `toBuffer()` wirft `RequestFileTooLargeError` (siehe
          // `@fastify/multipart`-Doku), wenn der Stream das oben gesetzte
          // `limits.fileSize` überschreitet — echte Streaming-Grenze, kein
          // nachträglicher Buffer-Längen-Check (verhindert unbegrenzten
          // Speicherverbrauch bei sehr großen Uploads).
          if (err instanceof req.server.multipartErrors.RequestFileTooLargeError) {
            return reply.code(413).send({
              status: 'payload_too_large',
              reason: `Datei überschreitet das Größenlimit von ${maxBytes} Bytes.`,
            })
          }
          return reply.code(400).send({ status: 'bad_request', reason: 'Multipart-Upload konnte nicht gelesen werden.' })
        }

        try {
          const result = await uploadMedia(
            ctx.provider,
            ctx.space.repoRef,
            ctx.row.id,
            ctx.row.path,
            { filename: part.filename, buffer },
            maxBytes,
          )
          return result
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            return reply.code(413).send({ status: 'payload_too_large', reason: err.message })
          }
          if (err instanceof UnsupportedMediaTypeError) {
            return reply.code(415).send({ status: 'unsupported_media_type', reason: err.message })
          }
          if (err instanceof InvalidSvgError) {
            return reply.code(422).send({ status: 'invalid_svg', reason: err.message })
          }
          if (err instanceof NotFoundError) {
            // Kein bestehender Draft-Branch (Upload legt NIE selbst einen an,
            // analog zu `saveDraft` — kein stilles Anlegen) — dieselbe 404-
            // Semantik wie GET/PUT/DELETE.
            return reply
              .code(404)
              .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
          }
          return providerErrorReply(reply, err)
        }
      },
    )

    // PUT /diagram: Diagramm-Speicherung im Draft (Plan Phase 3e Task 2) —
    // anders als POST /media (immer Neuanlage mit Kollisions-Suffix) legt
    // diese Route unter einem vom Editor bereits gewählten Zielnamen an ODER
    // überschreibt in place (siehe `drafts/diagram.ts`). Durchläuft dieselbe
    // Gate-Kette wie die übrigen Draft-Routen (`resolveWriteContext`).
    const diagramMaxBytes = maxUploadBytes(deps.maxUploadMb)
    instance.put<{
      Params: { id: string }
      Body: unknown
    }>('/api/pages/:id/draft/diagram', {
      schema: saveDiagramSchema,
      // Fastifys Default-bodyLimit (1 MiB) würde SONST vor der
      // Anwendungslogik greifen und größere Bodies mit seiner eigenen
      // Fehlerform ablehnen (413-Body ohne `{status, reason}` → kollidiert
      // mit dem deklarierten `errorSchema` → 500
      // FST_ERR_FAILED_ERROR_SERIALIZATION statt 413). Faktor 2 als Reserve
      // für das JSON-Escaping des SVG-Inhalts (Quotes/Backslashes/Unicode
      // blähen den Transport-Body gegenüber dem Inhalt auf) — die inhaltliche
      // 413-Grenze zieht weiterhin `saveDiagram` gegen `diagramMaxBytes`.
      bodyLimit: diagramMaxBytes * 2,
    }, async (req, reply) => {
      const ctx = await resolveWriteContext(deps, req.user!.id, req.params.id)
      if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

      // Manuelle Body-Validierung (siehe Kommentar am `saveDiagramSchema`,
      // warum es KEIN Body-Schema gibt: AJV-Constraints würden hier 500er
      // statt 400er produzieren).
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      if (typeof body.path !== 'string') {
        return reply.code(400).send({ status: 'bad_request', reason: '"path" fehlt oder ist kein String.' })
      }
      if (typeof body.content !== 'string') {
        return reply.code(400).send({ status: 'bad_request', reason: '"content" fehlt oder ist kein String.' })
      }
      // `ifAbsent` ist optional, MUSS aber, wenn angegeben, ein Boolean sein:
      // ein fehlgeformter Wert ("yes", 1, …) darf NICHT still als "nicht
      // gesetzt" gewertet werden — das würde eine gewollte
      // Kollisionsprüfung (Anlegen-nur-wenn-abwesend) lautlos in ein
      // Überschreiben verwandeln (4a-Final-Triage-Fund). Also: 400 statt
      // Silent-Overwrite.
      if (body.ifAbsent !== undefined && typeof body.ifAbsent !== 'boolean') {
        return reply.code(400).send({ status: 'bad_request', reason: '"ifAbsent" muss, falls angegeben, ein boolescher Wert sein.' })
      }
      const input = { path: body.path, content: body.content, ifAbsent: body.ifAbsent === true }

      try {
        const result = await saveDiagram(
          ctx.provider,
          ctx.space.repoRef,
          ctx.row.id,
          ctx.row.path,
          input,
          diagramMaxBytes,
        )
        return result
      } catch (err) {
        if (err instanceof DiagramPathError) {
          return reply.code(400).send({ status: 'bad_request', reason: err.message })
        }
        if (err instanceof DiagramExistsError) {
          return reply.code(409).send({ status: 'conflict', reason: err.message })
        }
        if (err instanceof PayloadTooLargeError) {
          return reply.code(413).send({ status: 'payload_too_large', reason: err.message })
        }
        if (err instanceof UnsupportedMediaTypeError) {
          return reply.code(415).send({ status: 'unsupported_media_type', reason: err.message })
        }
        if (err instanceof InvalidSvgError) {
          return reply.code(422).send({ status: 'invalid_svg', reason: err.message })
        }
        if (err instanceof NotFoundError) {
          // Kein bestehender Draft-Branch (wie beim Media-Upload: NIE
          // stillschweigend anlegen) — dieselbe 404-Semantik wie GET/PUT/DELETE.
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Kein Entwurf für Seite "${ctx.row.id}" vorhanden.` })
        }
        return providerErrorReply(reply, err)
      }
    })
  })
}
