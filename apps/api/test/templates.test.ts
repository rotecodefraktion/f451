import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import { readTemplateBody, type TemplatesDeps } from '../src/templates/registry.js'
import type { GlobalTemplatesConfig } from '../src/spaces/config.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

describe.sequential('Templates-API (Phase 3c Task 2 + Task 4)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let globalRepo: RepoRef
  let space: SpaceConfig
  let globalTemplates: GlobalTemplatesConfig
  let app: ReturnType<typeof buildApp>
  let appNoGlobal: ReturnType<typeof buildApp>
  let depsFromApp: TemplatesDeps

  // Auth-Setup (Phase 3c Task 4, Muster `create-page.test.ts`): Task 2 lief
  // ohne Auth (`app.inject` ohne Cookies, `deps.access`/`canWrite` blieben
  // `undefined` — 1c-Verhalten). `POST .../templates` braucht eine echte
  // Nutzer-Autorschaft (Nutzer-Token committet auf main), daher jetzt mit
  // vollem Auth-Wiring: writer (Collaborator `write`) legt Templates an,
  // reader (Collaborator `read`) beweist die 403-Schreibrechte-Probe.
  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'tpl-writer'
  const readerUserId = 'tpl-reader'
  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('templates-space', { private: false })
    globalRepo = await forgejo.createRepo('templates-global')

    // Space-Repo: eine normale Seite + zwei Templates (mit und ohne Frontmatter).
    await provider.writeFile(
      repo,
      'index.md',
      '---\ntitle: Startseite\n---\n\n# Start\n',
      { branch: 'main', message: 'seed index' },
    )
    await provider.writeFile(
      repo,
      '_templates/meeting-notiz.md',
      '---\ntitle: Meeting-Notiz\ndescription: Gerüst für Besprechungsnotizen\n---\n\n# {{titel}}\n\nDatum: {{datum}} · Autor: {{autor}}\n',
      { branch: 'main', message: 'seed template 1' },
    )
    await provider.writeFile(
      repo,
      '_templates/ohne-frontmatter.md',
      '# Nur Gerüst\n',
      { branch: 'main', message: 'seed template 2' },
    )

    // Globales Repo: ein Template.
    await provider.writeFile(
      globalRepo,
      '_templates/adr.md',
      '---\ntitle: ADR\ndescription: Architekturentscheidung\n---\n\n# {{titel}}\n',
      { branch: 'main', message: 'seed global template' },
    )

    space = {
      id: 'betrieb',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    await indexSpace({ db, provider }, space)

    globalTemplates = { provider: 'forgejo', owner: globalRepo.owner, repo: globalRepo.repo, repoRef: globalRepo }

    writer = await forgejo.createUser('tpl-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('tpl-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'tpl-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'tpl-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    const authOptions = {
      tokenKey: TOKEN_KEY,
      insecureCookies: true,
      connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
    }

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      globalTemplates,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: authOptions,
    })
    await app.ready()

    appNoGlobal = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: authOptions,
    })
    await appNoGlobal.ready()

    depsFromApp = {
      providerRegistry: () => provider,
      globalTemplates,
    }

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  afterAll(async () => {
    await app?.close()
    await appNoGlobal?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  describe('GET /api/spaces/:space/templates', () => {
    it('listet Space- und Global-Templates mit Name/Beschreibung, space zuerst', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([
        { id: 'space:meeting-notiz', name: 'Meeting-Notiz', description: 'Gerüst für Besprechungsnotizen', source: 'space' },
        { id: 'space:ohne-frontmatter', name: 'ohne-frontmatter', description: '', source: 'space' },
        { id: 'global:adr', name: 'ADR', description: 'Architekturentscheidung', source: 'global' },
      ])
    })

    it('ohne globales Repo konfiguriert: nur Space-Quelle', async () => {
      const res = await appNoGlobal.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ source: string }>
      expect(body.length).toBeGreaterThan(0)
      expect(body.every((t) => t.source === 'space')).toBe(true)
    })

    it('Template-Dateien erscheinen NICHT im Seitenbaum', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/tree',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.stringify(res.json())).not.toContain('meeting-notiz')
    })

    it('unbekannter Space → 404 (kein Existenz-Orakel)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/spaces/gibt-es-nicht/templates',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(404)
    })

    it('ohne Session → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/templates' })
      expect(res.statusCode).toBe(401)
    })
  })

  // Phase 3c Task 4 ("Als Template speichern"): committet den aktuellen
  // Editor-Inhalt DIREKT auf main als `_templates/<slug>.md`, mit dem
  // NUTZER-Token (geerbtes Rechte-Modell — Forgejo erzwingt das Push-Recht,
  // ein 403 vom Provider wird 1:1 als 403 gemeldet). Erster Direkt-Write auf
  // main im Projekt (alle übrigen Schreibpfade laufen über Draft-Branch +
  // Review/Release) — eine bewusste, im Plan dokumentierte Entscheidung.
  describe('POST /api/spaces/:space/templates', () => {
    it('Writer legt Template auf main an; es erscheint sofort in der Liste', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
        payload: {
          name: 'Runbook-Gerüst',
          description: 'Störungs-Ablauf',
          content: '---\ntitle: Alt\n---\n\n# {{titel}}\n\nSchritte …\n',
        },
      })
      expect(res.statusCode).toBe(201)
      // Slug gegen die ECHTE `pathSegmentFromTitle`/`slugify`-Formel bestimmt
      // (nicht geraten): `slugify` behält Unicode-Buchstaben wie "ü" 1:1
      // (siehe `packages/markdown/src/slug.ts`) — kein "ue"-Transliterat.
      expect(res.json()).toEqual({ file: 'runbook-gerüst', path: '_templates/runbook-gerüst.md' })

      // Datei liegt auf main: Frontmatter = Name/Beschreibung, Body OHNE das
      // alte Seiten-Frontmatter ("title: Alt").
      const file = await provider.readFile(repo, '_templates/runbook-gerüst.md', 'main')
      expect(file.content).toBe(
        '---\ntitle: Runbook-Gerüst\ndescription: Störungs-Ablauf\n---\n\n# {{titel}}\n\nSchritte …\n',
      )

      const list = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
      })
      expect((list.json() as Array<{ id: string }>).some((t) => t.id === 'space:runbook-gerüst')).toBe(true)
    })

    it('existierendes Template → 409', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
        payload: { name: 'Meeting-Notiz', content: '# Egal\n' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: 'Unter "_templates/meeting-notiz.md" existiert bereits ein Template.',
        file: 'meeting-notiz',
      })
    })

    it('Leser ohne Schreibrecht → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(readerSession),
        payload: { name: 'Leser-Versuch', content: '# X\n' },
      })
      expect(res.statusCode).toBe(403)
      const body = res.json()
      expect(body.error).toBeTruthy()
      expect(body.action).toBeUndefined()
    })

    it('leerer Name bzw. Slug-loser Name ("!!!") → 400', async () => {
      const empty = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
        payload: { name: '', content: '# X\n' },
      })
      expect(empty.statusCode).toBe(400)
      expect(empty.json().status).toBe('bad_request')
      expect(empty.json().reason).toBeTruthy()

      const noSlug = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
        payload: { name: '!!!', content: '# X\n' },
      })
      expect(noSlug.statusCode).toBe(400)
      expect(noSlug.json().status).toBe('bad_request')
      expect(noSlug.json().reason).toBeTruthy()
    })

    it('fehlender content → 400 im {status,reason}-Format (kein 500)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
        payload: { name: 'Ohne Inhalt' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ status: 'bad_request' })
      expect(res.json().reason).toBeTruthy()
    })

    it('ohne Session → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        payload: { name: 'X', content: '# X\n' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('unbekannter Space → 404 (kein Existenz-Orakel)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spaces/gibt-es-nicht/templates',
        cookies: cookiesOf(writerSession),
        payload: { name: 'X', content: '# X\n' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('appNoGlobal (keine globalTemplates-Konfiguration) legt Space-Templates unverändert an', async () => {
      const res = await appNoGlobal.inject({
        method: 'POST',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
        payload: { name: 'Zweites Template', content: '# Zweitinhalt\n' },
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ file: 'zweites-template', path: '_templates/zweites-template.md' })
    })
  })

  describe('readTemplateBody', () => {
    it('liefert Name/Beschreibung/Body ohne Frontmatter-Block', async () => {
      const t = await readTemplateBody(depsFromApp, space, 'space:meeting-notiz')
      expect(t?.name).toBe('Meeting-Notiz')
      expect(t?.description).toBe('Gerüst für Besprechungsnotizen')
      expect(t?.body.startsWith('# {{titel}}')).toBe(true)
      expect(t?.body).not.toContain('---')
    })

    it('ohne description im Frontmatter: description === "" (nicht undefined)', async () => {
      const t = await readTemplateBody(depsFromApp, space, 'space:ohne-frontmatter')
      expect(t?.description).toBe('')
    })

    it('unbekannte id / falsche Quelle / Pfad-Tricks → null', async () => {
      expect(await readTemplateBody(depsFromApp, space, 'space:gibt-es-nicht')).toBeNull()
      expect(await readTemplateBody(depsFromApp, space, 'unsinn:x')).toBeNull()
      expect(await readTemplateBody(depsFromApp, space, 'space:../index')).toBeNull()
    })

    it('global:-Präfix ohne konfiguriertes globales Repo → null', async () => {
      const depsNoGlobal: TemplatesDeps = { providerRegistry: () => provider }
      expect(await readTemplateBody(depsNoGlobal, space, 'global:adr')).toBeNull()
    })
  })

  // Vorlagen-Pflege (Werkzeuge-Bereich „Vorlagen"): PATCH bearbeitet Name/
  // Beschreibung/Inhalt einer SPACE-Vorlage (Namensänderung → Umbenennen über
  // `renameTemplate`, sonst in place über `writeTemplateBody`); DELETE löscht
  // eine SPACE-Vorlage. Beide teilen die Gate-Kette von POST
  // (`resolveNewPageWriteContext`) und lehnen `global:`-Ids ab (schreib-
  // geschützt). Eigene Seed-Templates je Block, um die exakten Listen-
  // Assertions der obigen Blöcke (Reihenfolge/Inhalt) nicht zu stören —
  // `describe.sequential` garantiert, dass diese Blöcke NACH den obigen laufen.
  describe('PATCH /api/spaces/:space/templates/:id', () => {
    beforeAll(async () => {
      await provider.writeFile(
        repo,
        '_templates/patch-inplace.md',
        '---\ntitle: Patch Inplace\ndescription: Alte Beschreibung\n---\n\n# Alt\n',
        { branch: 'main', message: 'seed patch-inplace' },
      )
      await provider.writeFile(
        repo,
        '_templates/patch-rename-source.md',
        '---\ntitle: Patch Rename Source\n---\n\n# Quelle\n',
        { branch: 'main', message: 'seed patch-rename-source' },
      )
      await provider.writeFile(
        repo,
        '_templates/patch-rename-target.md',
        '---\ntitle: Patch Rename Target\n---\n\n# Ziel\n',
        { branch: 'main', message: 'seed patch-rename-target' },
      )
    })

    it('Beschreibung/Inhalt ändern OHNE Namensänderung: in place überschrieben, id bleibt gleich', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:patch-inplace',
        cookies: cookiesOf(writerSession),
        payload: { description: 'Neue Beschreibung', content: '# Neu\n' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        id: 'space:patch-inplace',
        name: 'Patch Inplace',
        description: 'Neue Beschreibung',
        path: '_templates/patch-inplace.md',
      })

      const file = await provider.readFile(repo, '_templates/patch-inplace.md', 'main')
      expect(file.content).toBe('---\ntitle: Patch Inplace\ndescription: Neue Beschreibung\n---\n\n# Neu\n')
    })

    it('Name geändert (anderer Slug): Datei umbenannt, neue id zurückgegeben, alte Datei weg, Body unverändert', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:patch-rename-source',
        cookies: cookiesOf(writerSession),
        payload: { name: 'Patch Renamed' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        id: 'space:patch-renamed',
        name: 'Patch Renamed',
        description: '',
        path: '_templates/patch-renamed.md',
      })

      const newFile = await provider.readFile(repo, '_templates/patch-renamed.md', 'main')
      expect(newFile.content).toBe('---\ntitle: Patch Renamed\n---\n\n# Quelle\n')

      await expect(provider.readFile(repo, '_templates/patch-rename-source.md', 'main')).rejects.toThrow()
    })

    it('Umbenennen kollidiert mit vorhandener Vorlage → 409, Ziel unverändert', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:patch-rename-target',
        cookies: cookiesOf(writerSession),
        payload: { name: 'Meeting-Notiz' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: 'Unter "_templates/meeting-notiz.md" existiert bereits ein Template.',
        file: 'meeting-notiz',
      })

      const file = await provider.readFile(repo, '_templates/patch-rename-target.md', 'main')
      expect(file.content).toContain('title: Patch Rename Target')
    })

    it('globale Vorlage → 403 (schreibgeschützt)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/global:adr',
        cookies: cookiesOf(writerSession),
        payload: { description: 'Versuch' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toBeTruthy()
    })

    it('unbekannte Vorlage → 404', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:gibt-es-nicht',
        cookies: cookiesOf(writerSession),
        payload: { description: 'X' },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json().status).toBe('not_found')
    })

    it('Pfad-Traversal-Versuch in der Id → 404 (kein Existenz-Orakel)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/spaces/betrieb/templates/${encodeURIComponent('space:../index')}`,
        cookies: cookiesOf(writerSession),
        payload: { description: 'X' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('Leser ohne Schreibrecht → 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:patch-inplace',
        cookies: cookiesOf(readerSession),
        payload: { description: 'Leser-Versuch' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('leerer Name → 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:patch-inplace',
        cookies: cookiesOf(writerSession),
        payload: { name: '' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().status).toBe('bad_request')
    })

    it('ohne Session → 401', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/spaces/betrieb/templates/space:patch-inplace',
        payload: { description: 'X' },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('DELETE /api/spaces/:space/templates/:id', () => {
    beforeAll(async () => {
      await provider.writeFile(
        repo,
        '_templates/delete-target.md',
        '---\ntitle: Delete Target\n---\n\n# Weg\n',
        { branch: 'main', message: 'seed delete-target' },
      )
      await provider.writeFile(
        repo,
        '_templates/delete-target-2.md',
        '---\ntitle: Delete Target 2\n---\n\n# Weg\n',
        { branch: 'main', message: 'seed delete-target-2' },
      )
    })

    it('Writer löscht Space-Vorlage; sie verschwindet aus der Liste und dem Repo', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/spaces/betrieb/templates/space:delete-target',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(204)

      await expect(provider.readFile(repo, '_templates/delete-target.md', 'main')).rejects.toThrow()

      const list = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates',
        cookies: cookiesOf(writerSession),
      })
      expect((list.json() as Array<{ id: string }>).some((t) => t.id === 'space:delete-target')).toBe(false)
    })

    it('globale Vorlage → 403 (schreibgeschützt)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/spaces/betrieb/templates/global:adr',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(403)
    })

    it('unbekannte Vorlage → 404', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/spaces/betrieb/templates/space:gibt-es-nicht',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(404)
    })

    it('Leser ohne Schreibrecht → 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/spaces/betrieb/templates/space:delete-target-2',
        cookies: cookiesOf(readerSession),
      })
      expect(res.statusCode).toBe(403)
      // unverändert — Leser konnte NICHT löschen.
      await expect(provider.readFile(repo, '_templates/delete-target-2.md', 'main')).resolves.toBeTruthy()
    })

    it('ohne Session → 401', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/spaces/betrieb/templates/space:delete-target-2' })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('GET /api/spaces/:space/templates/:id', () => {
    it('liefert Name/Beschreibung/Body/Quelle für eine Space-Vorlage', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates/space:meeting-notiz',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        id: 'space:meeting-notiz',
        name: 'Meeting-Notiz',
        description: 'Gerüst für Besprechungsnotizen',
        body: '# {{titel}}\n\nDatum: {{datum}} · Autor: {{autor}}\n',
        source: 'space',
      })
    })

    it('liefert auch globale Vorlagen (nur lesend, kein Schreibrecht nötig)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates/global:adr',
        cookies: cookiesOf(readerSession),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: 'global:adr', source: 'global' })
    })

    it('unbekannte/ungültige Id → 404', async () => {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/spaces/betrieb/templates/space:gibt-es-nicht',
        cookies: cookiesOf(writerSession),
      })
      expect(missing.statusCode).toBe(404)

      const traversal = await app.inject({
        method: 'GET',
        url: `/api/spaces/betrieb/templates/${encodeURIComponent('space:../index')}`,
        cookies: cookiesOf(writerSession),
      })
      expect(traversal.statusCode).toBe(404)
    })
  })
})
