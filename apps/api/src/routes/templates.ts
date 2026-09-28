import type { FastifyInstance, FastifyReply } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError, ProviderError } from '@f451/git-provider'
import { parsePage, splitFrontmatter } from '@f451/markdown'
import type { SpaceAccess } from '../auth/permissions.js'
import { pathSegmentFromTitle } from '../drafts/create-page.js'
import {
  buildTemplateFileContent,
  deleteTemplate,
  listTemplates,
  parseTemplateId,
  readTemplateBody,
  renameTemplate,
  templatePath,
  writeTemplateBody,
} from '../templates/registry.js'
import type { GlobalTemplatesConfig, SpaceConfig } from '../spaces/config.js'
import { resolveNewPageWriteContext, type NewPageGateDeps } from './drafts.js'

export interface TemplatesRouteDeps {
  spaces: readonly SpaceConfig[]
  providerRegistry: (space: SpaceConfig) => GitProvider
  /** 404-statt-403 wie überall (Muster `broken-links.ts`); ungesetzt (kein
   *  Auth) ⇒ offen (1c-Verhalten). */
  access?: SpaceAccess
  /** Optionales globales Templates-Repo (`F451_GLOBAL_TEMPLATES`) — ohne es
   *  liefert die Route nur Space-Templates. */
  globalTemplates?: GlobalTemplatesConfig
  /** Schreibrechte-Probe für `POST .../templates` (Phase 3c Task 4) — dieselbe
   *  Signatur wie `DraftsDeps.canWrite`. NUR gesetzt, wenn Auth aktiv ist
   *  (Muster Drafts-Routen, `app.ts`); ohne sie (und ohne `getUserProvider`)
   *  bleibt `POST .../templates` unregistriert, `GET .../templates` bleibt
   *  unverändert (Task-2-Bestand, offen bei fehlendem Auth). */
  canWrite?: NewPageGateDeps['canWrite']
  /** Nutzer-Provider-Factory für `POST .../templates` (Phase 3c Task 4): der
   *  Commit nach `_templates/` auf `main` läuft MIT NUTZERRECHTEN (echte
   *  Autorschaft, geerbtes Rechte-Modell — Forgejo/GitHub erzwingen das
   *  Push-Recht), NICHT über die Service-Account-`providerRegistry` oben
   *  (die bleibt dem Lesepfad — GET, `readTemplateBody` — vorbehalten). */
  getUserProvider?: NewPageGateDeps['getUserProvider']
}

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

const paramsSchema = {
  type: 'object',
  properties: { space: { type: 'string' } },
  required: ['space'],
} as const

const templatesSchema = {
  tags: ['templates'],
  params: paramsSchema,
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          source: { type: 'string', enum: ['space', 'global'] },
        },
        required: ['id', 'name', 'description', 'source'],
      },
    },
    404: errorSchema,
  },
} as const

// Bewusst OHNE `required`/Typ-Constraints auf den Body-Feldern (Phase-3b-
// Lehre, Muster `create-page.ts#createPageBodySchema`s `templateId`): ein
// striktes AJV-Schema würde einen fehlenden/falsch typisierten `content`
// (bzw. `name`) mit Fastifys generischer Validierungsfehler-Form ablehnen,
// BEVOR der Handler läuft — nicht mit dem projektweiten `{status,reason}`-
// 400-Vertrag. Die Validierung passiert daher komplett im Handler.
const postTemplateBodySchema = {
  type: 'object',
  properties: {
    name: {},
    description: {},
    content: {},
  },
} as const

const postTemplateResultSchema = {
  type: 'object',
  properties: { file: { type: 'string' }, path: { type: 'string' } },
  required: ['file', 'path'],
} as const

const templateCollisionSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, file: { type: 'string' } },
  required: ['error', 'file'],
} as const

const postTemplateSchema = {
  tags: ['templates'],
  params: paramsSchema,
  body: postTemplateBodySchema,
  response: {
    201: postTemplateResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: templateCollisionSchema,
    502: errorSchema,
  },
} as const

const templateIdParamsSchema = {
  type: 'object',
  properties: { space: { type: 'string' }, id: { type: 'string' } },
  required: ['space', 'id'],
} as const

const templateDetailSchema = {
  tags: ['templates'],
  params: templateIdParamsSchema,
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        source: { type: 'string', enum: ['space', 'global'] },
      },
      required: ['id', 'name', 'description', 'body', 'source'],
    },
    404: errorSchema,
    502: errorSchema,
  },
} as const

// Wie `postTemplateBodySchema`: bewusst ohne `required`/Typ-Constraints — bei
// PATCH ist zusätzlich JEDES Feld optional (nicht mitgeschickt = unverändert,
// echte PATCH-Semantik statt PUT-Vollersatz), die Validierung (inkl. „falscher
// Typ") passiert komplett im Handler mit dem projektweiten `{status,reason}`-
// 400-Vertrag.
const patchTemplateBodySchema = {
  type: 'object',
  properties: {
    name: {},
    description: {},
    content: {},
  },
} as const

const patchTemplateResultSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    path: { type: 'string' },
  },
  required: ['id', 'name', 'description', 'path'],
} as const

const patchTemplateSchema = {
  tags: ['templates'],
  params: templateIdParamsSchema,
  body: patchTemplateBodySchema,
  response: {
    200: patchTemplateResultSchema,
    400: errorSchema,
    403: forbiddenSchema,
    404: errorSchema,
    409: templateCollisionSchema,
    502: errorSchema,
  },
} as const

const deleteTemplateSchema = {
  tags: ['templates'],
  params: templateIdParamsSchema,
  response: {
    204: { type: 'null' },
    403: forbiddenSchema,
    404: errorSchema,
    502: errorSchema,
  },
} as const

/** Mappt einen unerwarteten Provider-Fehler auf 502 (Muster `routes/drafts.ts`/
 *  `routes/workflow.ts`: „Provider nicht erreichbar → 502 mit Meldung, nie
 *  stiller Verlust", kein 500-Pfad, Lehre aus Task 3). */
function providerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider-Fehler: ${message}` })
}

/**
 * Registriert `GET /api/spaces/:space/templates` (Phase 3c Task 2, Spec §6):
 * listet die im Space-Repo (`_templates/*.md`) und — falls konfiguriert — im
 * globalen Templates-Repo (`F451_GLOBAL_TEMPLATES`) hinterlegten Vorlagen.
 * Selbe 404-statt-403-Antwort wie `broken-links.ts`/`graph.ts` (kein
 * Existenz-Orakel für unbekannte oder nicht lesbare Spaces).
 *
 * Registriert außerdem `POST /api/spaces/:space/templates` (Phase 3c Task 4,
 * „Als Template speichern") — NUR wenn `canWrite`/`getUserProvider` gesetzt
 * sind (Auth aktiv, Muster Drafts-Routen in `app.ts`): committet den
 * aktuellen Editor-Inhalt als `_templates/<slug>.md` DIREKT auf `main` des
 * Space-Repos, mit dem NUTZER-Token (echte Autorschaft, geerbtes
 * Rechte-Modell — Forgejo/GitHub erzwingen das Push-Recht, ein Provider-403
 * beim Schreiben wird 1:1 als 403 gemeldet). Erster Direkt-Write auf `main`
 * im Projekt (alle übrigen Schreibpfade laufen über Draft-Branch + Review/
 * Release) — eine bewusste, im Plan dokumentierte Entscheidung: Vorlagen sind
 * kein Redaktionsinhalt, ein Review-Umweg für „ein Gerüst als Vorlage
 * merken" wäre unverhältnismäßig; das Push-Recht bleibt trotzdem exakt die
 * Provider-Rechte des Nutzers (kein privilegierter Bot-Bypass).
 *
 * Registriert außerdem `PATCH`/`DELETE /api/spaces/:space/templates/:id`
 * (Vorlagen-Pflege, Werkzeuge-Bereich) — dieselbe Gate-Kette wie `POST`
 * (`resolveNewPageWriteContext`, nur bei aktivem Auth registriert), derselbe
 * Direkt-Commit auf `main` mit dem NUTZER-Token. NUR Space-Vorlagen sind
 * bearbeitbar/löschbar — eine `global:`-Id liefert 403 (globale Vorlagen sind
 * absichtlich schreibgeschützt, s. `parseTemplateId`/`readTemplateBody`-
 * Kommentar). `PATCH` versteht echte PATCH-Semantik (jedes Body-Feld
 * optional — nicht mitgeschickt bleibt unverändert) und benennt bei
 * Namensänderung (anderer Slug) die Datei um (`renameTemplate`: neue Datei
 * anlegen + alte löschen, zwei Commits), sonst wird in place überschrieben
 * (`writeTemplateBody`, mit `sha` des bekannten Standes).
 */
export function registerTemplatesRoutes(app: FastifyInstance, deps: TemplatesRouteDeps): void {
  // Sub-Plugin wie alle Routen-Module (OpenAPI-Sichtbarkeit, s. pages.ts).
  app.register(async (instance) => {
    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/templates',
      { schema: templatesSchema },
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

        return listTemplates(
          { providerRegistry: deps.providerRegistry, globalTemplates: deps.globalTemplates },
          space,
          req.log,
        )
      },
    )

    // `GET .../templates/:id` — Einzel-Vorlage MIT Inhalt (Vorlagen-Pflege-
    // Bearbeiten-UI: `GET .../templates` liefert bewusst nur die schlanke
    // Zusammenfassung ohne Body). Rein lesend, IMMER registriert (wie die
    // Liste oben) — unabhängig von Auth/Schreibrecht, dieselbe 404-statt-403-
    // Antwort für unbekannten/unlesbaren Space UND unbekannte/ungültige
    // Vorlagen-Id (kein Existenz-Orakel).
    instance.get<{ Params: { space: string; id: string } }>(
      '/api/spaces/:space/templates/:id',
      { schema: templateDetailSchema },
      async (req, reply) => {
        const spaceId = req.params.space
        const space = deps.spaces.find((s) => s.id === spaceId)
        if (!space) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` })
        }
        if (deps.access && !(await deps.access.canRead(req.user!.id, space))) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Space "${spaceId}" ist nicht konfiguriert.` })
        }

        const parsed = parseTemplateId(req.params.id)
        if (!parsed) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Vorlage "${req.params.id}" nicht gefunden.` })
        }

        let t: Awaited<ReturnType<typeof readTemplateBody>>
        try {
          t = await readTemplateBody(
            { providerRegistry: deps.providerRegistry, globalTemplates: deps.globalTemplates },
            space,
            req.params.id,
          )
        } catch (err) {
          return providerErrorReply(reply, err)
        }
        if (!t) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Vorlage "${req.params.id}" nicht gefunden.` })
        }

        return reply.send({
          id: req.params.id,
          name: t.name,
          description: t.description,
          body: t.body,
          source: parsed.source,
        })
      },
    )

    if (!deps.access || !deps.canWrite || !deps.getUserProvider) return
    const gateDeps: NewPageGateDeps = {
      spaces: deps.spaces,
      access: deps.access,
      canWrite: deps.canWrite,
      getUserProvider: deps.getUserProvider,
    }

    instance.post<{
      Params: { space: string }
      Body: { name?: unknown; description?: unknown; content?: unknown }
    }>('/api/spaces/:space/templates', { schema: postTemplateSchema }, async (req, reply) => {
      const ctx = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

      const { name, description, content } = req.body
      if (typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ status: 'bad_request', reason: 'name darf nicht leer sein.' })
      }
      if (description !== undefined && typeof description !== 'string') {
        return reply.code(400).send({ status: 'bad_request', reason: 'description muss ein String sein.' })
      }
      if (typeof content !== 'string') {
        return reply
          .code(400)
          .send({ status: 'bad_request', reason: 'content ist erforderlich und muss ein String sein.' })
      }

      const file = pathSegmentFromTitle(name)
      if (file === null) {
        return reply.code(400).send({
          status: 'bad_request',
          reason:
            `Name "${name}" ergibt keinen gültigen Dateinamen — bitte einen Namen mit mindestens einem `
            + 'Buchstaben oder einer Ziffer wählen (nicht ausschließlich Satzzeichen/Bindestriche).',
        })
      }
      const path = templatePath(file)

      // Kollisionsprüfung: existiert die Datei bereits auf main, wird sie NIE
      // überschrieben (kein `sha` beim späteren `writeFile` — reine Anlage).
      try {
        await ctx.provider.readFile(ctx.space.repoRef, path, 'main')
        return reply
          .code(409)
          .send({ error: `Unter "${path}" existiert bereits ein Template.`, file })
      } catch (err) {
        if (!(err instanceof NotFoundError)) return providerErrorReply(reply, err)
        // NotFoundError → Pfad ist frei, weiter mit der Anlage.
      }

      const fileContent = buildTemplateFileContent({ name, description, body: content })

      try {
        await ctx.provider.writeFile(ctx.space.repoRef, path, fileContent, {
          branch: 'main',
          message: `template: ${name} angelegt`,
        })
      } catch (err) {
        if (err instanceof ProviderError && err.status === 403) {
          // Geerbtes Rechte-Modell (Spec Global Constraints): Forgejo/GitHub
          // erzwingen das Push-Recht auf main — ein Provider-403 HIER ist die
          // Antwort "kein Schreibrecht", 1:1 wie beim Merge im Release-Flow
          // (`routes/workflow.ts`, `isTolerableApproveError`-Nachbarcode).
          return reply.code(403).send({ error: 'Kein Recht, Templates in diesem Space anzulegen.' })
        }
        return providerErrorReply(reply, err)
      }

      return reply.code(201).send({ file, path })
    })

    instance.patch<{
      Params: { space: string; id: string }
      Body: { name?: unknown; description?: unknown; content?: unknown }
    }>('/api/spaces/:space/templates/:id', { schema: patchTemplateSchema }, async (req, reply) => {
      const ctx = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

      const parsed = parseTemplateId(req.params.id)
      if (!parsed) {
        return reply
          .code(404)
          .send({ status: 'not_found', reason: `Vorlage "${req.params.id}" nicht gefunden.` })
      }
      if (parsed.source === 'global') {
        return reply
          .code(403)
          .send({ error: 'Globale Vorlagen sind schreibgeschützt und können nicht bearbeitet werden.' })
      }
      const oldIdPart = parsed.idPart

      const { name, description, content } = req.body
      if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        return reply.code(400).send({ status: 'bad_request', reason: 'name darf nicht leer sein.' })
      }
      if (description !== undefined && typeof description !== 'string') {
        return reply.code(400).send({ status: 'bad_request', reason: 'description muss ein String sein.' })
      }
      if (content !== undefined && typeof content !== 'string') {
        return reply.code(400).send({ status: 'bad_request', reason: 'content muss ein String sein.' })
      }

      // Aktuellen Stand lesen: liefert den Blob-`sha` (konfliktsicheres
      // Update) UND die drei Felder für echte PATCH-Semantik — ein NICHT
      // mitgeschicktes Feld bleibt beim bisherigen Wert.
      let current: { sha: string; name: string; description: string; body: string }
      try {
        const file = await ctx.provider.readFile(ctx.space.repoRef, templatePath(oldIdPart), 'main')
        const { frontmatter } = parsePage(file.content)
        const { body } = splitFrontmatter(file.content)
        current = {
          sha: file.sha,
          name: frontmatter.title ?? oldIdPart,
          description: frontmatter.description ?? '',
          body: body.trimStart(),
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Vorlage "${req.params.id}" nicht gefunden.` })
        }
        return providerErrorReply(reply, err)
      }

      const newName = typeof name === 'string' ? name : current.name
      const newDescription = typeof description === 'string' ? description : current.description
      const newBody = typeof content === 'string' ? content : current.body

      const newIdPart = pathSegmentFromTitle(newName)
      if (newIdPart === null) {
        return reply.code(400).send({
          status: 'bad_request',
          reason:
            `Name "${newName}" ergibt keinen gültigen Dateinamen — bitte einen Namen mit mindestens einem `
            + 'Buchstaben oder einer Ziffer wählen (nicht ausschließlich Satzzeichen/Bindestriche).',
        })
      }

      // `buildTemplateFileContent` unterscheidet `undefined` (kein
      // description-Feld im Frontmatter) von einem gesetzten String (auch
      // `''`, s. dortiger Kommentar/POST-Verhalten) — eine leere
      // `newDescription` (weder mitgeschickt noch im bisherigen Stand
      // vorhanden, ODER bewusst auf leer gesetzt, „Beschreibung entfernen")
      // wird deshalb hier auf `undefined` normalisiert, sonst würde ein
      // reiner Inhalts-/Namens-Patch einer Vorlage OHNE Beschreibung
      // fälschlich ein leeres `description: ''` ins Frontmatter schreiben.
      const newContent = {
        name: newName,
        description: newDescription.length > 0 ? newDescription : undefined,
        body: newBody,
      }

      try {
        if (newIdPart === oldIdPart) {
          // Name (und damit Slug) unverändert → in place überschreiben.
          await writeTemplateBody(ctx.provider, ctx.space.repoRef, oldIdPart, newContent, {
            sha: current.sha,
            message: `template: ${newName} bearbeitet`,
          })
        } else {
          // Slug ändert sich → Umbenennen. Kollisionsprüfung wie bei POST:
          // existiert der Ziel-Pfad bereits, wird er NIE überschrieben.
          const newPath = templatePath(newIdPart)
          try {
            await ctx.provider.readFile(ctx.space.repoRef, newPath, 'main')
            return reply
              .code(409)
              .send({ error: `Unter "${newPath}" existiert bereits ein Template.`, file: newIdPart })
          } catch (err) {
            if (!(err instanceof NotFoundError)) return providerErrorReply(reply, err)
            // NotFoundError → Ziel-Pfad ist frei, weiter mit dem Umbenennen.
          }
          await renameTemplate(ctx.provider, ctx.space.repoRef, oldIdPart, newIdPart, newContent, {
            oldSha: current.sha,
            name: newName,
          })
        }
      } catch (err) {
        if (err instanceof ProviderError && err.status === 403) {
          return reply.code(403).send({ error: 'Kein Recht, Templates in diesem Space zu bearbeiten.' })
        }
        return providerErrorReply(reply, err)
      }

      return reply.code(200).send({
        id: `space:${newIdPart}`,
        name: newName,
        description: newDescription,
        path: templatePath(newIdPart),
      })
    })

    instance.delete<{ Params: { space: string; id: string } }>(
      '/api/spaces/:space/templates/:id',
      { schema: deleteTemplateSchema },
      async (req, reply) => {
        const ctx = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        const parsed = parseTemplateId(req.params.id)
        if (!parsed) {
          return reply
            .code(404)
            .send({ status: 'not_found', reason: `Vorlage "${req.params.id}" nicht gefunden.` })
        }
        if (parsed.source === 'global') {
          return reply
            .code(403)
            .send({ error: 'Globale Vorlagen sind schreibgeschützt und können nicht gelöscht werden.' })
        }

        let sha: string
        try {
          const file = await ctx.provider.readFile(ctx.space.repoRef, templatePath(parsed.idPart), 'main')
          sha = file.sha
        } catch (err) {
          if (err instanceof NotFoundError) {
            return reply
              .code(404)
              .send({ status: 'not_found', reason: `Vorlage "${req.params.id}" nicht gefunden.` })
          }
          return providerErrorReply(reply, err)
        }

        try {
          await deleteTemplate(ctx.provider, ctx.space.repoRef, parsed.idPart, {
            sha,
            message: `template: ${parsed.idPart} gelöscht`,
          })
        } catch (err) {
          if (err instanceof ProviderError && err.status === 403) {
            return reply.code(403).send({ error: 'Kein Recht, Templates in diesem Space zu löschen.' })
          }
          return providerErrorReply(reply, err)
        }

        return reply.code(204).send()
      },
    )
  })
}
