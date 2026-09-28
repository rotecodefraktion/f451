import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ConflictError, NotFoundError, type GitProvider } from '@f451/git-provider'
import { registerDraftsRoutes, type DraftsDeps } from '../src/routes/drafts.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Draft-Routen: Berechtigungs-Gate-Vertrag isoliert von der konkreten
 * Permission-Implementierung (Phase 2a Task 2). `routes/drafts.ts` bekommt
 * `access`/`canWrite`/`getUserProvider` injiziert (siehe `DraftsDeps`) —
 * dieser Test stubbt sie direkt, statt über den echten, vollständig
 * token-basierten Lese-Gate aus Task 5 zu gehen (dort impliziert ein
 * erfolgreiches `canRead` immer ein vorhandenes Token, siehe
 * `drafts-routes.test.ts`-Kommentar bei "kein verknüpftes Konto" — der Zustand
 * "lesbar, aber ohne verknüpftes Konto" ist über die echte Kette nicht
 * erreichbar). So lässt sich der 403-mit-connect-Zweig aus dem Plan-Interface
 * dennoch deterministisch beweisen, ebenso die genaue Prüfreihenfolge
 * (404 Seite unbekannt → 404 kein Zugriff → 403 kein Konto → 403 kein
 * Schreibrecht → 200/204 Erfolg) ohne Forgejo-Container.
 */
describe.sequential('Draft-Routen: Berechtigungs-Gate-Vertrag (gestubbt, Phase 2a Task 2)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'stub-space',
    name: 'Stub Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }
  const pageId = 'home'
  const pagePath = 'index.md'

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })
    await db.insert(pages).values({
      id: pageId, spaceId: space.id, path: pagePath, ref: 'main', title: 'Home', lang: 'de',
    })
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  function shaOf(key: string, content: string): string {
    return createHash('sha1').update(`${key}:${content}`).digest('hex')
  }

  /** Minimaler In-Memory-GitProvider — deckt genau die Methoden ab, die
   *  `drafts/lifecycle.ts` aufruft (readFile/getHeadSha/createBranch/
   *  deleteBranch); alles andere wirft, falls unerwartet aufgerufen. */
  function fakeProvider(): GitProvider {
    const branches = new Map<string, string>([['main', '# Home\n\nv1\n']])
    const unexpected = (name: string) => (): never => {
      throw new Error(`fakeProvider.${name}: im Test nicht erwartet`)
    }
    return {
      async readFile(_repo, path, ref) {
        const content = branches.get(ref)
        if (content === undefined) throw new NotFoundError('nicht gefunden')
        return { path, content, sha: shaOf(ref, content) }
      },
      readFileBinary: unexpected('readFileBinary'),
      writeFileBinary: unexpected('writeFileBinary'),
      listTree: unexpected('listTree'),
      async getHeadSha(_repo, branch) {
        const content = branches.get(branch)
        if (content === undefined) throw new NotFoundError('nicht gefunden')
        return shaOf(branch, content)
      },
      async writeFile(_repo, _path, content, opts) {
        branches.set(opts.branch, content)
        return { commitSha: shaOf(opts.branch, content) }
      },
      async createBranch(_repo, name, fromBranch) {
        if (branches.has(name)) throw new ConflictError('existiert bereits')
        const src = branches.get(fromBranch)
        if (src === undefined) throw new NotFoundError('Quellbranch fehlt')
        branches.set(name, src)
      },
      async deleteBranch(_repo, name) {
        if (!branches.has(name)) throw new NotFoundError('nicht gefunden')
        branches.delete(name)
      },
      listCommits: unexpected('listCommits'),
      createPullRequest: unexpected('createPullRequest'),
      getPullRequest: unexpected('getPullRequest'),
      mergePullRequest: unexpected('mergePullRequest'),
    }
  }

  /** Provider für den frisch abgeleiteten Branch, dessen Seitendatei fehlt
   *  (Final-Review-Befund 1): `createBranch`/`getHeadSha` erfolgreich, aber
   *  `readFile` wirft IMMER `NotFoundError` — simuliert eine Seitendatei, die
   *  zwischen Index-Lookup und Zugriff aus main entfernt wurde. */
  function providerWithMissingPageFile(): GitProvider {
    const unexpected = (name: string) => (): never => {
      throw new Error(`providerWithMissingPageFile.${name}: im Test nicht erwartet`)
    }
    const heads = new Set(['main'])
    return {
      async readFile(): Promise<never> {
        throw new NotFoundError('Seitendatei fehlt auf dem Branch')
      },
      readFileBinary: unexpected('readFileBinary'),
      writeFileBinary: unexpected('writeFileBinary'),
      listTree: unexpected('listTree'),
      async getHeadSha(_repo, branch) {
        if (!heads.has(branch)) throw new NotFoundError('nicht gefunden')
        return 'a'.repeat(40)
      },
      writeFile: unexpected('writeFile'),
      async createBranch(_repo, name, fromBranch) {
        if (!heads.has(fromBranch)) throw new NotFoundError('Quellbranch fehlt')
        heads.add(name)
      },
      deleteBranch: unexpected('deleteBranch'),
      listCommits: unexpected('listCommits'),
      createPullRequest: unexpected('createPullRequest'),
      getPullRequest: unexpected('getPullRequest'),
      mergePullRequest: unexpected('mergePullRequest'),
    }
  }

  /** Provider, dessen Methoden bei Aufruf sofort werfen — für Fälle, die VOR
   *  jedem Git-Zugriff mit 403/404 enden müssen (beweist: kein Seiteneffekt). */
  function unreachableProvider(): GitProvider {
    const fail = (): never => {
      throw new Error('GitProvider darf für abgelehnte Anfragen nicht aufgerufen werden.')
    }
    return {
      readFile: fail, readFileBinary: fail, listTree: fail, getHeadSha: fail, writeFile: fail,
      writeFileBinary: fail,
      createBranch: fail, deleteBranch: fail, listCommits: fail, createPullRequest: fail,
      getPullRequest: fail, mergePullRequest: fail,
    }
  }

  function buildTestApp(deps: DraftsDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    // Test-Stub statt echter Session (auth/sessions.ts): Nutzer-Id kommt aus
    // einem Header — isoliert die Routen-Logik vollständig vom Session-Cookie-
    // Mechanismus (der 401-ohne-Session-Fall ist bereits über die echte App in
    // drafts-routes.test.ts abgedeckt).
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerDraftsRoutes(app, deps)
    return app
  }

  it('unbekannte Seite → 404, GitProvider wird nicht aufgerufen', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => unreachableProvider(),
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/does-not-exist/draft',
      headers: { 'x-test-user': 'u1' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('Space nicht lesbar (access.canRead=false) → 404, GitProvider wird nicht aufgerufen', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => false },
      canWrite: async () => true,
      getUserProvider: async () => unreachableProvider(),
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('lesbar, aber kein verknüpfter Provider (getUserProvider=null) → 403 mit action:"connect"', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => null,
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.action).toBe('connect')
    expect(body.error).toBeTruthy()
    await app.close()
  })

  it('verknüpfter Provider, aber kein Schreibrecht (canWrite=false) → 403 ohne action-Feld', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => false,
      getUserProvider: async () => unreachableProvider(),
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.action).toBeUndefined()
    expect(body.error).toBeTruthy()
    await app.close()
  })

  it('PUT ohne Schreibrecht (canWrite=false) → 403, GitProvider wird nicht aufgerufen', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => false,
      getUserProvider: async () => unreachableProvider(),
    })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
      payload: { content: 'egal', baseSha: 'egal' },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it(
    'POST /media ohne Schreibrecht (canWrite=false) → 403, GitProvider wird nicht aufgerufen (Gate-Kette ' +
      'wird mit resolveWriteContext geteilt — kein Multipart-Plugin nötig, weil die Ablehnung VOR req.file() greift)',
    async () => {
      const app = buildTestApp({
        db,
        spaces: [space],
        access: { canRead: async () => true },
        canWrite: async () => false,
        getUserProvider: async () => unreachableProvider(),
      })
      await app.ready()
      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/draft/media`,
        headers: { 'x-test-user': 'u1' },
      })
      expect(res.statusCode).toBe(403)
      await app.close()
  })

  it('PUT: Save-Konflikt (falscher baseSha) → 409 mit currentSha/currentContent, main-Route-Vertrag', async () => {
    const provider = fakeProvider()
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => provider,
    })
    await app.ready()

    const post = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(post.statusCode).toBe(200)
    const { baseSha } = post.json() as { baseSha: string }

    const conflictRes = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
      payload: { content: 'v2 (versucht)', baseSha: 'ganz-falscher-sha' },
    })
    expect(conflictRes.statusCode).toBe(409)
    const conflictBody = conflictRes.json()
    expect(conflictBody.error).toBeTruthy()
    expect(conflictBody.currentSha).toBe(baseSha)
    expect(conflictBody.currentContent).toBe('# Home\n\nv1\n')

    const okRes = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
      payload: { content: 'v2 (korrekt)', baseSha },
    })
    expect(okRes.statusCode).toBe(200)
    const okBody = okRes.json()
    expect(okBody.newSha).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof okBody.savedAt).toBe('string')

    await app.close()
  })

  it(
    'POST: Seitendatei fehlt auf frisch abgeleitetem Branch (readFile wirft NotFoundError) → 404, ' +
      'nicht 502 (Final-Review-Befund 1, gleiches Muster wie GET/PUT/DELETE)',
    async () => {
      const app = buildTestApp({
        db,
        spaces: [space],
        access: { canRead: async () => true },
        canWrite: async () => true,
        getUserProvider: async () => providerWithMissingPageFile(),
      })
      await app.ready()
      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/draft`,
        headers: { 'x-test-user': 'u1' },
      })
      expect(res.statusCode).toBe(404)
      const body = res.json()
      expect(body.status).toBe('not_found')
      await app.close()
    },
  )

  it('PUT ohne bestehenden Draft-Branch → 404 (kein stilles Anlegen)', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => fakeProvider(),
    })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
      payload: { content: 'egal', baseSha: 'egal' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('alle Gates bestanden: POST/GET/DELETE liefern den vollen Lifecycle (In-Memory-Provider)', async () => {
    // EINE Provider-Instanz für alle drei Aufrufe (nicht pro Aufruf neu) —
    // sonst verliert jeder Request den von einem vorherigen angelegten Branch,
    // weil der In-Memory-Zustand jedes Mal frisch wäre.
    const provider = fakeProvider()
    const app = buildTestApp({
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => provider,
    })
    await app.ready()

    const post = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(post.statusCode).toBe(200)
    expect(post.json()).toMatchObject({ branch: 'draft/home', content: '# Home\n\nv1\n', lock: null })

    const get = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toEqual(post.json())

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(del.statusCode).toBe(204)

    const getAfter = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      headers: { 'x-test-user': 'u1' },
    })
    expect(getAfter.statusCode).toBe(404)

    await app.close()
  })
})
