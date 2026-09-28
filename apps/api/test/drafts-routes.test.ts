import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 3).toString('base64')

/**
 * Draft-Routen `POST/GET/DELETE /api/pages/:id/draft` (Phase 2a Task 2) —
 * durchgehend über `buildApp`/`app.inject()` gegen echten Forgejo- und
 * PG-Container: Anlegen → existiert → idempotent → verwerfen → weg, sowie
 * die Berechtigungs-Gates (kein Konto, kein Schreibrecht, Space unsichtbar).
 */
describe.sequential('Draft-Routen: POST/GET/DELETE /api/pages/:id/draft (Phase 2a Task 2)', () => {
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
  const writerUserId = 'draft-writer'
  const readerUserId = 'draft-reader-only'
  const noAccountUserId = 'draft-no-account'

  let writerSession: string
  let readerSession: string
  let noAccountSession: string

  const pageId = 'home'
  const branch = draftBranchName(pageId)

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('draft-routes', { private: false })
    await provider.writeFile(repo, 'index.md', '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv1\n', {
      branch: 'main',
      message: 'seed',
    })

    const repoPrivate = await forgejo.createRepo('draft-routes-private', { private: true })
    await provider.writeFile(repoPrivate, 'index.md', '---\nid: geheim\ntitle: Geheim\nlang: de\n---\n# Geheim\n', {
      branch: 'main',
      message: 'seed',
    })

    space = {
      id: 'draft-routes-space', name: 'Draft Routes', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    privateSpace = {
      id: 'draft-routes-private-space', name: 'Draft Routes Private', provider: 'forgejo',
      owner: repoPrivate.owner, repo: repoPrivate.repo, defaultLang: 'de', repoRef: repoPrivate,
    }
    await indexSpace({ db, provider }, space)
    await indexSpace({ db, provider }, privateSpace)

    // writer: eigener Forgejo-Nutzer, als Collaborator MIT Schreibrecht auf
    // `space` eingetragen (kein Zugriff auf `privateSpace`).
    writer = await forgejo.createUser('draft-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    // reader: Collaborator MIT NUR Leserecht auf `space` (canRead true, canWrite false).
    reader = await forgejo.createUser('draft-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'reader@example.org', displayName: 'Reader' },
      { id: noAccountUserId, email: 'noacc@example.org', displayName: 'No Account' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

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
    noAccountSession = (await createSession(db, noAccountUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  it('unbekannte Seite → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/does-not-exist/draft',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })

  it('Seite in einem für den Nutzer unsichtbaren (privaten) Space → 404 (kein Existenz-Orakel)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/geheim/draft',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })

  it(
    'kein verknüpftes Konto → 404 (nicht 403): der Lese-Zugriffsprüfer (Task 5) ist bereits ' +
      'vollständig token-basiert (keine anonyme Leseprobe), daher scheitert bereits canRead — ' +
      'die 403-mit-connect-Antwort für "Konto lesend sichtbar, aber nicht verknüpft" wird isoliert ' +
      'mit gestubbten Deps in drafts-routes-permissions.test.ts geprüft (dort ist der Zustand ' +
      '"canRead=true, kein Provider" ohne den echten, token-gekoppelten Lese-Gate erreichbar)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/draft`,
        cookies: cookiesOf(noAccountSession),
      })
      expect(res.statusCode).toBe(404)
    },
  )

  it('verknüpftes Konto ohne Schreibrecht (Nur-Lese-Collaborator) → 403 ohne connect-Hinweis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(readerSession),
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it('GET vor der Anlage → 404 (kein Draft)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })

  it('POST legt den Draft-Branch an (git-sicherer Name) und liefert branch/baseSha/content/lock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.branch).toBe(branch)
    expect(body.content).toContain('v1')
    expect(body.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(body.lock).toBeNull()

    const head = await provider.getHeadSha(repo, branch)
    expect(head).toBeTruthy()
  })

  it('POST ist idempotent: zweiter Aufruf → 200 mit demselben Bestand', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual(first.json())
  })

  it('GET nach der Anlage → 200 mit demselben Stand', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().branch).toBe(branch)
  })

  it('PUT speichert den Autosave (echter Autor im Git-Log) und liefert newSha/savedAt', async () => {
    const before = await provider.readFile(repo, 'index.md', branch)

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
      payload: { content: '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv2 (Entwurf)\n', baseSha: before.sha },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.newSha).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof body.savedAt).toBe('string')

    const after = await provider.readFile(repo, 'index.md', branch)
    expect(after.content).toContain('v2 (Entwurf)')

    const commits = await provider.listCommits(repo, { ref: branch, path: 'index.md', limit: 1 })
    expect(commits[0]?.authorEmail).toBe(`${writer.username}@test.local`)
  })

  it('PUT mit veraltetem baseSha → 409 mit dem aktuellen Inhalt', async () => {
    const stale = await provider.readFile(repo, 'index.md', branch)

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
      payload: { content: 'v3 (versucht)', baseSha: '0000000000000000000000000000000000000000' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.currentSha).toBe(stale.sha)
    expect(body.currentContent).toBe(stale.content)
  })

  // Regressionstest (Task 4a-1, zentraler Error-Formatter): `baseSha` ist im
  // `saveDraftBodySchema` als `required` deklariert — ohne den zentralen
  // Error-Handler kollidiert Fastifys AJV-Fehlerbody mit dem deklarierten
  // `errorSchema` ({status,reason} required) → FST_ERR_FAILED_ERROR_
  // SERIALIZATION → 500 statt 400 (dokumentierter Live-Kandidat, Ledger 3b/3e).
  it('PUT ohne baseSha (AJV-Pflichtfeld fehlt) → 400 {status,reason}, nie 500', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
      payload: { content: 'v3 (ohne baseSha)' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
    expect(res.json().reason).toBeTruthy()
  })

  it(
    'Draft ist nach dem Save such- und auffindbar (ref=draft), NICHT in der main-Suche und NICHT in der Lese-API',
    async () => {
      const before = await provider.readFile(repo, 'index.md', branch)
      const saveRes = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft`,
        cookies: cookiesOf(writerSession),
        payload: {
          content: '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nEntwurfsinhaltsmarker\n',
          baseSha: before.sha,
        },
      })
      expect(saveRes.statusCode).toBe(200)

      const draftSearch = await app.inject({
        method: 'GET',
        url: '/api/search?q=Entwurfsinhaltsmarker&ref=draft',
        cookies: cookiesOf(writerSession),
      })
      expect(draftSearch.statusCode).toBe(200)
      const draftHits = draftSearch.json() as Array<{ id: string }>
      expect(draftHits.some((h) => h.id === pageId)).toBe(true)

      // Default (main) findet denselben Suchbegriff NICHT — er existiert nur im Draft.
      const mainSearch = await app.inject({
        method: 'GET',
        url: '/api/search?q=Entwurfsinhaltsmarker',
        cookies: cookiesOf(writerSession),
      })
      expect(mainSearch.statusCode).toBe(200)
      expect((mainSearch.json() as unknown[]).length).toBe(0)

      // Lese-API (main-only) zeigt weiterhin den alten Stand, nicht den Draft-Inhalt.
      const pageRes = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}`,
        cookies: cookiesOf(writerSession),
      })
      expect(pageRes.statusCode).toBe(200)
      expect(pageRes.json().html).not.toContain('Entwurfsinhaltsmarker')
    },
  )

  it(
    'Draft-Suche (ref=draft) filtert nach canWrite, NICHT nach canRead (Fix Review-Befund 2): der ' +
      'Nur-Lese-Collaborator (reader) sieht den Space, darf aber nicht schreiben und bekommt deshalb ' +
      'KEINEN Treffer aus dem Draft-Index, obwohl der Inhalt (aus dem vorigen Test) dort steht',
    async () => {
      const readerDraftSearch = await app.inject({
        method: 'GET',
        url: '/api/search?q=Entwurfsinhaltsmarker&ref=draft',
        cookies: cookiesOf(readerSession),
      })
      expect(readerDraftSearch.statusCode).toBe(200)
      expect(readerDraftSearch.json()).toEqual([])

      // Schreibberechtigter (writer) bekommt weiterhin den Treffer.
      const writerDraftSearch = await app.inject({
        method: 'GET',
        url: '/api/search?q=Entwurfsinhaltsmarker&ref=draft',
        cookies: cookiesOf(writerSession),
      })
      expect(writerDraftSearch.statusCode).toBe(200)
      const writerHits = writerDraftSearch.json() as Array<{ id: string }>
      expect(writerHits.some((h) => h.id === pageId)).toBe(true)
    },
  )

  it('PUT ohne Schreibrecht (Nur-Lese-Collaborator) → 403, Draft bleibt unverändert', async () => {
    const before = await provider.readFile(repo, 'index.md', branch)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(readerSession),
      payload: { content: 'sollte nicht ankommen', baseSha: before.sha },
    })
    expect(res.statusCode).toBe(403)
    const after = await provider.readFile(repo, 'index.md', branch)
    expect(after.sha).toBe(before.sha)
  })

  it('GET ohne Schreibrecht (Nur-Lese-Collaborator) → 403, obwohl ein Draft existiert', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(readerSession),
    })
    expect(res.statusCode).toBe(403)
  })

  it('DELETE ohne Schreibrecht → 403 (Draft bleibt bestehen)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(readerSession),
    })
    expect(res.statusCode).toBe(403)

    const still = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(still.statusCode).toBe(200)
  })

  it('DELETE verwirft den Draft: Branch weg, danach GET → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(204)

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(getRes.statusCode).toBe(404)

    await expect(provider.getHeadSha(repo, branch)).rejects.toThrow()
  })

  it('DELETE ohne bestehenden Draft → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })

  it('ohne Session → 401 (Schutz-Matrix, unverändert)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft` })
    expect(res.statusCode).toBe(401)
  })

  it(
    'Draft-only-Seite (noch nie released, per POST /api/pages angelegt) durchläuft GET/PUT draft über ' +
      'denselben resolveWriteContext-Draft-only-Fallback wie eine bereits released Seite (Phase 2d Task 5 ' +
      'Regressionstest — es gibt für diese Seite KEINE ref=main-Zeile)',
    async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: cookiesOf(writerSession),
        payload: { space: space.id, title: 'Draft-only Regression' },
      })
      expect(createRes.statusCode).toBe(201)
      const created = createRes.json() as { id: string; content: string; baseSha: string }
      const idPath = encodeURIComponent(created.id)

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/pages/${idPath}/draft`,
        cookies: cookiesOf(writerSession),
      })
      expect(getRes.statusCode).toBe(200)
      expect(getRes.json().content).toBe(created.content)

      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/pages/${idPath}/draft`,
        cookies: cookiesOf(writerSession),
        payload: { content: `${created.content}\nAutosave auf Draft-only-Seite\n`, baseSha: created.baseSha },
      })
      expect(putRes.statusCode).toBe(200)

      // Gate-Kette gilt unverändert auch für Draft-only-Seiten: Nur-Lese-
      // Collaborator bekommt weiterhin 403, nicht fälschlich 404 ("unbekannte Seite").
      const forbiddenRes = await app.inject({
        method: 'GET',
        url: `/api/pages/${idPath}/draft`,
        cookies: cookiesOf(readerSession),
      })
      expect(forbiddenRes.statusCode).toBe(403)
    },
  )
})
