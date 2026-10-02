import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, ProviderError, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { parsePage } from '@f451/markdown'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pageReleases, pageVersions, pages, users } from '../src/db/schema.js'
import { reconstructPageVersions } from '../src/indexer/version-history.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

interface ReviewResult {
  number: number
  url: string
  state: string
  mergeable: boolean | null
}

/**
 * Workflow-Routen `POST /api/pages/:id/review|release|review/request-changes|
 * draft/update` (Phase 2d Task 3) — durchgehend über `buildApp`/`app.inject()`
 * gegen echten Forgejo- und PG-Container. Jedes Szenario nutzt eine eigene
 * Seiten-Id (statt einer einzigen, über den ganzen Test-Lauf mutierten Seite
 * wie in `drafts-routes.test.ts`) — der Workflow-Zustand (Branch → PR →
 * Merge) ist inhärent zustandsbehaftet, getrennte Seiten machen jedes
 * Szenario unabhängig lesbar und ordnungsunabhängig.
 */
describe.sequential('Workflow-Routen: review/release/request-changes/draft-update (Phase 2d Task 3)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: FastifyInstance

  let writer: ForgejoTestUser
  let releaser: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'wf-writer'
  const releaserUserId = 'wf-releaser'
  const readerUserId = 'wf-reader'

  let writerSession: string
  let releaserSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('workflow-routes', { private: false })

    space = {
      id: 'workflow-routes-space', name: 'Workflow Routes', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }

    writer = await forgejo.createUser('wf-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    releaser = await forgejo.createUser('wf-releaser')
    await forgejo.addCollaborator(space.repoRef, releaser.username, 'write')
    reader = await forgejo.createUser('wf-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'wf-writer@example.org', displayName: 'Writer' },
      { id: releaserUserId, email: 'wf-releaser@example.org', displayName: 'Releaser' },
      { id: readerUserId, email: 'wf-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(
      db, releaserUserId, 'forgejo', releaser.username, { accessToken: releaser.token }, TOKEN_KEY,
    )
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
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
    releaserSession = (await createSession(db, releaserUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  /** Seedet eine frische Seite auf main und indexiert den Space neu (die
   *  Workflow-Routen lesen die Seiten-Metadaten — Titel/Pfad — aus dem Index). */
  async function seedPage(pageId: string, title: string, folder: string): Promise<string> {
    const path = `${folder}/index.md`
    await provider.writeFile(
      repo, path,
      `---\nid: ${pageId}\ntitle: ${title}\nlang: de\n---\n# ${title}\n\nv1\n`,
      { branch: 'main', message: `seed: ${pageId}` },
    )
    await indexSpace({ db, provider }, space)
    return path
  }

  async function createDraft(pageId: string, session: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(session),
    })
    expect(res.statusCode).toBe(200)
  }

  /** Committet eine kleine, echte Änderung auf den Draft-Branch — Vorbedingung für
   *  `POST /review`/`POST /release` seit Fix #11 (Drafts ohne Commits gegenüber
   *  main werden dort mit 422 `no_changes` abgelehnt, s. `routes/workflow.ts`).
   *  `createDraft` allein legt den Branch nur an (== main, 0 Commits), viele
   *  Szenarien in dieser Datei brauchen aber keinen bestimmten Inhalt, nur
   *  irgendeinen echten Diff. */
  async function editDraft(targetApp: FastifyInstance, pageId: string, path: string, session: string): Promise<void> {
    const before = await provider.readFile(repo, path, draftBranchName(pageId))
    const res = await targetApp.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(session),
      payload: { content: `${before.content}\nBearbeitet für den Review-Test.\n`, baseSha: before.sha },
    })
    expect(res.statusCode).toBe(200)
  }

  /** Ruft `POST /review` wiederholt auf (idempotent, sicher mehrfach aufrufbar),
   *  bis `mergeable !== null` oder das Budget ausgeschöpft ist — robuster als
   *  eine einzelne Anfrage, deren serverseitiges 5s-Poll-Fenster knapp sein
   *  kann, wenn Forgejo die Mergebarkeit noch nicht fertig berechnet hat. */
  async function pollReviewMergeable(
    pageId: string,
    session: string,
    budgetMs = 20_000,
  ): Promise<ReviewResult> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/review`,
        cookies: cookiesOf(session),
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as ReviewResult
      if (body.mergeable !== null || Date.now() >= deadline) return body
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  describe('POST /api/pages/:id/review', () => {
    it('kein Draft-Branch → 409 "kein Entwurf vorhanden"', async () => {
      await seedPage('wf-no-draft', 'Kein Entwurf', 'wf-no-draft')
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-no-draft/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBeTruthy()
    })

    it('eröffnet den PR und ist idempotent (zweiter Aufruf liefert denselben PR)', async () => {
      const path = await seedPage('wf-review', 'Review Idempotent', 'wf-review')
      await createDraft('wf-review', writerSession)
      await editDraft(app, 'wf-review', path, writerSession)

      const first = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-review/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(first.statusCode).toBe(200)
      const firstBody = first.json() as ReviewResult
      expect(firstBody.state).toBe('review')
      expect(firstBody.number).toBeGreaterThan(0)
      expect(firstBody.url).toBeTruthy()

      const second = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-review/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json() as ReviewResult
      expect(secondBody.number).toBe(firstBody.number)
      expect(secondBody.url).toBe(firstBody.url)

      // getWorkflowState (Task 2) spiegelt denselben Zustand über die Lese-API.
      const stateRes = await app.inject({
        method: 'GET',
        url: '/api/pages/wf-review',
        cookies: cookiesOf(writerSession),
      })
      expect(stateRes.json().workflow.state).toBe('review')
      expect(stateRes.json().workflow.pr.number).toBe(firstBody.number)
    }, 15_000)

    it(
      'Fix #11: Draft ohne jeden Commit gegenüber main → 422 no_changes, KEIN PR wird eröffnet ' +
        '(vorher: Forgejo ließ den PR anlegen, der Merge scheiterte dann dauerhaft mit transientem 405)',
      async () => {
        await seedPage('wf-review-empty', 'Review Leer', 'wf-review-empty')
        await createDraft('wf-review-empty', writerSession)

        const res = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-review-empty/review',
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(res.statusCode).toBe(422)
        expect(res.json()).toEqual({ error: 'Draft has no changes', reason: 'no_changes' })

        const open = await provider.listPullRequests(repo, {
          head: draftBranchName('wf-review-empty'),
          base: 'main',
          state: 'open',
        })
        expect(open).toHaveLength(0)
      },
    )

    it('künstlicher Konflikt (main-Commit auf dieselbe Zeile nach Draft-Erstellung) → mergeable false', async () => {
      const path = await seedPage('wf-conflict', 'Konflikt', 'wf-conflict')
      const draftRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-conflict/draft',
        cookies: cookiesOf(writerSession),
      })
      expect(draftRes.statusCode).toBe(200)
      const branch = draftBranchName('wf-conflict')

      // Draft-seitige Änderung derselben Zeile.
      const draftFile = await provider.readFile(repo, path, branch)
      await provider.writeFile(
        repo, path,
        draftFile.content.replace('v1', 'draft-änderung'),
        { branch, message: 'draft: Konflikt-Zeile ändern', sha: draftFile.sha },
      )

      // Main-seitige Änderung DERSELBEN Zeile (widersprüchlich).
      const mainFile = await provider.readFile(repo, path, 'main')
      await provider.writeFile(
        repo, path,
        mainFile.content.replace('v1', 'main-änderung'),
        { branch: 'main', message: 'main: Konflikt-Zeile ändern', sha: mainFile.sha },
      )
      await indexSpace({ db, provider }, space)

      const result = await pollReviewMergeable('wf-conflict', writerSession)
      expect(result.mergeable).toBe(false)
    }, 30_000)
  })

  interface ReviewGetResult {
    pr: { number: number; url: string; state: string; mergeable: boolean | null; title: string }
    authorName: string
    diff: {
      blocks: Array<{ kind: string; html: string; anchor: string }>
      summary: { added: number; changed: number; removed: number }
      mdLines: Array<{ kind: string; text: string }>
    }
    page: { id: string; space: string; title: string }
    // Befund 3 (Final-Review): `versioning`/`version` liefert diese Route seither
    // selbst mit, statt dass `apps/web/.../review/page.tsx` sie über einen
    // zweiten, fehler-toleranten Fetch nachlädt.
    versioning: boolean
    version?: string
    implicitVersion?: boolean
  }

  /** Pollt `GET /review`, bis `pr.mergeable !== null` oder das Budget ausgeschöpft ist —
   *  dasselbe Muster wie `pollReviewMergeable` für `POST /review`, hier auf den
   *  Lese-Endpunkt (Task 4) angewendet. Liefert die rohe `inject`-Antwort, damit
   *  Aufrufer auch Nicht-200-Fälle prüfen können. */
  async function pollReviewGetMergeable(
    pageId: string,
    session: string,
    budgetMs = 20_000,
  ): Promise<Awaited<ReturnType<typeof app.inject>>> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}/review`,
        cookies: cookiesOf(session),
      })
      if (res.statusCode !== 200) return res
      const body = res.json() as ReviewGetResult
      if (body.pr.mergeable !== null || Date.now() >= deadline) return res
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  describe('GET /api/pages/:id/review', () => {
    it('kein offener PR → 404 "kein offenes Review"', async () => {
      await seedPage('wf-review-get-no-pr', 'Kein PR', 'wf-review-get-no-pr')
      await createDraft('wf-review-get-no-pr', writerSession)
      const res = await app.inject({
        method: 'GET',
        url: '/api/pages/wf-review-get-no-pr/review',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ status: 'not_found', reason: 'kein offenes Review' })
    })

    it('ohne Schreibrecht → 403 (Gate-Kette, dieselbe wie bei den POST-Routen)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/pages/wf-review-get-no-pr/review',
        cookies: cookiesOf(readerSession),
      })
      expect(res.statusCode).toBe(403)
    })

    it(
      'offener PR mit Änderungen: 200 mit visuellem Diff (summary stimmt), Autor, Seiten-Meta, mergeable=true',
      async () => {
        const path = await seedPage('wf-review-get', 'Review GET', 'wf-review-get')
        await createDraft('wf-review-get', writerSession)

        const before = await provider.readFile(repo, path, draftBranchName('wf-review-get'))
        const saveRes = await app.inject({
          method: 'PUT',
          url: '/api/pages/wf-review-get/draft',
          cookies: cookiesOf(writerSession),
          payload: {
            content: `${before.content.replace('v1', 'v2 (GET-Review-Test)')}\nNeuer Absatz.\n`,
            baseSha: before.sha,
          },
        })
        expect(saveRes.statusCode).toBe(200)

        const reviewRes = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-review-get/review',
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(reviewRes.statusCode).toBe(200)
        const prNumber = (reviewRes.json() as ReviewResult).number

        const getRes = await pollReviewGetMergeable('wf-review-get', writerSession)
        expect(getRes.statusCode).toBe(200)
        const body = getRes.json() as ReviewGetResult

        expect(body.pr.number).toBe(prNumber)
        expect(body.pr.state).toBe('open')
        expect(body.pr.title).toBe('Review GET')
        expect(body.pr.mergeable).toBe(true)
        expect(body.authorName).toBeTruthy()
        expect(body.page).toEqual({ id: 'wf-review-get', space: space.id, title: 'Review GET' })
        // Unversionierter Space (`space`, kein `_meta/schema.yaml` mit
        // `versioning: true`) — Befund 3 (Final-Review): `versioning` ist IMMER
        // im Response (auch `false`), `version` fehlt ganz.
        expect(body.versioning).toBe(false)
        expect(body.version).toBeUndefined()

        // summary == tatsächliche Blockzählung (Zeile v1->v2 = changed, neuer Absatz = added).
        const kinds = body.diff.blocks.map((b) => b.kind)
        expect(kinds).toContain('changed')
        expect(kinds).toContain('added')
        expect(body.diff.summary).toEqual({
          added: kinds.filter((k) => k === 'added').length,
          changed: kinds.filter((k) => k === 'changed').length,
          removed: kinds.filter((k) => k === 'removed').length,
        })
        expect(body.diff.summary.changed).toBeGreaterThanOrEqual(1)
        expect(body.diff.summary.added).toBeGreaterThanOrEqual(1)
        expect(body.diff.mdLines.length).toBeGreaterThan(0)
      },
      20_000,
    )

    it(
      'Bugfix: Diagramm-/Bild-Referenzen der Diff werden mit ?ref=draft gerendert (vorgeschlagene Fassung, nicht main)',
      async () => {
        await seedPage('wf-review-img', 'Review Bild', 'wf-review-img')
        await createDraft('wf-review-img', writerSession)

        // Der Entwurf fügt eine Diagramm-Referenz hinzu. Der Diff muss diese
        // aus dem Draft-Branch laden — sonst zeigt die Review die alte
        // main-Fassung eines geänderten Diagramms (der eigentliche Bug).
        const branch = draftBranchName('wf-review-img')
        const before = await provider.readFile(repo, 'wf-review-img/index.md', branch)
        const saveRes = await app.inject({
          method: 'PUT',
          url: '/api/pages/wf-review-img/draft',
          cookies: cookiesOf(writerSession),
          payload: {
            content: `${before.content}\n![Architektur](_media/arch.drawio.svg)\n`,
            baseSha: before.sha,
          },
        })
        expect(saveRes.statusCode).toBe(200)

        const reviewRes = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-review-img/review',
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(reviewRes.statusCode).toBe(200)

        const getRes = await pollReviewGetMergeable('wf-review-img', writerSession)
        expect(getRes.statusCode).toBe(200)
        const body = getRes.json() as ReviewGetResult

        const imageBlock = body.diff.blocks.find((b) => b.html.includes('arch.drawio.svg'))
        expect(imageBlock).toBeDefined()
        // Die gerenderte Bild-URL trägt ?ref=draft (media.ts lädt sonst main).
        expect(imageBlock!.html).toContain('/media/wf-review-img/arch.drawio.svg?ref=draft')
      },
      20_000,
    )

    it(
      'Draft-only-Seite (noch nie released, „+ Neue Seite") → 200 mit main als leerem Dokument, kein 502 ' +
        '(Regression, Task 8: per E2E gefunden — main hat für eine solche Seite noch keine Datei)',
      async () => {
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/pages',
          cookies: cookiesOf(writerSession),
          payload: { space: space.id, title: 'Ganz neue Seite GET-Review' },
        })
        expect(createRes.statusCode).toBe(201)
        const newPageId = (createRes.json() as { id: string }).id

        const reviewRes = await app.inject({
          method: 'POST',
          url: `/api/pages/${encodeURIComponent(newPageId)}/review`,
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(reviewRes.statusCode).toBe(200)

        const getRes = await pollReviewGetMergeable(encodeURIComponent(newPageId), writerSession)
        expect(getRes.statusCode).toBe(200)
        const body = getRes.json() as ReviewGetResult

        // Der komplette Body-Inhalt (`# <Titel>`) erscheint als `added`-Block —
        // main ist für diese Seite noch leer, kein Fehler. Das Frontmatter
        // selbst zeigt separat als EIN `changed`-Block (leeres altes vs. das
        // reale neue Frontmatter, `buildFrontmatterDiffBlock`) — kein
        // `removed`-Block, main hat schlicht nichts zu entfernen.
        const kinds = body.diff.blocks.map((b) => b.kind)
        expect(kinds).toContain('added')
        expect(kinds).not.toContain('removed')
        expect(body.diff.summary.added).toBeGreaterThanOrEqual(1)
      },
      20_000,
    )

    it('Merge-Konflikt: mergeable=false wird über GET sichtbar', async () => {
      const path = await seedPage('wf-review-get-conflict', 'GET Konflikt', 'wf-review-get-conflict')
      const draftRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-review-get-conflict/draft',
        cookies: cookiesOf(writerSession),
      })
      expect(draftRes.statusCode).toBe(200)
      const branch = draftBranchName('wf-review-get-conflict')

      // Draft- und main-seitige Änderung DERSELBEN Zeile (widersprüchlich, wie im
      // POST-/review-Konflikttest oben).
      const draftFile = await provider.readFile(repo, path, branch)
      await provider.writeFile(
        repo, path,
        draftFile.content.replace('v1', 'draft-änderung'),
        { branch, message: 'draft: Konflikt-Zeile ändern', sha: draftFile.sha },
      )
      const mainFile = await provider.readFile(repo, path, 'main')
      await provider.writeFile(
        repo, path,
        mainFile.content.replace('v1', 'main-änderung'),
        { branch: 'main', message: 'main: Konflikt-Zeile ändern', sha: mainFile.sha },
      )
      await indexSpace({ db, provider }, space)

      const reviewRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-review-get-conflict/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(reviewRes.statusCode).toBe(200)

      const getRes = await pollReviewGetMergeable('wf-review-get-conflict', writerSession)
      expect(getRes.statusCode).toBe(200)
      const body = getRes.json() as ReviewGetResult
      expect(body.pr.mergeable).toBe(false)
      // Beide Seiten haben dieselbe Zeile unterschiedlich geändert -> mindestens ein
      // changed-Block (Wort-Diff-Absatz).
      expect(body.diff.blocks.map((b) => b.kind)).toContain('changed')
    }, 30_000)

    it(
      'interner Wikilink auf eine existierende Space-Seite löst im Diff auf (kein broken-link); ' +
        'ein echter kaputter Link bleibt broken-link (Finding 2, Fix-Runde 1)',
      async () => {
        await seedPage('wf-review-link-target', 'Link Ziel', 'wf-review-link-target')
        const path = await seedPage('wf-review-link-source', 'Link Quelle', 'wf-review-link-source')
        await createDraft('wf-review-link-source', writerSession)

        const before = await provider.readFile(repo, path, draftBranchName('wf-review-link-source'))
        const saveRes = await app.inject({
          method: 'PUT',
          url: '/api/pages/wf-review-link-source/draft',
          cookies: cookiesOf(writerSession),
          payload: {
            content: `${before.content}\nSiehe [[wf-review-link-target]] und [[nicht-vorhanden]].\n`,
            baseSha: before.sha,
          },
        })
        expect(saveRes.statusCode).toBe(200)

        const reviewRes = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-review-link-source/review',
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(reviewRes.statusCode).toBe(200)

        const getRes = await pollReviewGetMergeable('wf-review-link-source', writerSession)
        expect(getRes.statusCode).toBe(200)
        const body = getRes.json() as ReviewGetResult

        // Der neue Absatz ist ein 'added'-Block (renderHtml + resolveLink, kein
        // Wort-Diff) — genau der Pfad, den `diffMarkdown`s `resolveLink`-Option
        // laut diff.ts-Kommentar für same/added/removed-Blöcke nutzt.
        const addedBlock = body.diff.blocks.find(
          (b) => b.kind === 'added' && b.html.includes('wf-review-link-target'),
        )
        expect(addedBlock).toBeTruthy()
        // Der gültige Wikilink löst auf — kein broken-link für DIESES Ziel.
        expect(addedBlock!.html).toContain('href="/wiki/workflow-routes-space/wf-review-link-target"')
        expect(addedBlock!.html).not.toMatch(
          /broken-link" title="Seite existiert nicht: wf-review-link-target"/,
        )
        // Der zweite, absichtlich kaputte Link bleibt im selben Block weiterhin
        // als broken-link markiert (Resolver löst NICHT einfach alles auf).
        expect(addedBlock!.html).toContain('broken-link')
        expect(addedBlock!.html).toContain('Seite existiert nicht: nicht-vorhanden')
      },
      20_000,
    )
  })

  describe('POST /api/pages/:id/release', () => {
    it('kein offener PR → 409', async () => {
      await seedPage('wf-release-no-pr', 'Kein PR', 'wf-release-no-pr')
      await createDraft('wf-release-no-pr', writerSession)
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-release-no-pr/release',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBeTruthy()
    })

    it('ohne Schreibrecht → 403 (Gate-Kette)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-release-no-pr/release',
        cookies: cookiesOf(readerSession),
        payload: {},
      })
      expect(res.statusCode).toBe(403)
    })

    it(
      'Befund 6 (Final-Review): `note` über 500 Zeichen → saubere 400-Antwort (AJV maxLength) statt '
        + '500 — hier gab es im Projekt bereits den Fall, dass eine Body-Schema-Verletzung wegen des '
        + 'undeklarierten 400-Response-Schemas als FST_ERR_FAILED_ERROR_SERIALIZATION endete '
        + '(s. `error-format.ts`-Kommentar). AJV-Validierung läuft VOR dem Handler, ein offener PR ist '
        + 'dafür nicht nötig.',
      async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-release-no-pr/release',
          cookies: cookiesOf(writerSession),
          payload: { note: 'x'.repeat(501) },
        })
        expect(res.statusCode).toBe(400)
        const body = res.json() as { status: string; reason: string }
        expect(body.status).toBe('bad_request')
        expect(body.reason).toBeTruthy()
      },
    )

    it('note mit GENAU 500 Zeichen bleibt gültig (Grenzwert, keine 400 durch maxLength)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-release-no-pr/release',
        cookies: cookiesOf(writerSession),
        payload: { note: 'x'.repeat(500) },
      })
      // Kein offener PR für diese Seite → 409, NICHT 400 — belegt, dass die
      // maxLength-Grenze bei genau 500 Zeichen noch nicht greift (sonst käme
      // hier 400 statt 409).
      expect(res.statusCode).toBe(409)
    })

    it(
      'Fix #11: offener PR ohne jeden Commit gegenüber main (Branch/PR direkt über den Provider ' +
        'angelegt, am neuen POST /review-Schutz vorbei — z. B. ein Altfall von vor diesem Fix) → ' +
        '422 no_changes SOFORT, kein 502 nach dem internen ~15s-Merge-Retry-Budget (der eigentliche Bug)',
      async () => {
        const pageId = 'wf-release-empty'
        await seedPage(pageId, 'Release Leer', pageId)
        const branch = draftBranchName(pageId)
        await provider.createBranch(repo, branch, 'main')
        const pr = await provider.createPullRequest(repo, {
          head: branch, base: 'main', title: 'Release Leer', body: 'ohne Änderungen',
        })

        const start = Date.now()
        const res = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/release`,
          cookies: cookiesOf(releaserSession),
          payload: {},
        })
        const elapsedMs = Date.now() - start

        expect(res.statusCode).toBe(422)
        expect(res.json()).toEqual({ error: 'Draft has no changes', reason: 'no_changes' })
        expect(elapsedMs).toBeLessThan(5_000)

        // Kein Merge-Versuch: der PR ist unangetastet weiterhin offen.
        const stillOpen = await provider.getPullRequest(repo, pr.number)
        expect(stillOpen.state).toBe('open')
      },
      20_000,
    )

    it(
      'Freigabe durch einen ZWEITEN Nutzer mit Schreibrecht: approve+merge, synchroner Cleanup ' +
        '(Branch weg, Draft-Index weg, Lock weg) und main-HTML sofort aktualisiert',
      async () => {
        const path = await seedPage('wf-release', 'Release Cleanup', 'wf-release')
        await createDraft('wf-release', writerSession)

        // Autor bearbeitet den Draft (echter Inhalt für den Merge).
        const before = await provider.readFile(repo, path, draftBranchName('wf-release'))
        const saveRes = await app.inject({
          method: 'PUT',
          url: '/api/pages/wf-release/draft',
          cookies: cookiesOf(writerSession),
          payload: {
            content: before.content.replace('v1', 'v2 (Release-Test)'),
            baseSha: before.sha,
          },
        })
        expect(saveRes.statusCode).toBe(200)

        // Lock-Heartbeat des Autors, damit der Cleanup ihn nachweisbar entfernt.
        const lockRes = await app.inject({
          method: 'PUT',
          url: '/api/locks/wf-release',
          cookies: cookiesOf(writerSession),
        })
        expect(lockRes.statusCode).toBe(200)

        const reviewRes = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-release/review',
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(reviewRes.statusCode).toBe(200)

        const releaseRes = await app.inject({
          method: 'POST',
          url: '/api/pages/wf-release/release',
          cookies: cookiesOf(releaserSession),
          payload: { comment: 'LGTM' },
        })
        expect(releaseRes.statusCode).toBe(200)
        expect(releaseRes.json().mergeSha).toMatch(/^[0-9a-f]{40}$/)
        // Unversionierter Space (kein `_meta/schema.yaml` mit `versioning: true`):
        // Bestandsverhalten bleibt exakt unverändert — kein `version`-Feld in
        // der Antwort (Task 6).
        expect(releaseRes.json().version).toBeUndefined()

        // Branch weg.
        await expect(provider.getHeadSha(repo, draftBranchName('wf-release'))).rejects.toThrow()

        // Draft-Index-Zeile (ref='draft') weg.
        const draftRows = await db
          .select()
          .from(pages)
          .where(and(eq(pages.id, 'wf-release'), eq(pages.ref, 'draft')))
        expect(draftRows).toHaveLength(0)

        // Lock weg.
        const lockRows = await db.select().from(locks).where(eq(locks.pageId, 'wf-release'))
        expect(lockRows).toHaveLength(0)

        // Unversionierter Space: kein `page_versions`-Eintrag (Task 6, keine
        // zusätzlichen Provider-/DB-Aufrufe für Spaces ohne `versioning: true`).
        const versionRows = await db.select().from(pageVersions).where(eq(pageVersions.pageId, 'wf-release'))
        expect(versionRows).toHaveLength(0)

        // main-HTML sofort aktualisiert (synchrone Neu-Indexierung, kein Warten
        // auf den Webhook).
        const pageRes = await app.inject({
          method: 'GET',
          url: '/api/pages/wf-release',
          cookies: cookiesOf(writerSession),
        })
        expect(pageRes.statusCode).toBe(200)
        expect(pageRes.json().html).toContain('Release-Test')
        // Kein Draft-Branch mehr (Cleanup) → `getWorkflowState` liefert `null`,
        // das gesamte `workflow`-Feld wird `null` (nicht nur `state`).
        expect(pageRes.json().workflow).toBeNull()
      },
      15_000,
    )

    it('Merge bei Konflikt (mergeable=false) → 409 {error, reason: "conflict"}', async () => {
      const releaseRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-conflict/release',
        cookies: cookiesOf(releaserSession),
        payload: {},
      })
      expect(releaseRes.statusCode).toBe(409)
      expect(releaseRes.json().reason).toBe('conflict')
    }, 30_000)

    it(
      'Freigabe durch den PR-AUTOR selbst (Self-Release, Finding 1 Fix-Runde 1): approve+merge ' +
        'gelingen, die Antwort trägt KEIN approveWarning (tolerierte Fehlerklasse — real gegen ' +
        'Forgejo geprüft, kein Stub)',
      async () => {
        // EIGENES, frisches Repo statt des geteilten `workflow-routes`-Repos —
        // hält den Test unabhängig von anderen Szenarien, ohne einen eigenen
        // Forgejo-/PG-Container zu starten (derselbe bereits laufende wird
        // wiederverwendet).
        const selfRepo = await forgejo.createRepo('workflow-routes-self-release', { private: false })
        await forgejo.addCollaborator(selfRepo, writer.username, 'write')
        const selfSpace: SpaceConfig = {
          id: 'workflow-routes-self-release-space', name: 'Self Release Space', provider: 'forgejo',
          owner: selfRepo.owner, repo: selfRepo.repo, defaultLang: 'de', repoRef: selfRepo,
        }
        const selfApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [selfSpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await selfApp.ready()

        try {
          const pageId = 'wf-release-self'
          const path = `${pageId}/index.md`
          await provider.writeFile(
            selfRepo, path,
            `---\nid: ${pageId}\ntitle: Self Release\nlang: de\n---\n# Self Release\n\nv1\n`,
            { branch: 'main', message: `seed: ${pageId}` },
          )
          await indexSpace({ db, provider }, selfSpace)

          const draftRes = await selfApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }

          // Echte Änderung committen (ein PR OHNE jeden Diff — Draft == main —
          // führte in dieser Forgejo-Version beobachtbar dazu, dass der
          // `merge`-Endpunkt dauerhaft transient 405 lieferte, bis das interne
          // ~15s-Retry-Budget von `mergePullRequest` ausgeschöpft war; ein PR
          // mit echtem Inhalt mergt dagegen sofort).
          const saveRes = await selfApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: '# Self Release\n\nv2 (Self-Release-Test)\n', baseSha },
          })
          expect(saveRes.statusCode).toBe(200)

          const reviewRes = await selfApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)

          // Derselbe Nutzer, der den PR eröffnet hat, löst die Freigabe aus.
          const releaseRes = await selfApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/release`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(releaseRes.statusCode).toBe(200)
          const body = releaseRes.json()
          expect(body.mergeSha).toMatch(/^[0-9a-f]{40}$/)
          expect(body.approveWarning).toBeUndefined()
        } finally {
          await selfApp.close()
        }
      },
      30_000,
    )

    it(
      'Metadaten-Feature M3b Teil B: fillOnRelease-Felder werden VOR dem Merge vorbelegt (leeres Feld) '
        + 'bzw. bleiben unverändert (bereits gesetztes Feld) — echter Merge, kein Stub',
      async () => {
        // Eigenes Repo (wie beim Self-Release-Test oben) — `_meta/schema.yaml`
        // ist ein Repo-weiter Konfigurationsstand, den andere Szenarien im
        // geteilten `workflow-routes`-Repo nicht erwarten.
        const fillRepo = await forgejo.createRepo('workflow-routes-fill-on-release', { private: false })
        await forgejo.addCollaborator(fillRepo, writer.username, 'write')
        await forgejo.addCollaborator(fillRepo, releaser.username, 'write')
        const fillSpace: SpaceConfig = {
          id: 'workflow-routes-fill-space', name: 'Fill On Release Space', provider: 'forgejo',
          owner: fillRepo.owner, repo: fillRepo.repo, defaultLang: 'de', repoRef: fillRepo,
        }
        const fillApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [fillSpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await fillApp.ready()

        try {
          await provider.writeFile(
            fillRepo, '_meta/schema.yaml',
            'fields:\n'
              + '  - key: approved_by\n    label: Approved by\n    type: user\n    fillOnRelease: actor\n'
              + '  - key: approval_date\n    label: Approval date\n    type: date\n    fillOnRelease: date\n'
              + '  - key: reviewer\n    label: Reviewer\n    type: user\n',
            { branch: 'main', message: 'seed: _meta/schema.yaml' },
          )

          const pageId = 'wf-fill-on-release'
          const path = `${pageId}/index.md`
          // `approved_by` bereits vom Autor gesetzt (bleibt erhalten), `approval_date`
          // fehlt (wird vorbelegt) — deckt beide Zweige in EINEM Durchlauf ab.
          await provider.writeFile(
            fillRepo, path,
            `---\nid: ${pageId}\ntitle: Fill On Release\nlang: de\napproved_by: Vorab-Genehmiger\n---\n`
              + '# Fill On Release\n\nv1\n',
            { branch: 'main', message: `seed: ${pageId}` },
          )
          await indexSpace({ db, provider }, fillSpace)

          const draftRes = await fillApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }

          const saveRes = await fillApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: {
              content: `---\nid: ${pageId}\ntitle: Fill On Release\nlang: de\napproved_by: Vorab-Genehmiger\n---\n`
                + '# Fill On Release\n\nv2 (Fill-On-Release-Test)\n',
              baseSha,
            },
          })
          expect(saveRes.statusCode).toBe(200)

          const reviewRes = await fillApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)

          const releaseRes = await fillApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/release`, cookies: cookiesOf(releaserSession), payload: {},
          })
          expect(releaseRes.statusCode).toBe(200)

          const merged = await provider.readFile(fillRepo, path, 'main')
          // Bereits gesetzter Wert bleibt UNVERÄNDERT (kein Überschreiben).
          expect(merged.content).toContain('approved_by: Vorab-Genehmiger')
          // Leeres fillOnRelease-Feld wurde mit dem heutigen Datum vorbelegt.
          const today = new Date().toISOString().slice(0, 10)
          expect(merged.content).toContain(`approval_date: ${today}`)
          // Feld OHNE fillOnRelease bleibt unberührt (nicht plötzlich befüllt).
          expect(merged.content).not.toContain('reviewer:')
          expect(merged.content).toContain('v2 (Fill-On-Release-Test)')
        } finally {
          await fillApp.close()
        }
      },
      30_000,
    )

    it(
      'Release archive (#38): archive:true freezes page.md and the referenced attachments in the same merge',
      async () => {
        const archiveRepo = await forgejo.createRepo('workflow-routes-archive', { private: false })
        await forgejo.addCollaborator(archiveRepo, writer.username, 'write')
        await forgejo.addCollaborator(archiveRepo, releaser.username, 'write')
        const archiveSpace: SpaceConfig = {
          id: 'workflow-routes-archive-space', name: 'Archive Space', provider: 'forgejo',
          owner: archiveRepo.owner, repo: archiveRepo.repo, defaultLang: 'en', repoRef: archiveRepo,
        }
        const archiveApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [archiveSpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await archiveApp.ready()

        try {
          const seed = { branch: 'main', message: 'seed' }
          await provider.writeFile(archiveRepo, '_meta/schema.yaml', 'versioning: true\n', seed)
          const pageId = 'wf-archive'
          const path = `${pageId}/index.md`
          await provider.writeFile(archiveRepo, path, `---\nid: ${pageId}\ntitle: Archive\nlang: en\n---\n# Archive\n\nv1\n`, seed)
          await provider.writeFileBinary(archiveRepo, `${pageId}/_media/used.png`, Buffer.from('used-bytes'), seed)
          await provider.writeFileBinary(archiveRepo, `${pageId}/_media/unused.png`, Buffer.from('unused'), seed)
          await indexSpace({ db, provider }, archiveSpace)

          const draftRes = await archiveApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          const { baseSha } = draftRes.json() as { baseSha: string }
          const saveRes = await archiveApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: {
              content: `---\nid: ${pageId}\ntitle: Archive\nlang: en\n---\n# Archive\n\nv2\n\n![a](_media/used.png)\n![b](_media/gone.svg)\n`,
              baseSha,
            },
          })
          expect(saveRes.statusCode).toBe(200)
          await archiveApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })

          const releaseRes = await archiveApp.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'major', note: 'Frozen', archive: true },
          })
          expect(releaseRes.statusCode).toBe(200)
          const body = releaseRes.json() as { version: string; archivePath: string; missingAttachments?: string[] }
          expect(body.version).toBe('1.0.0')
          expect(body.archivePath).toBe(`${pageId}/_releases/1.0.0/page.md`)
          expect(body.missingAttachments).toEqual(['gone.svg'])

          const frozen = await provider.readFile(archiveRepo, body.archivePath, 'main')
          expect(frozen.content).toContain('v2')
          expect(frozen.content).toContain('version: 1.0.0')
          expect(frozen.content).toMatch(/release:\n\s+version: 1\.0\.0/)
          expect(frozen.content).toContain(`source: ${pageId}`)
          expect(frozen.content).not.toMatch(/^id:/m)
          const media = await provider.readFileBinary(archiveRepo, `${pageId}/_releases/1.0.0/_media/used.png`, 'main')
          expect(media.content.toString()).toBe('used-bytes')
          await expect(
            provider.readFileBinary(archiveRepo, `${pageId}/_releases/1.0.0/_media/unused.png`, 'main'),
          ).rejects.toThrow()

          const rows = await db.select().from(pageReleases).where(eq(pageReleases.pageId, pageId))
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({ version: '1.0.0', path: body.archivePath, blobSha: frozen.sha, note: 'Frozen' })

          // The copy is not a page of its own.
          const indexed = await db.select().from(pages).where(eq(pages.spaceId, archiveSpace.id))
          expect(indexed.map((r) => r.path)).not.toContain(body.archivePath)
        } finally {
          await archiveApp.close()
        }
      },
      30_000,
    )

    it(
      'Seitenversionierung (Task 6, Space mit `versioning: true`): erste Freigabe setzt 1.0.0, '
        + 'schreibt den Changelog ins Frontmatter, legt einen `page_versions`-Eintrag mit '
        + 'mergeSha UND blobSha an — zweite Freigabe rechnet korrekt von main weiter (1.1.0)',
      async () => {
        // Eigenes Repo (wie bei den Szenarien oben) — `_meta/schema.yaml` mit
        // `versioning: true` ist ein Repo-weiter Konfigurationsstand, den
        // andere Szenarien im geteilten `workflow-routes`-Repo nicht erwarten.
        const versionRepo = await forgejo.createRepo('workflow-routes-versioning', { private: false })
        await forgejo.addCollaborator(versionRepo, writer.username, 'write')
        await forgejo.addCollaborator(versionRepo, releaser.username, 'write')
        const versionSpace: SpaceConfig = {
          id: 'workflow-routes-versioning-space', name: 'Versioning Space', provider: 'forgejo',
          owner: versionRepo.owner, repo: versionRepo.repo, defaultLang: 'de', repoRef: versionRepo,
        }
        const versionApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [versionSpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await versionApp.ready()

        try {
          await provider.writeFile(
            versionRepo, '_meta/schema.yaml', 'versioning: true\n',
            { branch: 'main', message: 'seed: _meta/schema.yaml' },
          )

          const pageId = 'wf-versioning'
          const path = `${pageId}/index.md`
          await provider.writeFile(
            versionRepo, path,
            `---\nid: ${pageId}\ntitle: Versioning\nlang: de\n---\n# Versioning\n\nv1\n`,
            { branch: 'main', message: `seed: ${pageId}` },
          )
          await indexSpace({ db, provider }, versionSpace)

          // ---- First release: main has no version (implicit 0.1.0), major → 1.0.0. ----
          const draftRes = await versionApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }

          const saveRes = await versionApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: '# Versioning\n\nv2 (Versioning-Test)\n', baseSha },
          })
          expect(saveRes.statusCode).toBe(200)

          const reviewRes = await versionApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)

          const releaseRes = await versionApp.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'major', note: 'Erste Freigabe' },
          })
          expect(releaseRes.statusCode).toBe(200)
          const releaseBody = releaseRes.json() as { mergeSha: string; version?: string }
          expect(releaseBody.version).toBe('1.0.0')

          const mergedFile = await provider.readFile(versionRepo, path, 'main')
          expect(mergedFile.content).toContain('version: 1.0.0')
          expect(mergedFile.content).toContain('note: Erste Freigabe')
          expect(mergedFile.content).toContain('v2 (Versioning-Test)')

          const versionRows = await db
            .select()
            .from(pageVersions)
            .where(and(eq(pageVersions.pageId, pageId), eq(pageVersions.version, '1.0.0')))
          expect(versionRows).toHaveLength(1)
          const row = versionRows[0]!
          expect(row.mergeSha).toBe(releaseBody.mergeSha)
          // `blobSha` (Dateiinhalt-Hash) MUSS dem tatsächlichen Blob-SHA nach
          // dem Merge entsprechen — und darf NICHT mit `mergeSha` verwechselt
          // werden (Commit-SHA ≠ Blob-SHA, s. `db/schema.ts#pageVersions`-Kommentar).
          expect(row.blobSha).toBe(mergedFile.sha)
          expect(row.blobSha).not.toBe(row.mergeSha)
          expect(row.major).toBe(1)
          expect(row.minor).toBe(0)
          expect(row.patch).toBe(0)
          expect(row.author).toBe('Releaser')
          expect(row.note).toBe('Erste Freigabe')

          // ---- Zweite Freigabe: rechnet von main (1.0.0) weiter → 1.1.0. ----
          const draftRes2 = await versionApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes2.statusCode).toBe(200)
          const { baseSha: baseSha2 } = draftRes2.json() as { baseSha: string }

          const saveRes2 = await versionApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: {
              content: mergedFile.content.replace('v2 (Versioning-Test)', 'v3 (Versioning-Test)'),
              baseSha: baseSha2,
            },
          })
          expect(saveRes2.statusCode).toBe(200)

          const reviewRes2 = await versionApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes2.statusCode).toBe(200)

          const releaseRes2 = await versionApp.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'minor', note: 'Zweite Freigabe' },
          })
          expect(releaseRes2.statusCode).toBe(200)
          expect((releaseRes2.json() as { version?: string }).version).toBe('1.1.0')

          const mergedFile2 = await provider.readFile(versionRepo, path, 'main')
          // Changelog: neuester Eintrag zuerst, älterer bleibt erhalten.
          expect(mergedFile2.content.indexOf('Zweite Freigabe')).toBeLessThan(
            mergedFile2.content.indexOf('Erste Freigabe'),
          )

          const versionRows2 = await db
            .select()
            .from(pageVersions)
            .where(eq(pageVersions.pageId, pageId))
          // 0.1.0 (implicit starting state), 1.0.0, 1.1.0.
          expect(versionRows2.map((r) => r.version).sort()).toEqual(['0.1.0', '1.0.0', '1.1.0'])
        } finally {
          await versionApp.close()
        }
      },
      30_000,
    )

    it(
      'Implicit 0.1.0 (f451#50): first release of an existing page bumps from 0.1.0 (major → 1.0.0, '
        + 'minor → 0.2.0), writes [new, 0.1.0] and two page_versions rows; a new page stays at 1.0.0',
      async () => {
        const implicitRepo = await forgejo.createRepo('workflow-routes-versioning-implicit', { private: false })
        await forgejo.addCollaborator(implicitRepo, writer.username, 'write')
        await forgejo.addCollaborator(implicitRepo, releaser.username, 'write')
        const implicitSpace: SpaceConfig = {
          id: 'workflow-routes-versioning-implicit-space', name: 'Versioning Implicit Space', provider: 'forgejo',
          owner: implicitRepo.owner, repo: implicitRepo.repo, defaultLang: 'de', repoRef: implicitRepo,
        }
        const implicitApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [implicitSpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await implicitApp.ready()

        /** Draft → edit → review → release; returns the release response body. */
        async function releaseWith(pageId: string, path: string, bump: string, note: string) {
          const draftRes = await implicitApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }
          const before = await provider.readFile(implicitRepo, path, draftBranchName(pageId))
          const saveRes = await implicitApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: before.content.replace('v1', 'v2 (implicit)'), baseSha },
          })
          expect(saveRes.statusCode).toBe(200)
          const reviewRes = await implicitApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)
          const releaseRes = await implicitApp.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump, note },
          })
          expect(releaseRes.statusCode).toBe(200)
          return releaseRes.json() as { mergeSha: string; version?: string }
        }

        try {
          await provider.writeFile(
            implicitRepo, '_meta/schema.yaml', 'versioning: true\n',
            { branch: 'main', message: 'seed: _meta/schema.yaml' },
          )
          const seedExisting = async (pageId: string) => {
            const path = `${pageId}/index.md`
            await provider.writeFile(
              implicitRepo, path,
              `---\nid: ${pageId}\ntitle: ${pageId}\nlang: de\n---\n# ${pageId}\n\nv1\n`,
              { branch: 'main', message: `seed: ${pageId}` },
            )
            return path
          }
          const majorPath = await seedExisting('wf-implicit-major')
          const minorPath = await seedExisting('wf-implicit-minor')
          await indexSpace({ db, provider }, implicitSpace)

          // ---- Existing page, major → 1.0.0 ----
          const headBefore = await provider.getHeadSha(implicitRepo, 'main')
          const mainBefore = await provider.readFile(implicitRepo, majorPath, 'main')
          const majorBody = await releaseWith('wf-implicit-major', majorPath, 'major', 'First release')
          expect(majorBody.version).toBe('1.0.0')

          const mergedMajor = await provider.readFile(implicitRepo, majorPath, 'main')
          const changelog = parsePage(mergedMajor.content).frontmatter.changelog
          expect(changelog?.map((e) => e.version)).toEqual(['1.0.0', '0.1.0'])
          expect(changelog?.[1]?.note).toBe('Initial version')
          expect(changelog?.[1]?.ref).toBe(headBefore)

          const majorRows = await db
            .select()
            .from(pageVersions)
            .where(eq(pageVersions.pageId, 'wf-implicit-major'))
          const byVersion = Object.fromEntries(majorRows.map((r) => [r.version, r]))
          expect(Object.keys(byVersion).sort()).toEqual(['0.1.0', '1.0.0'])
          expect(byVersion['0.1.0']!.mergeSha).toBe(headBefore)
          expect(byVersion['0.1.0']!.blobSha).toBe(mainBefore.sha)
          expect(byVersion['0.1.0']!.note).toBe('Initial version')
          expect(byVersion['1.0.0']!.mergeSha).toBe(majorBody.mergeSha)

          // The starting state can be diffed against.
          const diffRes = await implicitApp.inject({
            method: 'GET', url: '/api/pages/wf-implicit-major/diff?from=0.1.0', cookies: cookiesOf(writerSession),
          })
          expect(diffRes.statusCode).toBe(200)
          expect(diffRes.json().to).toBe('1.0.0')
          expect(JSON.stringify(diffRes.json().diff)).toContain('v2 (implicit)')

          // After a database loss the reconstruction finds 0.1.0 through `ref`.
          await db.delete(pageVersions).where(eq(pageVersions.pageId, 'wf-implicit-major'))
          await reconstructPageVersions({ db, provider }, implicitSpace, { id: 'wf-implicit-major', path: majorPath })
          const rebuilt = await db
            .select()
            .from(pageVersions)
            .where(and(eq(pageVersions.pageId, 'wf-implicit-major'), eq(pageVersions.version, '0.1.0')))
          expect(rebuilt[0]?.mergeSha).toBe(headBefore)
          expect(rebuilt[0]?.blobSha).toBe(mainBefore.sha)

          // ---- Existing page, minor → 0.2.0 ----
          const minorBody = await releaseWith('wf-implicit-minor', minorPath, 'minor', 'Small step')
          expect(minorBody.version).toBe('0.2.0')
          const minorRows = await db
            .select()
            .from(pageVersions)
            .where(eq(pageVersions.pageId, 'wf-implicit-minor'))
          expect(minorRows.map((r) => r.version).sort()).toEqual(['0.1.0', '0.2.0'])

          // ---- New page (not on main): first release stays 1.0.0, one entry ----
          const createRes = await implicitApp.inject({
            method: 'POST',
            url: '/api/pages',
            cookies: cookiesOf(writerSession),
            payload: { space: implicitSpace.id, title: 'Implicit New Page' },
          })
          expect(createRes.statusCode).toBe(201)
          const created = createRes.json() as { id: string; content: string; baseSha: string }
          const [draftRow] = await db.select().from(pages).where(eq(pages.id, created.id))
          const newPath = draftRow!.path
          const putRes = await implicitApp.inject({
            method: 'PUT',
            url: `/api/pages/${encodeURIComponent(created.id)}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: `${created.content}\nNew page body\n`, baseSha: created.baseSha },
          })
          expect(putRes.statusCode).toBe(200)
          const newReview = await implicitApp.inject({
            method: 'POST',
            url: `/api/pages/${encodeURIComponent(created.id)}/review`,
            cookies: cookiesOf(writerSession),
            payload: {},
          })
          expect(newReview.statusCode).toBe(200)
          const newRelease = await implicitApp.inject({
            method: 'POST',
            url: `/api/pages/${encodeURIComponent(created.id)}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'minor', note: 'Brand new' },
          })
          expect(newRelease.statusCode).toBe(200)
          expect((newRelease.json() as { version?: string }).version).toBe('1.0.0')
          const mergedNew = await provider.readFile(implicitRepo, newPath, 'main')
          expect(parsePage(mergedNew.content).frontmatter.changelog?.map((e) => e.version)).toEqual(['1.0.0'])
          const newRows = await db.select().from(pageVersions).where(eq(pageVersions.pageId, created.id))
          expect(newRows.map((r) => r.version)).toEqual(['1.0.0'])
        } finally {
          await implicitApp.close()
        }
      },
      60_000,
    )

    it(
      'Befund 3 (Final-Review): `GET .../review` liefert `versioning`/`version` direkt mit — vor der '
        + 'ersten Freigabe die implizite 0.1.0 (implicitVersion), nach einer Freigabe zeigt es GENAU '
        + 'den main-Stand (kein zweiter Fetch auf `GET /api/pages/:id` mehr nötig, s. `review/page.tsx`)',
      async () => {
        // Eigenes Repo — wie bei den Szenarien oben, damit `versioning: true`
        // nicht mit anderen Tests im geteilten `workflow-routes`-Repo kollidiert.
        const b3Repo = await forgejo.createRepo('workflow-routes-versioning-b3', { private: false })
        await forgejo.addCollaborator(b3Repo, writer.username, 'write')
        await forgejo.addCollaborator(b3Repo, releaser.username, 'write')
        const b3Space: SpaceConfig = {
          id: 'workflow-routes-versioning-b3-space', name: 'Versioning B3 Space', provider: 'forgejo',
          owner: b3Repo.owner, repo: b3Repo.repo, defaultLang: 'de', repoRef: b3Repo,
        }
        const b3App = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [b3Space],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await b3App.ready()

        try {
          await provider.writeFile(
            b3Repo, '_meta/schema.yaml', 'versioning: true\n',
            { branch: 'main', message: 'seed: _meta/schema.yaml' },
          )

          const pageId = 'wf-review-version-b3'
          const path = `${pageId}/index.md`
          await provider.writeFile(
            b3Repo, path,
            `---\nid: ${pageId}\ntitle: Review Version B3\nlang: de\n---\n# Review Version B3\n\nv1\n`,
            { branch: 'main', message: `seed: ${pageId}` },
          )
          await indexSpace({ db, provider }, b3Space)

          // ---- Before the first release: existing page → implicit 0.1.0. ----
          const draftRes = await b3App.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }

          // Bewusst per `.replace()` auf dem GELESENEN Ausgangsinhalt statt eines
          // frontmatter-losen Literal-Strings (`before.content` behält
          // `id`/`title`/`lang` bei) — nur die Körper-Zeile ändert sich.
          const before = await provider.readFile(b3Repo, path, draftBranchName(pageId))
          const saveRes = await b3App.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: before.content.replace('v1', 'v2 (B3)'), baseSha },
          })
          expect(saveRes.statusCode).toBe(200)

          const reviewRes = await b3App.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)

          const getReviewResBefore = await b3App.inject({
            method: 'GET', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession),
          })
          expect(getReviewResBefore.statusCode).toBe(200)
          const bodyBefore = getReviewResBefore.json() as ReviewGetResult
          expect(bodyBefore.versioning).toBe(true)
          expect(bodyBefore.version).toBe('0.1.0')
          expect(bodyBefore.implicitVersion).toBe(true)

          const releaseRes = await b3App.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'major', note: 'Erste Freigabe B3' },
          })
          expect(releaseRes.statusCode).toBe(200)
          expect((releaseRes.json() as { version?: string }).version).toBe('1.0.0')

          // ---- Nach der ersten Freigabe: main trägt 1.0.0, GET /review zeigt es. ----
          const draftRes2 = await b3App.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes2.statusCode).toBe(200)
          const { baseSha: baseSha2 } = draftRes2.json() as { baseSha: string }

          const before2 = await provider.readFile(b3Repo, path, draftBranchName(pageId))
          const saveRes2 = await b3App.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: before2.content.replace('v2 (B3)', 'v3 (B3)'), baseSha: baseSha2 },
          })
          expect(saveRes2.statusCode).toBe(200)

          const reviewRes2 = await b3App.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes2.statusCode).toBe(200)

          const getReviewResAfter = await b3App.inject({
            method: 'GET', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession),
          })
          expect(getReviewResAfter.statusCode).toBe(200)
          const bodyAfter = getReviewResAfter.json() as ReviewGetResult
          expect(bodyAfter.versioning).toBe(true)
          expect(bodyAfter.version).toBe('1.0.0')
          expect(bodyAfter.implicitVersion).toBeUndefined()
        } finally {
          await b3App.close()
        }
      },
      30_000,
    )

    it(
      'Befund 4 (Final-Review): eine verwaiste `page_versions`-Zeile einer gelöschten, wieder- '
        + 'verwendeten Seiten-Id wird bei der Erstfreigabe der NEUEN Seite überschrieben, nicht still '
        + 'übersprungen (onConflictDoUpdate statt onConflictDoNothing)',
      async () => {
        // Eigenes Repo — wie bei den Szenarien oben, damit `versioning: true`
        // nicht mit anderen Tests im geteilten `workflow-routes`-Repo kollidiert.
        const orphanRepo = await forgejo.createRepo('workflow-routes-versioning-orphan', { private: false })
        await forgejo.addCollaborator(orphanRepo, writer.username, 'write')
        await forgejo.addCollaborator(orphanRepo, releaser.username, 'write')
        const orphanSpace: SpaceConfig = {
          id: 'workflow-routes-versioning-orphan-space', name: 'Versioning Orphan Space', provider: 'forgejo',
          owner: orphanRepo.owner, repo: orphanRepo.repo, defaultLang: 'de', repoRef: orphanRepo,
        }
        const orphanApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [orphanSpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await orphanApp.ready()

        try {
          await provider.writeFile(
            orphanRepo, '_meta/schema.yaml', 'versioning: true\n',
            { branch: 'main', message: 'seed: _meta/schema.yaml' },
          )

          const pageId = 'wf-orphan-version'
          const path = `${pageId}/index.md`
          await provider.writeFile(
            orphanRepo, path,
            `---\nid: ${pageId}\ntitle: Orphan Version\nlang: de\n---\n# Orphan Version\n\nv1\n`,
            { branch: 'main', message: `seed: ${pageId}` },
          )
          // `indexSpace` upsertet u. a. die `spaces`-Zeile (FK-Ziel für
          // `page_versions.spaceId`) — MUSS daher vor dem Insert unten laufen.
          await indexSpace({ db, provider }, orphanSpace)

          // `page_versions.pageId` hat KEINEN Fremdschlüssel auf `pages` (s.
          // `db/schema.ts`-Kommentar) — dieselbe stabile Id kann nach dem Löschen
          // einer Seite für eine GANZ ANDERE, neu angelegte Seite wiederverwendet
          // werden. Diese Zeile simuliert genau diesen verwaisten Altbestand: ein
          // `page_versions`-Eintrag `(pageId, '1.0.0')` von einer Seite, die es
          // längst nicht mehr gibt.
          await db.insert(pageVersions).values({
            pageId,
            spaceId: orphanSpace.id,
            version: '1.0.0',
            major: 1,
            minor: 0,
            patch: 0,
            mergeSha: 'stale-merge-sha-von-geloeschter-seite',
            blobSha: 'stale-blob-sha-von-geloeschter-seite',
            author: 'Geist der Vergangenheit',
            note: 'Freigabe der ALTEN, längst gelöschten Seite',
          })

          // Jetzt wird eine NEUE Seite mit GENAU DERSELBEN Id zum ersten Mal
          // freigegeben — main kennt noch keine Version (implicit 0.1.0), `major`
          // ergibt daher ebenfalls '1.0.0' und kollidiert mit der verwaisten Zeile oben.

          const draftRes = await orphanApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }

          const saveRes = await orphanApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: '# Orphan Version\n\nv2 (neue Seite, alte Id)\n', baseSha },
          })
          expect(saveRes.statusCode).toBe(200)

          const reviewRes = await orphanApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)

          const releaseRes = await orphanApp.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'major', note: 'Erstfreigabe der neuen Seite' },
          })
          expect(releaseRes.statusCode).toBe(200)
          const releaseBody = releaseRes.json() as { mergeSha: string; version?: string }
          expect(releaseBody.version).toBe('1.0.0')

          const mergedFile = await provider.readFile(orphanRepo, path, 'main')

          // GENAU EINE Zeile für `(pageId, '1.0.0')` — kein Duplikat, die
          // verwaiste Zeile wurde AKTUALISIERT statt eine zweite anzulegen (was
          // an der PK-Kollision ohnehin scheitern würde).
          const versionRows = await db
            .select()
            .from(pageVersions)
            .where(and(eq(pageVersions.pageId, pageId), eq(pageVersions.version, '1.0.0')))
          expect(versionRows).toHaveLength(1)
          const row = versionRows[0]!

          // Der entscheidende Befund-4-Check: die Zeile trägt jetzt die Daten
          // der NEUEN Freigabe — NICHT mehr die der alten, gelöschten Seite.
          // Vor dem Fix (`onConflictDoNothing`) wären hier weiterhin die
          // `stale-*`-Werte von oben stehengeblieben (stiller Verlust, die neue
          // Seite hätte fälschlich "geändert seit 1.0.0" gezeigt).
          expect(row.mergeSha).toBe(releaseBody.mergeSha)
          expect(row.blobSha).toBe(mergedFile.sha)
          expect(row.mergeSha).not.toBe('stale-merge-sha-von-geloeschter-seite')
          expect(row.blobSha).not.toBe('stale-blob-sha-von-geloeschter-seite')
          expect(row.author).toBe('Releaser')
          expect(row.note).toBe('Erstfreigabe der neuen Seite')
        } finally {
          await orphanApp.close()
        }
      },
      30_000,
    )

    it(
      'Seitenversionierung (Regressionstest Task 6 Fix): transienter Provider-Fehler '
        + 'beim Lesen von main während der Versionsberechnung darf NICHT still auf '
        + '`undefined` fallen (→ stiller Rücksprung auf 1.0.0) — die Freigabe muss '
        + 'sauber als 502 fehlschlagen, main bleibt unverändert, kein `page_versions`-Eintrag',
      async () => {
        // Eigenes Repo — wie beim Szenario oben, damit `versioning: true` nicht
        // mit anderen Tests im geteilten `workflow-routes`-Repo kollidiert.
        const flakyRepo = await forgejo.createRepo('workflow-routes-versioning-flaky', { private: false })
        await forgejo.addCollaborator(flakyRepo, writer.username, 'write')
        await forgejo.addCollaborator(flakyRepo, releaser.username, 'write')
        const flakySpace: SpaceConfig = {
          id: 'workflow-routes-versioning-flaky-space', name: 'Versioning Flaky Space', provider: 'forgejo',
          owner: flakyRepo.owner, repo: flakyRepo.repo, defaultLang: 'de', repoRef: flakyRepo,
        }

        const pageId = 'wf-versioning-flaky'
        const path = `${pageId}/index.md`

        // WICHTIG: Die Schreib-Routen (`resolveWriteContext` → `getUserProvider`,
        // `drafts/user-provider.ts`) bauen ihren eigenen `ForgejoProvider` aus dem
        // NUTZER-Token — NICHT aus `providerRegistry` (die ist nur der Lese-/
        // Service-Account-Pfad, s. `app.ts`-Kommentar bei dessen Verdrahtung).
        // Ein simulierter Fehler muss also auf `ForgejoProvider.prototype`
        // ansetzen, sonst trifft er den eigentlichen Release-Aufruf gar nicht.
        const flakyApp = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [flakySpace],
          providerRegistry: () => provider,
          forgejoBaseUrl: forgejo.baseUrl,
          auth: {
            tokenKey: TOKEN_KEY,
            insecureCookies: true,
            connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
          },
        })
        await flakyApp.ready()

        let spy: ReturnType<typeof vi.spyOn> | undefined
        try {
          await provider.writeFile(
            flakyRepo, '_meta/schema.yaml', 'versioning: true\n',
            { branch: 'main', message: 'seed: _meta/schema.yaml' },
          )

          // main trägt bereits eine Version — wie bei einer Seite, die schon
          // mehrfach freigegeben wurde. Genau in diesem Fall würde ein
          // verschlucktes `readFile(main)` die Version still auf 1.0.0
          // zurückspringen lassen (statt korrekt von 2.3.1 weiterzurechnen).
          await provider.writeFile(
            flakyRepo, path,
            `---\nid: ${pageId}\ntitle: Versioning Flaky\nlang: de\nversion: 2.3.1\n---\n`
              + '# Versioning Flaky\n\nv1\n',
            { branch: 'main', message: `seed: ${pageId}` },
          )
          // Indexierung MUSS VOR dem Patch laufen — sie liest main selbst
          // (s. `index-space.ts#readPageFileSafe`) und würde denselben Fehler
          // sonst als "transienter I/O-Fehler beim Indexieren" (F1) deuten und
          // die Seite komplett überspringen, statt den eigentlichen Bug in der
          // Release-Route zu prüfen.
          await indexSpace({ db, provider }, flakySpace)

          const draftRes = await flakyApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/draft`, cookies: cookiesOf(writerSession),
          })
          expect(draftRes.statusCode).toBe(200)
          const { baseSha } = draftRes.json() as { baseSha: string }

          const saveRes = await flakyApp.inject({
            method: 'PUT',
            url: `/api/pages/${pageId}/draft`,
            cookies: cookiesOf(writerSession),
            payload: { content: '# Versioning Flaky\n\nv2 (Flaky-Test)\n', baseSha },
          })
          expect(saveRes.statusCode).toBe(200)

          const reviewRes = await flakyApp.inject({
            method: 'POST', url: `/api/pages/${pageId}/review`, cookies: cookiesOf(writerSession), payload: {},
          })
          expect(reviewRes.statusCode).toBe(200)

          // Erst JETZT patchen — unmittelbar vor dem Release-Aufruf, der
          // einzigen Stelle im ganzen Ablauf, die `readFile(main)` für genau
          // diesen Seitenpfad aufruft (Draft-/Review-Schritte lesen nur den
          // Draft-Branch, s. `drafts/lifecycle.ts`). Wirkt auf `ForgejoProvider.
          // prototype` und damit global auf ALLE Instanzen des Prozesses
          // (inkl. des geteilten `provider` und der user-token-basierten
          // Instanz aus `getUserProvider`) — deshalb so eng wie möglich um den
          // Release-Aufruf gefasst und im `finally` sicher wiederhergestellt.
          const originalReadFile = ForgejoProvider.prototype.readFile
          let flakyReadFileCalls = 0
          spy = vi.spyOn(ForgejoProvider.prototype, 'readFile')
            .mockImplementation(function (this: ForgejoProvider, repoArg: RepoRef, filePath: string, ref: string) {
              if (repoArg.owner === flakyRepo.owner && repoArg.repo === flakyRepo.repo
                && filePath === path && ref === 'main') {
                flakyReadFileCalls += 1
                return Promise.reject(new ProviderError('Netzwerk-Timeout (simuliert, Test)', 503, ''))
              }
              return originalReadFile.call(this, repoArg, filePath, ref)
            })

          const releaseRes = await flakyApp.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/release`,
            cookies: cookiesOf(releaserSession),
            payload: { bump: 'minor', note: 'Freigabe trotz Netzwerk-Fehler' },
          })

          // Der simulierte Fehler MUSS gegriffen haben, sonst prüft dieser Test
          // gar nichts.
          expect(flakyReadFileCalls).toBeGreaterThan(0)

          // Der transiente Fehler MUSS die Freigabe sauber scheitern lassen
          // (502, wie jeder andere durchgereichte Provider-Fehler im Handler)
          // — NICHT mit 200 und einer stillen Version 1.0.0.
          expect(releaseRes.statusCode).toBe(502)
          const releaseBody = releaseRes.json() as { version?: string }
          expect(releaseBody.version).toBeUndefined()

          // Patch VOR den Nachprüfungen entfernen, damit die folgenden
          // `readFile`-Aufrufe (Verifikation) wieder gegen den echten Provider
          // laufen, nicht gegen den simulierten Fehler.
          spy.mockRestore()
          spy = undefined

          // main darf NICHT verändert worden sein — insbesondere NICHT auf
          // 1.0.0 zurückgesprungen sein (der eigentliche Bug).
          const mainFile = await provider.readFile(flakyRepo, path, 'main')
          expect(mainFile.content).toContain('version: 2.3.1')
          expect(mainFile.content).not.toContain('version: 1.0.0')

          // Der Voll-Reindex oben trägt 2.3.1 aus der Git-Historie nach
          // (Rekonstruktion, Seitenversionierung Etappe 2) — die gescheiterte
          // Freigabe selbst darf keinen weiteren Eintrag hinterlassen.
          const versionRows = await db
            .select()
            .from(pageVersions)
            .where(eq(pageVersions.pageId, pageId))
          expect(versionRows.map((r) => r.version)).toEqual(['2.3.1'])
        } finally {
          spy?.mockRestore()
          await flakyApp.close()
        }
      },
      30_000,
    )
  })

  describe('POST /api/pages/:id/review/request-changes', () => {
    it('kein offener PR → 409', async () => {
      await seedPage('wf-rc-no-pr', 'Kein PR', 'wf-rc-no-pr')
      await createDraft('wf-rc-no-pr', writerSession)
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-rc-no-pr/review/request-changes',
        cookies: cookiesOf(writerSession),
        payload: { comment: 'bitte anpassen' },
      })
      expect(res.statusCode).toBe(409)
      // Seeding + draft against the Forgejo container can exceed the 5 s default on CI.
    }, 15_000)

    it('eigener PR → Provider-Fehler als 422 durchgereicht', async () => {
      const path = await seedPage('wf-rc-self', 'Eigener PR', 'wf-rc-self')
      await createDraft('wf-rc-self', writerSession)
      await editDraft(app, 'wf-rc-self', path, writerSession)
      const reviewRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-rc-self/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(reviewRes.statusCode).toBe(200)

      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-rc-self/review/request-changes',
        cookies: cookiesOf(writerSession),
        payload: { comment: 'geht an mich selbst' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().error).toBeTruthy()
    }, 15_000)

    it('zweiter Nutzer fordert Änderungen an → 204', async () => {
      const path = await seedPage('wf-rc-other', 'Fremder Reviewer', 'wf-rc-other')
      await createDraft('wf-rc-other', writerSession)
      await editDraft(app, 'wf-rc-other', path, writerSession)
      const reviewRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-rc-other/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(reviewRes.statusCode).toBe(200)

      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-rc-other/review/request-changes',
        cookies: cookiesOf(releaserSession),
        payload: { comment: 'bitte Abschnitt 2 überarbeiten' },
      })
      expect(res.statusCode).toBe(204)
    }, 15_000)
  })

  describe('POST /api/pages/:id/draft/update', () => {
    it('kein Draft vorhanden → 404', async () => {
      await seedPage('wf-update-no-draft', 'Kein Entwurf', 'wf-update-no-draft')
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-update-no-draft/draft/update',
        cookies: cookiesOf(writerSession),
        payload: { strategy: 'take-main' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('Media-Dateien, die nur auf dem Draft-Branch liegen, lösen ein `warning`-Feld aus (kein stiller Verlust)', async () => {
      await seedPage('wf-update-media', 'Media-Verlust', 'wf-update-media')
      await createDraft('wf-update-media', writerSession)

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0x00])
      await provider.writeFileBinary(
        repo, 'wf-update-media/_media/bild.png', png,
        { branch: draftBranchName('wf-update-media'), message: 'draft: Bild hochladen' },
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-update-media/draft/update',
        cookies: cookiesOf(writerSession),
        payload: { strategy: 'take-main' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.warning).toBeTruthy()
      expect(body.warning).toContain('wf-update-media/_media/bild.png')
    }, 15_000)

    it('take-main: draft becomes == main and stays in working — no empty review is reopened (#11)', async () => {
      const path = await seedPage('wf-update-take', 'Take Main', 'wf-update-take')
      await createDraft('wf-update-take', writerSession)
      await editDraft(app, 'wf-update-take', path, writerSession)

      const reviewRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-update-take/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(reviewRes.statusCode).toBe(200)

      const updateRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-update-take/draft/update',
        cookies: cookiesOf(writerSession),
        payload: { strategy: 'take-main' },
      })
      expect(updateRes.statusCode).toBe(200)
      const body = updateRes.json()
      expect(body.state).toBe('working')
      expect(body.pr).toBeNull()
      expect(body.content).toContain('v1')

      const mainFile = await provider.readFile(repo, 'wf-update-take/index.md', 'main')
      expect(body.content).toBe(mainFile.content)
      expect(body.baseSha).toBe(mainFile.sha)
    }, 15_000)

    it('keep-mine: eigener Inhalt bleibt erhalten, ein zuvor offener PR wird neu eröffnet (mergeable true)', async () => {
      const path = await seedPage('wf-update-keep', 'Keep Mine', 'wf-update-keep')
      await createDraft('wf-update-keep', writerSession)

      const before = await provider.readFile(repo, path, draftBranchName('wf-update-keep'))
      const saveRes = await app.inject({
        method: 'PUT',
        url: '/api/pages/wf-update-keep/draft',
        cookies: cookiesOf(writerSession),
        payload: {
          content: before.content.replace('v1', 'eigene Änderung, die erhalten bleiben soll'),
          baseSha: before.sha,
        },
      })
      expect(saveRes.statusCode).toBe(200)

      const reviewRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-update-keep/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(reviewRes.statusCode).toBe(200)

      const updateRes = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-update-keep/draft/update',
        cookies: cookiesOf(writerSession),
        payload: { strategy: 'keep-mine' },
      })
      expect(updateRes.statusCode).toBe(200)
      const body = updateRes.json()
      expect(body.state).toBe('review')
      expect(body.pr.number).toBeGreaterThan(0)
      expect(body.content).toContain('eigene Änderung, die erhalten bleiben soll')

      // Der PR (ob wiederverwendet — Forgejo kann den durch die Branch-
      // Löschung geschlossenen PR bei einem erneuten Push auf den gleichnamig
      // neu angelegten Branch automatisch reaktivieren, beobachtetes Verhalten
      // dieser Forgejo-Version — oder frisch angelegt) landet am Ende offen
      // und mergebar: `POST /review` ist idempotent (dieselbe Find-or-Create-
      // Logik wie `POST /draft/update`s Neuanlage) und heilt einen eventuell
      // zwischenzeitlich geschlossenen Zustand selbst aus.
      const mergeable = await pollReviewMergeable('wf-update-keep', writerSession)
      expect(mergeable.state).toBe('review')
      expect(mergeable.mergeable).toBe(true)
    }, 30_000)
  })

  describe('POST /api/pages/:id/review — PR-Body mit Plattform-Link (Finding 2, Fix-Runde 1)', () => {
    /** Liest den ROHEN PR-Body direkt über die Forgejo-REST-API (das
     *  `GitProvider`-Interface bildet `PullRequestInfo.body` bewusst nicht ab,
     *  siehe `packages/git-provider/src/types.ts` — für diesen Test reicht ein
     *  einzelner Fetch mit dem Admin-Token der Testinstanz). */
    async function fetchPrBody(number: number): Promise<string> {
      const res = await fetch(`${forgejo.baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}/pulls/${number}`, {
        headers: { Authorization: `token ${forgejo.token}` },
      })
      expect(res.ok).toBe(true)
      const data = (await res.json()) as { body: string }
      return data.body
    }

    it('ohne konfigurierte publicBaseUrl bleibt der PR-Body linklos (Bestandsverhalten)', async () => {
      const path = await seedPage('wf-review-nolink', 'Ohne Link', 'wf-review-nolink')
      await createDraft('wf-review-nolink', writerSession)
      await editDraft(app, 'wf-review-nolink', path, writerSession)

      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/wf-review-nolink/review',
        cookies: cookiesOf(writerSession),
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const prBody = await fetchPrBody((res.json() as ReviewResult).number)
      expect(prBody).not.toMatch(/https?:\/\//)
    }, 15_000)

    it('mit konfigurierter publicBaseUrl enthält der PR-Body den Review-Link', async () => {
      const publicBaseUrl = 'https://f451.example.org'
      const appWithLink = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        forgejoBaseUrl: forgejo.baseUrl,
        publicBaseUrl,
        auth: {
          tokenKey: TOKEN_KEY,
          insecureCookies: true,
          connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
        },
      })
      await appWithLink.ready()

      try {
        const pageId = 'wf-review-link'
        const path = await seedPage(pageId, 'Mit Link', pageId)
        const draftRes = await appWithLink.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/draft`,
          cookies: cookiesOf(writerSession),
        })
        expect(draftRes.statusCode).toBe(200)
        await editDraft(appWithLink, pageId, path, writerSession)

        const reviewRes = await appWithLink.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/review`,
          cookies: cookiesOf(writerSession),
          payload: {},
        })
        expect(reviewRes.statusCode).toBe(200)

        const prBody = await fetchPrBody((reviewRes.json() as ReviewResult).number)
        const expectedLink = `${publicBaseUrl}/wiki/${encodeURIComponent(space.id)}/${encodeURIComponent(pageId)}/review`
        expect(prBody).toContain(expectedLink)
      } finally {
        await appWithLink.close()
      }
    }, 15_000)
  })
})
