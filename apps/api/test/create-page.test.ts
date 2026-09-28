import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { parsePage } from '@f451/markdown'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 5).toString('base64')

/** Provider-Wrapper (Muster `read-api.test.ts#providerWithBrokenReadFile`,
 *  hier auf Template-Pfade beschränkt): delegiert alles an den echten
 *  Provider, außer `readFile` für `_templates/…`-Pfade — die werfen einen
 *  generischen Fehler (simuliert Timeout/5xx/Netz-Ausfall beim Provider).
 *  Damit bleibt der reguläre Seiten-Schreibpfad (Branch/Commit über den
 *  ECHTEN Nutzer-Provider, siehe `getUserProvider` in `app.ts` — unabhängig
 *  von der hier gebrochenen `providerRegistry`) unberührt und NUR
 *  `readTemplateBody` (`templates/registry.ts`) schlägt fehl (Fix-Runde 1,
 *  Phase 3c Task 3: dieser Aufruf lag bisher außerhalb jedes try/catch). */
function providerWithBrokenTemplateReadFile(inner: GitProvider): GitProvider {
  return {
    readFile: async (r, p, ref) => {
      if (p.startsWith('_templates/')) throw new Error('simulated provider outage (template read)')
      return inner.readFile(r, p, ref)
    },
    readFileBinary: (r, p, ref) => inner.readFileBinary(r, p, ref),
    listTree: (r, ref) => inner.listTree(r, ref),
    getHeadSha: (r, branch) => inner.getHeadSha(r, branch),
    writeFile: (r, p, content, opts) => inner.writeFile(r, p, content, opts),
    writeFileBinary: (r, p, content, opts) => inner.writeFileBinary(r, p, content, opts),
    createBranch: (r, name, fromBranch) => inner.createBranch(r, name, fromBranch),
    deleteBranch: (r, name) => inner.deleteBranch(r, name),
    listCommits: (r, opts) => inner.listCommits(r, opts),
    createPullRequest: (r, opts) => inner.createPullRequest(r, opts),
    getPullRequest: (r, number) => inner.getPullRequest(r, number),
    listPullRequests: (r, opts) => inner.listPullRequests(r, opts),
    requestReviewers: (r, number, reviewers) => inner.requestReviewers(r, number, reviewers),
    submitPullRequestReview: (r, number, opts) => inner.submitPullRequestReview(r, number, opts),
    mergePullRequest: (r, number) => inner.mergePullRequest(r, number),
  }
}

interface CreatePageResult {
  id: string
  space: string
  path: string
  branch: string
  baseSha: string
  content: string
}

/**
 * `POST /api/pages` (Phase 2d Task 5, seit Phase 3.1 mit generierter stabiler
 * Id statt Pfad-Fallback) — durchgehend über `buildApp`/`app.inject()` gegen
 * echten Forgejo- und PG-Container: Anlage als Draft-only-Seite (Gates,
 * Zielpfad-/Kollisionslogik, Draft-Indexierung) sowie der volle Zyklus Anlage →
 * Autosave → Review → Release, der die ID-STABILITÄT über den kompletten
 * Release-Zyklus beweist (Kernanforderung sowohl von Task 5 als auch von
 * Phase 3.1: der Indexer muss die Id aus GENAU dem `id:`-Frontmatter-Feld
 * lesen, das die Seitenanlage geschrieben hat, sonst wechselt die Seite nach
 * ihrem ersten Release die Identität).
 */
describe.sequential('POST /api/pages: neue Seite anlegen (Phase 2d Task 5)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let privateSpace: SpaceConfig
  let app: FastifyInstance

  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  let releaser: ForgejoTestUser
  const writerUserId = 'cp-writer'
  const readerUserId = 'cp-reader'
  const releaserUserId = 'cp-releaser'

  let writerSession: string
  let readerSession: string
  let releaserSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('create-page', { private: false })
    await provider.writeFile(repo, 'index.md', '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n', {
      branch: 'main',
      message: 'seed',
    })

    // Verschachtelte main-Seite für den Slug-Kollisionstest (Task 5 Interface:
    // Zielpfad ist IMMER `<slug>/index.md` — eine neue Seite kollidiert daher
    // nie mit der literalen Wurzel `index.md`, sondern mit einer bereits
    // vorhandenen `<slug>/index.md`-Seite).
    await provider.writeFile(
      repo,
      'kollisions-ziel/index.md',
      '---\nid: kollisions-ziel-main\ntitle: Kollisions Ziel\nlang: de\n---\n# Kollisions Ziel\n',
      { branch: 'main', message: 'seed' },
    )

    // Template für die Anlage-aus-Template-Tests (Task 3, Phase 3c) — Platzhalter
    // `{{titel}}`/`{{autor}}`/`{{datum}}`, dieselbe Registry-Konvention wie
    // `templates/registry.test.ts` (`_templates/<id>.md`, Frontmatter-`title`
    // als Anzeigename).
    await provider.writeFile(
      repo,
      '_templates/notiz.md',
      '---\ntitle: Notiz\n---\n\n# {{titel}}\n\nVon {{autor}} am {{datum}}\n',
      { branch: 'main', message: 'seed' },
    )

    const repoPrivate = await forgejo.createRepo('create-page-private', { private: true })
    await provider.writeFile(
      repoPrivate,
      'index.md',
      '---\nid: geheim\ntitle: Geheim\nlang: de\n---\n# Geheim\n',
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'create-page-space', name: 'Create Page', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    privateSpace = {
      id: 'create-page-private-space', name: 'Create Page Private', provider: 'forgejo',
      owner: repoPrivate.owner, repo: repoPrivate.repo, defaultLang: 'de', repoRef: repoPrivate,
    }
    await indexSpace({ db, provider }, space)
    await indexSpace({ db, provider }, privateSpace)

    writer = await forgejo.createUser('cp-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('cp-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')
    releaser = await forgejo.createUser('cp-releaser')
    await forgejo.addCollaborator(space.repoRef, releaser.username, 'write')

    await db.insert(users).values([
      { id: writerUserId, email: 'cp-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'cp-reader@example.org', displayName: 'Reader' },
      { id: releaserUserId, email: 'cp-releaser@example.org', displayName: 'Releaser' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)
    await upsertProviderAccount(
      db, releaserUserId, 'forgejo', releaser.username, { accessToken: releaser.token }, TOKEN_KEY,
    )

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space, privateSpace],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await app.ready()

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
    releaserSession = (await createSession(db, releaserUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  it('unbekannter Space → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: 'does-not-exist', title: 'Irrelevant' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Space in einem für den Nutzer unsichtbaren (privaten) Space → 404 (kein Existenz-Orakel)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: privateSpace.id, title: 'Geheimplan' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('verknüpftes Konto ohne Schreibrecht (Nur-Lese-Collaborator) → 403 ohne connect-Hinweis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(readerSession),
      payload: { space: space.id, title: 'Reader-Versuch' },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it('ohne Session → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages', payload: { space: space.id, title: 'x' } })
    expect(res.statusCode).toBe(401)
  })

  // Regressionstest (Task 4a-1, zentraler Error-Formatter): `title` ist im
  // `createPageBodySchema` als `required` deklariert — ohne den zentralen
  // Error-Handler kollidiert Fastifys AJV-Fehlerbody mit dem deklarierten
  // `400`-`errorSchema` ({status,reason} required) →
  // FST_ERR_FAILED_ERROR_SERIALIZATION → 500 statt 400 (dokumentierter
  // Live-Kandidat, Ledger 3b/3e).
  it('Body ohne title (AJV-Pflichtfeld fehlt) → 400 {status,reason}, nie 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
    expect(res.json().reason).toBeTruthy()
  })

  it(
    'Anlage-Happy-Path: Branch existiert, index.md-Inhalt exakt, 201-Form, Draft-Index-Zeile vorhanden, ' +
      'KEINE main-Zeile (Draft-only)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Neue Seite' },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as CreatePageResult

      expect(body.space).toBe(space.id)
      expect(body.path).toBe('neue-seite/index.md')
      expect(body.branch).toBe(draftBranchName(body.id))
      // Phase 3.1: die Id wird generiert (`generatePageId`, `p-<10 Zeichen base36>`),
      // NICHT mehr aus dem Pfad abgeleitet — Format statt konkretem Wert prüfen.
      expect(body.id).toMatch(/^p-[0-9a-z]{10}$/)

      const expectedContent = `---\nid: ${body.id}\ntitle: Neue Seite\n---\n\n# Neue Seite\n`
      expect(body.content).toBe(expectedContent)
      expect(body.baseSha).toMatch(/^[0-9a-f]{40}$/)

      const fileOnBranch = await provider.readFile(repo, body.path, body.branch)
      expect(fileOnBranch.content).toBe(expectedContent)

      const draftRows = await db.select().from(pages).where(and(eq(pages.id, body.id), eq(pages.ref, 'draft')))
      expect(draftRows).toHaveLength(1)
      expect(draftRows[0]?.title).toBe('Neue Seite')
      expect(draftRows[0]?.path).toBe(body.path)

      const mainRows = await db.select().from(pages).where(and(eq(pages.id, body.id), eq(pages.ref, 'main')))
      expect(mainRows).toHaveLength(0)
    },
  )

  it('Slug-Kollision gegen eine bestehende main-Seite → 409 mit deren pageId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Kollisions Ziel' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.pageId).toBe('kollisions-ziel-main')
  })

  it('Slug-Kollision gegen eine bereits als Draft-only angelegte Seite (anderer Nutzer) → 409 mit deren pageId', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Doppelter Entwurf' },
    })
    expect(first.statusCode).toBe(201)
    const firstId = (first.json() as CreatePageResult).id

    const second = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(releaserSession),
      payload: { space: space.id, title: 'Doppelter Entwurf' },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().pageId).toBe(firstId)
  })

  it('Anlage unter parent: Zielpfad liegt im Verzeichnis der Eltern-Seite (auch draft-only)', async () => {
    const parentRes = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Elternseite' },
    })
    expect(parentRes.statusCode).toBe(201)
    const parent = parentRes.json() as CreatePageResult
    expect(parent.path).toBe('elternseite/index.md')

    const childRes = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, parentId: parent.id, title: 'Kindseite' },
    })
    expect(childRes.statusCode).toBe(201)
    const child = childRes.json() as CreatePageResult
    expect(child.path).toBe('elternseite/kindseite/index.md')
    expect(child.id).toMatch(/^p-[0-9a-z]{10}$/)
    expect(child.id).not.toBe(parent.id)
  })

  it('unbekannte parentId → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, parentId: 'does-not-exist', title: 'Verwaist' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Titel ohne verwertbare Zeichen (leerer Slug) → 400, kein Branch angelegt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: '!!!' },
    })
    expect(res.statusCode).toBe(400)
  })

  // Anlage aus Template (Phase 3c Task 3, Spec §6): der Template-Body ersetzt
  // den Auto-`# <Titel>`-Anhang, das Standard-Frontmatter (`title:`) bleibt.
  describe('Anlage aus Template (Phase 3c Task 3)', () => {
    it('legt Seite aus Template an: Body gefüllt, Standard-Frontmatter, kein Auto-H1-Anhang', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Team-Sync', templateId: 'space:notiz' },
      })
      expect(res.statusCode).toBe(201)
      const { content } = res.json() as CreatePageResult
      expect(content).toContain('title: Team-Sync')
      expect(content).toContain('# Team-Sync')
      expect(content).toContain('Von Writer am') // displayName des Writers aus dem Test-Setup ('Writer')
      expect(content).toMatch(/am \d{2}\.\d{2}\.\d{4}/)
      expect(content).not.toContain('{{')
      expect(content).not.toContain('description:')
    })

    it('unbekannte templateId → 400 mit Begründung', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'X', templateId: 'space:gibt-es-nicht' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().reason).toContain('gibt-es-nicht')
    })

    it('templateId als Array (kein String) → 400 mit Begründung', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Y', templateId: ['space:notiz'] },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().reason).toBeTruthy()
    })

    it('ohne templateId bleibt der Content byte-identisch zum Bestand (bis auf die generierte Id)', async () => {
      // Verifiziert durch die bestehende Happy-Path-Assertion oben
      // ('Anlage-Happy-Path'), die weiterhin '---\nid: …\ntitle: …\n---\n\n# …\n'
      // erwartet und unverändert grün bleibt.
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Ohne Template' },
      })
      expect(res.statusCode).toBe(201)
      const { id, content } = res.json() as CreatePageResult
      expect(content).toBe(`---\nid: ${id}\ntitle: Ohne Template\n---\n\n# Ohne Template\n`)
    })
  })

  // Critical-Review-Befund (Phase 3c Task 3, Fix-Runde 1): `readTemplateBody`
  // wurde bisher AUSSERHALB jedes try/catch aufgerufen — `readTemplateBody`
  // fängt selbst nur `NotFoundError` (→ null, → 400 „unbekanntes Template“),
  // jeder andere Provider-Fehler (Timeout/5xx/Netz) lief bis zu Fastifys
  // Default-500 durch, statt des projektweiten `502 {status,reason}`-Vertrags
  // (`providerErrorReply`), den `createPageSchema.response[502]` sogar
  // deklariert. Eigene, zweite App mit gebrochener `providerRegistry`
  // (Muster `read-api.test.ts`), damit NUR der Template-Lesepfad ausfällt.
  describe('Fix Critical-Review-Befund (Phase 3c Task 3, Fix-Runde 1): Provider-Fehler beim Template-Lesen', () => {
    let brokenApp: FastifyInstance

    beforeAll(async () => {
      brokenApp = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space, privateSpace],
        providerRegistry: () => providerWithBrokenTemplateReadFile(provider),
        forgejoBaseUrl: forgejo.baseUrl,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
        },
      })
      await brokenApp.ready()
    })

    afterAll(async () => {
      await brokenApp?.close()
    })

    it('Provider-Fehler beim Template-Lesen (Timeout/5xx/Netz) → 502 im Fehlervertrag, kein generisches 500', async () => {
      const res = await brokenApp.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Bricht Beim Template', templateId: 'space:notiz' },
      })
      expect(res.statusCode).toBe(502)
      const body = res.json()
      expect(body.status).toBe('error')
      expect(body.reason).toContain('simulated provider outage (template read)')
    })
  })

  /** Gemeinsame Prüfung für die Regressionsfälle unten (Fix-Runde 1 UND
   *  Fix-Runde 2): 201, Initialinhalt UND die tatsächlich geschriebene Datei
   *  sind gegen den ECHTEN Parser (`parsePage`) fehlerfrei, der (unveränderte)
   *  Titel erscheint korrekt als `frontmatter.title` — sowohl in der Response
   *  als auch in der Draft-Indexzeile (von `indexDraftPage` selbst aus dem
   *  Inhalt geparst). */
  async function expectCleanPage(
    payload: { space: string; parentId?: string; title: string },
    expectedTitle: string,
  ): Promise<CreatePageResult> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as CreatePageResult

    const parsed = parsePage(body.content)
    expect(parsed.frontmatterErrors).toEqual([])
    expect(parsed.frontmatter.title).toBe(expectedTitle)

    const fileOnBranch = await provider.readFile(repo, body.path, body.branch)
    expect(parsePage(fileOnBranch.content).frontmatterErrors).toEqual([])

    const draftRows = await db.select().from(pages).where(and(eq(pages.id, body.id), eq(pages.ref, 'draft')))
    expect(draftRows[0]?.title).toBe(expectedTitle)
    expect(draftRows[0]?.frontmatterErrors).toEqual([])

    return body
  }

  // Fix Review-Befund 1 (Phase 2d Task 5, Fix-Runde 1): der Initialinhalt baute
  // die Frontmatter-Zeile per String-Interpolation (`title: ${title}`) — Titel
  // mit `:`, führendem `-`/`@`/`*` oder Quotes ergaben ungültiges YAML
  // (YAMLException beim erneuten Parsen, sichtbar als `frontmatterErrors`/
  // `errorStatus: 'parse_error'`). Jeder dieser Titel muss jetzt 201 liefern,
  // MIT einem gegen den echten Parser (`parsePage`) fehlerfreien Initialinhalt
  // und dem unveränderten Titel als `frontmatter.title`.
  describe('Fix Review-Befund 1: Titel wird YAML-sicher ins Frontmatter geschrieben', () => {
    const cases: Array<{ name: string; title: string }> = [
      { name: 'Doppelpunkt im Titel', title: 'Kapitel 1: Einführung' },
      { name: 'führendes @ (YAML-reserviert)', title: '@mention' },
      { name: 'eingebettete doppelte Quotes', title: 'Titel mit "doppelten Quotes"' },
    ]

    for (const { name, title } of cases) {
      it(`${name} ("${title}") → 201, parsePage-fehlerfrei, Titel korrekt im Frontmatter`, async () => {
        await expectCleanPage({ space: space.id, title }, title)
      })
    }

    it('Titel mit Zeilenumbruch → 201 (Schema erlaubt Newlines; werden zu Leerzeichen normalisiert, Heading bleibt einzeilig, parsePage-fehlerfrei)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Zeile eins\nZeile zwei' },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as CreatePageResult

      const parsed = parsePage(body.content)
      expect(parsed.frontmatterErrors).toEqual([])
      expect(parsed.frontmatter.title).toBe('Zeile eins Zeile zwei')
      expect(parsed.headings[0]?.text).toBe('Zeile eins Zeile zwei')
    })
  })

  // Fix-Runde 2 (Phase 2d Task 5, Controller-Folgebefund „Pfad-Slug aus Titeln
  // ist nicht git-pfadsicher"): `slugify` behält Bindestriche 1:1 — ein Titel,
  // der mit "- " beginnt, ergab bisher einen Slug mit FÜHRENDEM Bindestrich
  // ("- Strich zuerst" → "--strich-zuerst"), den Forgejo als alleinstehendes
  // ERSTES Pfadsegment ablehnt ("git command is broken"). In Fix-Runde 1 wurde
  // das nur UMGANGEN (Testfall unter einem `parentId` angelegt, siehe
  // Fix-Runde-1-Report). `pathSegmentFromTitle` (`drafts/create-page.ts`)
  // strippt jetzt führende/abschließende Bindestriche NACH dem Slugifying —
  // dieser Testfall läuft jetzt direkt, ohne Parent-Workaround.
  describe('Fix-Runde 2: Pfad-Slug git-sicher (führender Bindestrich, leerer Slug nach dem Stripping)', () => {
    it(
      'führender Strich ("- Strich zuerst") DIREKT an der Space-Wurzel → 201, Pfad-Segment "strich-zuerst" '
        + '(vorher nur über einen Parent-Workaround testbar, siehe Fix-Runde 1)',
      async () => {
        const title = '- Strich zuerst'
        const body = await expectCleanPage({ space: space.id, title }, title)
        expect(body.path).toBe('strich-zuerst/index.md')
      },
    )

    it('Titel besteht nur aus Bindestrichen/Leerzeichen ("- - -") → 400, kein Branch angelegt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: '- - -' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  it(
    'Voller Zyklus: Anlage → Autosave → Review → Release (ZWEITER Nutzer) → GET /api/pages/:id (main) ' +
      'liefert die Seite mit STABILER id (Indexer-ID-Beweis, Kernanforderung des Tasks)',
    async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Zyklus-Seite' },
      })
      expect(createRes.statusCode).toBe(201)
      const created = createRes.json() as CreatePageResult
      // Phase 3.1: generierte, stabile Id (`p-<10 Zeichen base36>`) statt
      // Pfad-Fallback — Kernanforderung dieser Phase (Modul-Kommentar oben).
      const expectedId = created.id
      expect(created.id).toMatch(/^p-[0-9a-z]{10}$/)
      expect(parsePage(created.content).frontmatter.id).toBe(created.id)
      const idPath = encodeURIComponent(created.id)

      // Autosave über den normalen Editor-Pfad — beweist den
      // `resolveWriteContext`-Draft-only-Fallback für PUT-Autosave.
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/pages/${idPath}/draft`,
        cookies: cookiesOf(writerSession),
        payload: {
          content: created.content.replace('# Zyklus-Seite\n', '# Zyklus-Seite\n\nZyklusinhalt v2\n'),
          baseSha: created.baseSha,
        },
      })
      expect(putRes.statusCode).toBe(200)

      const reviewRes = await app.inject({
        method: 'POST',
        url: `/api/pages/${idPath}/review`,
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(reviewRes.statusCode).toBe(200)

      const releaseRes = await app.inject({
        method: 'POST',
        url: `/api/pages/${idPath}/release`,
        cookies: cookiesOf(releaserSession),
        payload: { comment: 'LGTM' },
      })
      expect(releaseRes.statusCode).toBe(200)
      expect(releaseRes.json().mergeSha).toMatch(/^[0-9a-f]{40}$/)

      const pageRes = await app.inject({
        method: 'GET',
        url: `/api/pages/${idPath}`,
        cookies: cookiesOf(writerSession),
      })
      expect(pageRes.statusCode).toBe(200)
      const pageBody = pageRes.json()
      expect(pageBody.id).toBe(created.id)
      expect(pageBody.id).toBe(expectedId)
      expect(pageBody.space).toBe(space.id)
      expect(pageBody.path).toBe(created.path)
      expect(pageBody.html).toContain('Zyklusinhalt v2')
      // Kein Draft-Branch mehr (Release-Cleanup) → workflow-Feld null.
      expect(pageBody.workflow).toBeNull()

      // Draft-Index-Zeile weg, main-Zeile jetzt vorhanden — dieselbe id.
      const draftRows = await db.select().from(pages).where(and(eq(pages.id, created.id), eq(pages.ref, 'draft')))
      expect(draftRows).toHaveLength(0)
      const mainRows = await db.select().from(pages).where(and(eq(pages.id, created.id), eq(pages.ref, 'main')))
      expect(mainRows).toHaveLength(1)
    },
    30_000,
  )
})
