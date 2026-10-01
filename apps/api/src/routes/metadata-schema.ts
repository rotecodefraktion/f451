import type { FastifyInstance, FastifyReply } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError, ProviderError } from '@f451/git-provider'
import { parseMetadataSchemaFromValue, stringifyMetadataSchema } from '@f451/markdown'
import type { SpaceAccess } from '../auth/permissions.js'
import { resolveNewPageWriteContext, type NewPageGateDeps } from './drafts.js'
import { clearMetadataSchemaCache, loadMetadataSchema, METADATA_SCHEMA_PATH } from '../spaces/metadata-schema.js'
import type { SpaceConfig } from '../spaces/config.js'

export interface MetadataSchemaRouteDeps {
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  /** Zugriffsprüfer — wie bei den übrigen Space-Lese-Routen (`templates.ts`,
   *  `broken-links.ts`): gesetzt ⇒ 404-statt-403 (kein Existenz-Orakel),
   *  ungesetzt (kein Auth) ⇒ offen (1c-Verhalten). */
  access?: SpaceAccess
  /** Schreibrechte-Probe für `PUT .../metadata-schema` (Metadaten-Feature M4)
   *  — dieselbe Signatur wie `TemplatesRouteDeps.canWrite`. NUR gesetzt, wenn
   *  Auth aktiv ist (Muster `templates.ts`/`app.ts`); ohne sie (und ohne
   *  `getUserProvider`) bleibt `PUT .../metadata-schema` unregistriert, `GET
   *  .../metadata-schema` bleibt unverändert. */
  canWrite?: NewPageGateDeps['canWrite']
  /** Nutzer-Provider-Factory für `PUT .../metadata-schema` (Muster
   *  `templates.ts`): der Commit nach `_meta/schema.yaml` auf `main` läuft MIT
   *  NUTZERRECHTEN (echte Autorschaft, geerbtes Rechte-Modell), NICHT über die
   *  Service-Account-`providerRegistry` oben (die bleibt dem Lesepfad — GET —
   *  vorbehalten). */
  getUserProvider?: NewPageGateDeps['getUserProvider']
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const paramsSchema = {
  type: 'object',
  properties: { space: { type: 'string' } },
  required: ['space'],
} as const

// Bewusst ein offenes Schema für die Feld-Objekte (`{}` statt einer strikten
// AJV-Beschreibung der diskriminierten `MetadataField`-Union): die Form
// unterscheidet sich je `type` (z. B. `pattern`/`options`/`source` sind nur
// bei bestimmten Typen vorhanden) — dasselbe Muster wie `treeSchema`s
// rekursives `children` in `pages.ts` und `postTemplateBodySchema` in
// `templates.ts`. fast-json-stringify würde bei einem geschlossenen Schema
// sonst genau die Felder abschneiden, die nicht explizit gelistet sind.
const metadataSchemaResponseSchema = {
  tags: ['spaces'],
  params: paramsSchema,
  response: {
    200: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: {} },
        // `versioning` explizit listen — sonst filtert Fastifys Response-
        // Serialisierung (fast-json-stringify, dasselbe "nur gelistete Felder
        // überleben"-Verhalten wie beim PUT-Body-Schema oben) das Feld aus
        // JEDER Antwort heraus, OBWOHL `loadMetadataSchema`/
        // `parseMetadataSchemaFromValue` es intern immer setzen (Default
        // `false`, s. `packages/markdown/src/schema.ts`). Ohne diesen Eintrag
        // bekommt der Schema-Editor den Schalter nie zu Gesicht und sendet ihn
        // beim Speichern folglich nicht zurück — derselbe stille
        // Datenverlust-Pfad wie beim Body-Schema, nur eine Ebene höher (GET
        // statt PUT-Empfang).
        versioning: { type: 'boolean' },
        // Listed for the same reason as `versioning`: unlisted fields are
        // stripped from the response and the schema editor would drop them.
        classification: {
          type: 'object',
          properties: { default: { type: 'string' }, max: { type: 'string' } },
        },
      },
      // `required`, weil das geparste Schema (`MetadataSchema`) `versioning`
      // IMMER trägt — anders als `fields`s Nachbar-Feld gibt es hier keinen
      // Zustand, in dem der Loader/Parser den Schlüssel wegließe.
      required: ['fields', 'versioning'],
    },
    404: errorSchema,
  },
} as const

const forbiddenSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, action: { type: 'string' } },
  required: ['error'],
} as const

/** 400-Antwort MIT den granularen Feldfehlern aus `parseMetadataSchemaFromValue`
 *  (`@f451/markdown`) — zusätzlich zum projektweiten `{status,reason}`-Vertrag
 *  (`reason` bleibt eine knappe Zusammenfassung, `errors` trägt die
 *  Einzelbefunde, damit der Schema-Editor sie Feld für Feld anzeigen kann). */
const validationErrorSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    reason: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'reason', 'errors'],
} as const

// Bewusst OHNE `required`/Typ-Constraints auf `fields` UND `versioning`
// (Muster `templates.ts#postTemplateBodySchema`): ein striktes AJV-Schema
// würde ein fehlendes/falsch typisiertes Feld mit Fastifys generischer
// Validierungsfehler-Form ablehnen, BEVOR der Handler läuft — nicht mit dem
// projektweiten `{status,reason,errors}`-400-Vertrag, an dem die generische
// Antwort scheitert (das 400-Response-Schema unten verlangt `errors`), was
// die Serialisierung mit einem 500 abbrechen lässt. Die Validierung passiert
// daher komplett im Handler über `parseMetadataSchemaFromValue`, die für
// `versioning` genau wie für `fields` eine granulare Fehlermeldung liefert.
//
// WICHTIG: `versioning` hier NICHT wieder mit `type: 'boolean'` versehen —
// das war exakt der Regressionsfehler (Etappe 1, s.
// `test/metadata-schema.test.ts`: „versioning mit falschem Typ → 400 (NICHT
// 500)"). `versioning` MUSS trotzdem explizit als Property gelistet bleiben
// (nicht einfach weglassen) — sonst filtert Fastifys Request-Validierung
// (AJV, `removeAdditional`-Standardverhalten) das Feld still aus `req.body`
// heraus, BEVOR der Handler es überhaupt sieht (der Datenverlust-Pfad aus
// Befund 2). `{}` ist also bewusst die einzige korrekte Deklaration: gelistet
// (damit es durchgereicht wird), aber ohne Typ-Constraint (damit AJV es nicht
// vorab ablehnt).
const putMetadataSchemaBodySchema = {
  type: 'object',
  properties: { fields: {}, versioning: {}, classification: {} },
} as const

const putMetadataSchemaSchema = {
  tags: ['spaces'],
  params: paramsSchema,
  body: putMetadataSchemaBodySchema,
  response: {
    200: metadataSchemaResponseSchema.response[200],
    400: validationErrorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Muster `routes/templates.ts`:
 *  „Provider nicht erreichbar → 502 mit Meldung, nie stiller Verlust"). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

/**
 * Registriert `GET /api/spaces/:space/metadata-schema` (Metadaten-Feature M1,
 * Task 4): liefert das geparste `_meta/schema.yaml` des Space-Repos (Feld-
 * definitionen für strukturierte Seiten-Metadaten, z. B. SAP-Prozess-Doku).
 * Nur Lesezugriff — dieselbe 404-statt-403-Antwort wie `broken-links.ts`/
 * `templates.ts` (kein Existenz-Orakel für unbekannte oder nicht lesbare
 * Spaces). Liest IMMER `ref='main'` (das Schema ist ein Repo-weiter
 * Konfigurationsstand, kein Draft-Vorschau-Feature in M1). Fehlende/kaputte
 * Schema-Datei → leeres Schema (200 mit `fields: []`), NIE ein Fehlerstatus —
 * `loadMetadataSchema` ist fail-soft (siehe dortiger Kommentar).
 *
 * Registriert außerdem `PUT /api/spaces/:space/metadata-schema` (Metadaten-
 * Feature M4, Schema-Editor-UI) — NUR wenn `canWrite`/`getUserProvider`
 * gesetzt sind (Auth aktiv, Muster `templates.ts`s `POST .../templates`):
 * validiert den Body (`{fields: [...]}`) über `parseMetadataSchemaFromValue`
 * (dieselbe granulare Validierung wie der YAML-Loader, EIN Regelwerk statt
 * einer zweiten Kopie) und committet bei Erfolg `stringifyMetadataSchema(...)`
 * DIREKT auf `main` als `_meta/schema.yaml`, mit dem NUTZER-Token (wie beim
 * Template-Schreibpfad). Anders als der YAML-Loader (fail-soft: ungültige
 * Einzelfelder werden übersprungen, der Rest bleibt nutzbar) ist die
 * Schreib-Route STRENG: JEDER von `parseMetadataSchemaFromValue` gemeldete
 * Befund (auch ein bloß fehlendes `label`, das der Parser sonst nur mit
 * Rückfall auf `key` toleriert) blockiert den Schreibvorgang mit 400 — beim
 * bewussten Bearbeiten über die UI soll das gespeicherte Schema immer
 * vollständig sauber sein, während historisch von Hand gepflegte Dateien beim
 * bloßen LESEN weiterhin tolerant bleiben. Anders als bei Templates
 * (`POST .../templates`, reine Anlage, nie ein Überschreiben) DARF diese
 * Route eine bestehende Datei überschreiben — das ist ihr ganzer Zweck (Schema
 * bearbeiten) — daher liest sie zuerst deren `sha` (existiert sie), um Forgejo/
 * GitHub korrekt als Update statt als Kollision zu adressieren (s. `writeFile`-
 * Vertrag `packages/git-provider`). Nach erfolgreichem Schreiben wird der
 * GESAMTE Loader-Cache geleert (`clearMetadataSchemaCache`, kein gezielter
 * Einzel-Invalidierungspfad vorhanden) — ein GET direkt danach sieht immer den
 * neuen Stand, nie den alten aus der 5-Minuten-TTL.
 */
export function registerMetadataSchemaRoutes(app: FastifyInstance, deps: MetadataSchemaRouteDeps): void {
  // Sub-Plugin wie alle Routen-Module (OpenAPI-Sichtbarkeit, s. Kommentar in `pages.ts`).
  app.register(async (instance) => {
    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/metadata-schema',
      { schema: metadataSchemaResponseSchema },
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

        return loadMetadataSchema({ providerRegistry: deps.providerRegistry }, space, 'main', req.log)
      },
    )

    if (!deps.access || !deps.canWrite || !deps.getUserProvider) return
    const gateDeps: NewPageGateDeps = {
      spaces: deps.spaces,
      access: deps.access,
      canWrite: deps.canWrite,
      getUserProvider: deps.getUserProvider,
    }

    instance.put<{ Params: { space: string }; Body: { fields?: unknown; versioning?: unknown; classification?: unknown } }>(
      '/api/spaces/:space/metadata-schema',
      { schema: putMetadataSchemaSchema },
      async (req, reply) => {
        const ctx = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        if (!Array.isArray(req.body.fields)) {
          return reply.code(400).send({
            status: 'bad_request',
            reason: '"fields" muss eine Liste sein.',
            errors: ['fields: muss eine Liste sein'],
          })
        }

        // `versioning` MIT durchreichen (Befund 2, Datenverlust-Fix) — vorher
        // baute die Route hier nur `{ fields: ... }`, wodurch ein zuvor via
        // Schema-Editor gesetztes `versioning: true` bei jedem Speichern still
        // wieder auf `false` zurückfiel.
        const { schema, errors } = parseMetadataSchemaFromValue({
          fields: req.body.fields,
          versioning: req.body.versioning,
          ...(req.body.classification !== undefined ? { classification: req.body.classification } : {}),
        })
        if (errors.length > 0) {
          return reply.code(400).send({
            status: 'bad_request',
            reason: 'Das Metadaten-Schema ist ungültig — s. "errors" für Details.',
            errors,
          })
        }

        // Bestehende Datei? Ihr `sha` macht den nächsten `writeFile`-Aufruf zu
        // einem Update statt einer (kollidierenden) Neuanlage — Forgejo/GitHub
        // erwarten das `sha` bei einer Aktualisierung (s. `writeFile`-Vertrag).
        let sha: string | undefined
        try {
          const existing = await ctx.provider.readFile(ctx.space.repoRef, METADATA_SCHEMA_PATH, 'main')
          sha = existing.sha
        } catch (err) {
          if (!(err instanceof NotFoundError)) return providerErrorReply(reply, err)
          sha = undefined
        }

        try {
          await ctx.provider.writeFile(ctx.space.repoRef, METADATA_SCHEMA_PATH, stringifyMetadataSchema(schema), {
            branch: 'main',
            message: sha ? 'metadata-schema: aktualisiert' : 'metadata-schema: angelegt',
            sha,
          })
        } catch (err) {
          if (err instanceof ProviderError && err.status === 403) {
            // Geerbtes Rechte-Modell (wie `routes/templates.ts`): ein
            // Provider-403 HIER ist die Antwort "kein Schreibrecht".
            return reply.code(403).send({ error: 'Kein Recht, das Metadaten-Schema in diesem Space zu ändern.' })
          }
          return providerErrorReply(reply, err)
        }

        // Der Loader cached fail-soft-Ergebnisse 5 Minuten pro (Space, Ref) —
        // ohne Invalidierung würde ein GET direkt nach dem Speichern den alten
        // Stand zeigen. Globaler Clear (kein gezielter Einzel-Invalidierungs-
        // pfad vorhanden, s. `spaces/metadata-schema.ts`), unproblematisch bei
        // der Schreibfrequenz dieser Route (Konfigurationsänderung, kein
        // Hot-Path).
        clearMetadataSchemaCache()

        return reply.code(200).send(schema)
      },
    )
  })
}
