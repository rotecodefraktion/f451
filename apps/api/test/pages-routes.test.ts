import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import type { GitProvider, PullRequestInfo } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { EMPTY_METADATA_SCHEMA } from '@f451/markdown'
import { registerPagesRoutes, resolveVersionFields, type PagesDeps } from '../src/routes/pages.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, pageVersions, spaces as spacesTable, users } from '../src/db/schema.js'
import { clearMetadataSchemaCache } from '../src/spaces/metadata-schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * `GET /api/pages/:id`: das `workflow`-Feld (Phase 2d Task 2, Plan Task 2
 * Interface) — Berechtigungs-Gate und Provider-Fehlerpfad isoliert von der
 * konkreten Permission-Implementierung, analog zu
 * `drafts-routes-permissions.test.ts`/`locks-routes.test.ts`: `PagesDeps`
 * bekommt `access`/`canWrite` gestubbt statt über echte Sessions/Provider-
 * Tokens zu gehen. `getWorkflowState` selbst (working/review/kein Draft nach
 * Merge) ist bereits gegen einen echten Forgejo-Container in
 * `drafts-lifecycle.test.ts` bewiesen — hier zählt nur, DASS/WANN das Feld
 * befüllt wird, nicht die Provider-Mechanik dahinter.
 */
describe.sequential('GET /api/pages/:id: workflow-Feld (Phase 2d Task 2)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'wf-space',
    name: 'Workflow Stub Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }
  const pageId = 'home'

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
      id: pageId, spaceId: space.id, path: 'index.md', ref: 'main', title: 'Home', lang: 'de',
      htmlRendered: '<h1>Home</h1>',
    })
    await db.insert(users).values([
      { id: 'alice', email: 'alice@test.local', displayName: 'Alice' },
    ])
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  const unexpected = (name: string) => (): never => {
    throw new Error(`Provider.${name}: im Test nicht erwartet`)
  }

  /** Meldet den Draft-Branch als vorhanden, ohne offenen PR → `state:'working'`. */
  function workingProvider(): GitProvider {
    return {
      readFile: unexpected('readFile'),
      readFileBinary: unexpected('readFileBinary'),
      writeFile: unexpected('writeFile'),
      writeFileBinary: unexpected('writeFileBinary'),
      listTree: unexpected('listTree'),
      async getHeadSha() {
        return 'a'.repeat(40)
      },
      createBranch: unexpected('createBranch'),
      deleteBranch: unexpected('deleteBranch'),
      listCommits: unexpected('listCommits'),
      createPullRequest: unexpected('createPullRequest'),
      getPullRequest: unexpected('getPullRequest'),
      async listPullRequests(): Promise<PullRequestInfo[]> {
        return []
      },
      requestReviewers: unexpected('requestReviewers'),
      submitPullRequestReview: unexpected('submitPullRequestReview'),
      mergePullRequest: unexpected('mergePullRequest'),
    }
  }

  /** Provider, dessen Methoden nie aufgerufen werden dürfen — beweist, dass
   *  ohne Schreibrecht/Session gar nicht erst probiert wird. */
  function unreachableProvider(): GitProvider {
    const fail = (): never => {
      throw new Error('GitProvider darf ohne Schreibrecht/Session nicht aufgerufen werden.')
    }
    return {
      readFile: fail, readFileBinary: fail, listTree: fail, getHeadSha: fail, writeFile: fail,
      writeFileBinary: fail, createBranch: fail, deleteBranch: fail, listCommits: fail,
      createPullRequest: fail, getPullRequest: fail, listPullRequests: fail,
      requestReviewers: fail, submitPullRequestReview: fail, mergePullRequest: fail,
    }
  }

  /** `getHeadSha` (Branch-Existenzprüfung) wirft einen Provider-Fehler — simuliert
   *  einen Ausfall des Git-Providers beim Zustandsermitteln. */
  function brokenProvider(): GitProvider {
    return {
      ...unreachableProvider(),
      async getHeadSha() {
        throw new Error('simulierter Provider-Ausfall')
      },
    }
  }

  function buildTestApp(deps: PagesDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    // Test-Stub statt echter Session (Muster drafts-routes-permissions.test.ts).
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerPagesRoutes(app, deps)
    return app
  }

  it('kein Auth-Wiring (access/canWrite fehlen) → workflow immer null, Provider nie berührt', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      providerRegistry: () => unreachableProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().workflow).toBeNull()
    await app.close()
  })

  it('Leser (canWrite=false) → workflow null, GitProvider wird nicht aufgerufen (kein Informationsleck)', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      providerRegistry: () => unreachableProvider(),
      access: { canRead: async () => true },
      canWrite: async () => false,
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}`,
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().workflow).toBeNull()
    await app.close()
  })

  it('Autor (canWrite=true) → workflow befüllt (state/pr/lock aus getWorkflowState + loadFreshLock)', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      providerRegistry: () => workingProvider(),
      access: { canRead: async () => true },
      canWrite: async () => true,
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}`,
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().workflow).toEqual({ state: 'working', pr: null, lock: null })
    await app.close()
  })

  it('Autor mit fremdem, frischem Lock → workflow.lock trägt user + mine:false', async () => {
    await db.insert(locks).values({ pageId, userId: 'alice', userName: 'Alice', heartbeatAt: new Date() })
    const app = buildTestApp({
      db,
      spaces: [space],
      providerRegistry: () => workingProvider(),
      access: { canRead: async () => true },
      canWrite: async () => true,
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}`,
      headers: { 'x-test-user': 'bob' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().workflow).toEqual({ state: 'working', pr: null, lock: { user: 'Alice', mine: false } })
    await db.delete(locks).where(eq(locks.pageId, pageId))
    await app.close()
  })

  it('Provider-Ausfall beim Zustandsermitteln → workflow null, Seite selbst bleibt 200 (Lesen fällt nie aus)', async () => {
    const app = buildTestApp({
      db,
      spaces: [space],
      providerRegistry: () => brokenProvider(),
      access: { canRead: async () => true },
      canWrite: async () => true,
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}`,
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.workflow).toBeNull()
    expect(body.id).toBe(pageId)
    expect(body.html).toBe('<h1>Home</h1>')
    await app.close()
  })

  it('unbekannter Space der Seite → workflow null, kein 500', async () => {
    await db.insert(pages).values({
      id: 'orphan', spaceId: space.id, path: 'orphan.md', ref: 'main', title: 'Orphan', lang: 'de',
    })
    const app = buildTestApp({
      db,
      // `spaces` bewusst leer — die Seite existiert im Index, aber ihr Space
      // ist nicht (mehr) konfiguriert.
      spaces: [],
      providerRegistry: () => unreachableProvider(),
      access: { canRead: async () => true },
      canWrite: async () => true,
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/api/pages/orphan',
      headers: { 'x-test-user': 'alice' },
    })
    // `deps.access` mit leerer `spaces`-Liste findet in registerPagesRoutes
    // selbst schon keinen Space → 404 (kein Existenz-Orakel), workflow spielt
    // dann keine Rolle mehr; dieser Test dokumentiert nur den Nicht-Crash.
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

/**
 * `GET /api/pages/:id`: Versionsanzeige (Seitenversionierung Etappe 1, Task
 * 8, Plan-Interface). Die Version steht im Frontmatter (Quelle der Wahrheit,
 * `PageFrontmatter.version`); `changedSinceRelease` vergleicht AUSSCHLIESSLICH
 * Blob-SHAs (`pages.lastBlobSha` gegen `page_versions.blobSha` der Version,
 * auf die das Frontmatter zeigt) — NICHT `page_versions.mergeSha` (Commit-SHA,
 * andere SHA-Art, wäre nie gleich `lastBlobSha`; diese Verwechslung war schon
 * zweimal ein Bug in diesem Feature, s. Task-Brief). `versioning` kommt aus
 * dem Space-Schema (`_meta/schema.yaml`, `MetadataSchema.versioning`,
 * `loadMetadataSchema`) — ist der Schalter aus, trägt die Antwort keine
 * Versionsfelder (`version` fehlt ganz, `changedSinceRelease` bleibt `false`).
 */
describe.sequential('GET /api/pages/:id: Versionsanzeige (Seitenversionierung Etappe 1, Task 8)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const versionedSpace: SpaceConfig = {
    id: 'version-space',
    name: 'Versioned Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }

  const unversionedSpace: SpaceConfig = {
    id: 'unversioned-space',
    name: 'Unversioned Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }

  const versioningSchemaYaml = 'versioning: true\n'

  /** Liefert `_meta/schema.yaml` mit `versioning: true` — alle anderen Provider-
   *  Aufrufe sind für diese Route (`GET /api/pages/:id`) unerwartet. */
  function versioningSchemaProvider(): GitProvider {
    const unexpected = (): never => {
      throw new Error('unerwarteter Provider-Aufruf in diesem Test')
    }
    return {
      readFile: async (_repo, path) => {
        if (path === '_meta/schema.yaml') return { path, content: versioningSchemaYaml, sha: 'stub-sha' }
        throw new NotFoundError(`nicht gefunden: ${path}`, '')
      },
      readFileBinary: unexpected, listTree: unexpected, getHeadSha: unexpected, writeFile: unexpected,
      writeFileBinary: unexpected, createBranch: unexpected, deleteBranch: unexpected, listCommits: unexpected,
      createPullRequest: unexpected, getPullRequest: unexpected, listPullRequests: unexpected,
      requestReviewers: unexpected, submitPullRequestReview: unexpected, mergePullRequest: unexpected,
    }
  }

  /** Kein `_meta/schema.yaml` im Repo (`NotFoundError`) → `loadMetadataSchema`
   *  fällt fail-soft auf `EMPTY_METADATA_SCHEMA` zurück (`versioning: false`). */
  function noSchemaProvider(): GitProvider {
    const unexpected = (): never => {
      throw new Error('unerwarteter Provider-Aufruf in diesem Test')
    }
    return {
      readFile: async (_repo, path) => {
        throw new NotFoundError(`nicht gefunden: ${path}`, '')
      },
      readFileBinary: unexpected, listTree: unexpected, getHeadSha: unexpected, writeFile: unexpected,
      writeFileBinary: unexpected, createBranch: unexpected, deleteBranch: unexpected, listCommits: unexpected,
      createPullRequest: unexpected, getPullRequest: unexpected, listPullRequests: unexpected,
      requestReviewers: unexpected, submitPullRequestReview: unexpected, mergePullRequest: unexpected,
    }
  }

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values([
      {
        id: versionedSpace.id, provider: versionedSpace.provider, owner: versionedSpace.owner,
        repo: versionedSpace.repo, name: versionedSpace.name, defaultLang: versionedSpace.defaultLang,
      },
      {
        id: unversionedSpace.id, provider: unversionedSpace.provider, owner: unversionedSpace.owner,
        repo: unversionedSpace.repo, name: unversionedSpace.name, defaultLang: unversionedSpace.defaultLang,
      },
    ])

    // Modul-globaler Cache (`spaces/metadata-schema.ts`) isoliert von anderen
    // Testdateien/Describe-Blöcken, die denselben Prozess/Worker teilen könnten.
    clearMetadataSchemaCache()

    // p-1: Seite steht (laut Frontmatter) auf Version 1.2.0 mit blobSha
    // 'blob-release'; der Index trägt aber bereits 'blob-direkt' als
    // lastBlobSha → seit der Freigabe wurde direkt committet.
    await db.insert(pages).values({
      id: 'p-1', spaceId: versionedSpace.id, path: 'p-1/index.md', ref: 'main', title: 'P1', lang: 'de',
      htmlRendered: '<h1>P1</h1>', lastBlobSha: 'blob-direkt',
      frontmatter: { tags: [], relations: {}, version: '1.2.0' },
    })
    await db.insert(pageVersions).values({
      pageId: 'p-1', spaceId: versionedSpace.id, version: '1.2.0', major: 1, minor: 2, patch: 0,
      mergeSha: 'a'.repeat(40), blobSha: 'blob-release', author: 'alice',
    })

    // p-2: lastBlobSha entspricht dem blobSha der neuesten Version → kein
    // Direkt-Commit seit der Freigabe.
    await db.insert(pages).values({
      id: 'p-2', spaceId: versionedSpace.id, path: 'p-2/index.md', ref: 'main', title: 'P2', lang: 'de',
      htmlRendered: '<h1>P2</h1>', lastBlobSha: 'blob-release',
      frontmatter: { tags: [], relations: {}, version: '1.2.0' },
    })
    await db.insert(pageVersions).values({
      pageId: 'p-2', spaceId: versionedSpace.id, version: '1.2.0', major: 1, minor: 2, patch: 0,
      mergeSha: 'b'.repeat(40), blobSha: 'blob-release', author: 'alice',
    })

    // p-3: unversionierter Space → versioning:false, keine Versionsfelder,
    // auch wenn das Frontmatter (theoretisch) eine version trüge.
    await db.insert(pages).values({
      id: 'p-3', spaceId: unversionedSpace.id, path: 'p-3/index.md', ref: 'main', title: 'P3', lang: 'de',
      htmlRendered: '<h1>P3</h1>', lastBlobSha: 'blob-irrelevant',
      frontmatter: { tags: [], relations: {}, version: '1.2.0' },
    })

    // p-4: Version bekannt, page_versions.blobSha bekannt, aber
    // pages.lastBlobSha fehlt (z. B. Seite nur per Voll-Reindex erfasst) →
    // changedSinceRelease MUSS false bleiben (nicht markieren, wenn nicht
    // BEIDE SHAs bekannt sind — sonst Falschaussage, s. Task-Brief).
    await db.insert(pages).values({
      id: 'p-4', spaceId: versionedSpace.id, path: 'p-4/index.md', ref: 'main', title: 'P4', lang: 'de',
      htmlRendered: '<h1>P4</h1>', lastBlobSha: null,
      frontmatter: { tags: [], relations: {}, version: '1.2.0' },
    })
    await db.insert(pageVersions).values({
      pageId: 'p-4', spaceId: versionedSpace.id, version: '1.2.0', major: 1, minor: 2, patch: 0,
      mergeSha: 'c'.repeat(40), blobSha: 'blob-release', author: 'alice',
    })

    // Implicit version (spec addendum 2026-10-02): pages on `main` without
    // `version`. p-5 in the versioned space, p-6 in the unversioned one, p-7
    // exists only as a draft.
    await db.insert(pages).values([
      {
        id: 'p-5', spaceId: versionedSpace.id, path: 'p-5/index.md', ref: 'main', title: 'P5', lang: 'de',
        htmlRendered: '<h1>P5</h1>', lastBlobSha: 'blob-p5', frontmatter: { tags: [], relations: {} },
      },
      {
        id: 'p-6', spaceId: unversionedSpace.id, path: 'p-6/index.md', ref: 'main', title: 'P6', lang: 'de',
        htmlRendered: '<h1>P6</h1>', frontmatter: { tags: [], relations: {} },
      },
      {
        id: 'p-7', spaceId: versionedSpace.id, path: 'p-7/index.md', ref: 'draft', title: 'P7', lang: 'de',
        htmlRendered: '<h1>P7</h1>', frontmatter: { tags: [], relations: {} },
      },
    ])
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  function buildTestApp(deps: PagesDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    registerPagesRoutes(app, deps)
    return app
  }

  it('meldet changedSinceRelease, wenn seit der Freigabe direkt committet wurde', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => versioningSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      version: '1.2.0',
      versioning: true,
      changedSinceRelease: true,
    })
    await app.close()
  })

  it('meldet changedSinceRelease false, wenn der Stand der Freigabe entspricht', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => versioningSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ version: '1.2.0', versioning: true, changedSinceRelease: false })
    await app.close()
  })

  it('liefert in unversionierten Spaces versioning false und keine Version', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => noSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-3' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ versioning: false, changedSinceRelease: false })
    expect(res.json().version).toBeUndefined()
    await app.close()
  })

  it('fehlt lastBlobSha (nur per Voll-Reindex erfasst), bleibt changedSinceRelease false', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => versioningSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-4' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ version: '1.2.0', versioning: true, changedSinceRelease: false })
    await app.close()
  })

  it('reports an existing page without version as implicit 0.1.0', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => versioningSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-5' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      version: '0.1.0',
      implicitVersion: true,
      versioning: true,
      changedSinceRelease: false,
    })
    await app.close()
  })

  it('reports no implicit version when versioning is off', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => noSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-6' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ versioning: false, changedSinceRelease: false })
    expect(res.json().version).toBeUndefined()
    expect(res.json().implicitVersion).toBeUndefined()
    await app.close()
  })

  it('leaves an explicit version untouched (no implicitVersion)', async () => {
    const app = buildTestApp({
      db,
      spaces: [versionedSpace, unversionedSpace],
      providerRegistry: () => versioningSchemaProvider(),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/p-2' })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe('1.2.0')
    expect(res.json().implicitVersion).toBeUndefined()
    await app.close()
  })

  it('reports no version for a draft-only page (resolveVersionFields)', async () => {
    // The review route passes the draft row for pages not yet on `main`.
    const [row] = await db.select().from(pages).where(eq(pages.id, 'p-7'))
    const fields = await resolveVersionFields({ db }, row!, { ...EMPTY_METADATA_SCHEMA, versioning: true })
    expect(fields).toEqual({ versioning: true, changedSinceRelease: false })
  })
})
