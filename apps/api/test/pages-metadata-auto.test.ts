import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { registerPagesRoutes, type PagesDeps } from '../src/routes/pages.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import { clearMetadataSchemaCache } from '../src/spaces/metadata-schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Metadaten-Feature M3b Teil A: End-zu-Ende-Test für `GET /api/pages/:id` MIT
 * einem Space-Schema, das `type: auto`-Felder deklariert — im Unterschied zu
 * `pages-metadata-field.test.ts` (Provider bewusst unreachable, deckt den
 * "kein Auto-Feld konfiguriert"-Fall ab) liefert der Fake-Provider hier ein
 * echtes `_meta/schema.yaml`. Reiner Fake statt Forgejo-Container: die Route
 * braucht vom Provider nur `readFile(repo, '_meta/schema.yaml', 'main')`
 * (`spaces/metadata-schema.ts#loadMetadataSchema`) — alles andere bleibt ein
 * nie aufgerufener Stub.
 */
describe.sequential('GET /api/pages/:id: Auto-Feld-Ableitung (Metadaten-Feature M3b Teil A)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'meta-auto-space',
    name: 'Meta Auto Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }

  const schemaYaml = `
fields:
  - key: process_id
    label: Process ID
    type: text
  - key: last_author
    label: Last author
    type: auto
    source: last_author
  - key: last_updated
    label: Last updated
    type: auto
    source: last_updated
`

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })

    // Modul-globaler Cache (`spaces/metadata-schema.ts`) isoliert von anderen
    // Testdateien, die denselben Prozess/Worker teilen könnten.
    clearMetadataSchemaCache()
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

  /** Liefert IMMER `schemaYaml` für `_meta/schema.yaml`, wirft für jeden
   *  anderen Pfad (die Route braucht nichts anderes vom Provider). */
  function schemaProvider(): GitProvider {
    const unexpected = (): never => {
      throw new Error('unerwarteter Provider-Aufruf in diesem Test')
    }
    return {
      readFile: async (_repo, path) => {
        if (path === '_meta/schema.yaml') return { path, content: schemaYaml, sha: 'stub-sha' }
        throw new NotFoundError(`nicht gefunden: ${path}`, 404, '')
      },
      readFileBinary: unexpected, listTree: unexpected, getHeadSha: unexpected, writeFile: unexpected,
      writeFileBinary: unexpected, createBranch: unexpected, deleteBranch: unexpected, listCommits: unexpected,
      createPullRequest: unexpected, getPullRequest: unexpected, listPullRequests: unexpected,
      requestReviewers: unexpected, submitPullRequestReview: unexpected, mergePullRequest: unexpected,
    }
  }

  it('last_updated wird IMMER aus pages.updatedAt gesetzt, last_author aus pages.lastAuthor', async () => {
    const updatedAt = new Date('2026-07-16T09:30:00.000Z')
    await db.insert(pages).values({
      id: 'auto-1', spaceId: space.id, path: 'auto-1/index.md', ref: 'main',
      title: 'Auto 1', lang: 'de', htmlRendered: '<h1>Auto 1</h1>', updatedAt,
      lastAuthor: 'bob',
      frontmatter: {
        tags: [], relations: {},
        metadata: { process_id: 'SAP-P-0001', last_author: 'veralteter-wert-aus-datei' },
      },
    })

    const app = buildTestApp({ db, spaces: [space], providerRegistry: schemaProvider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/auto-1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metadata.process_id).toBe('SAP-P-0001')
    expect(body.metadata.last_author).toBe('bob')
    expect(body.metadata.last_updated).toBe(updatedAt.toISOString())
    await app.close()
  })

  it('pages.lastAuthor unbekannt (null), aber Frontmatter hat einen Altwert → Altwert bleibt erhalten', async () => {
    const updatedAt = new Date('2026-07-10T08:00:00.000Z')
    await db.insert(pages).values({
      id: 'auto-2', spaceId: space.id, path: 'auto-2/index.md', ref: 'main',
      title: 'Auto 2', lang: 'de', htmlRendered: '<h1>Auto 2</h1>', updatedAt,
      lastAuthor: null,
      frontmatter: { tags: [], relations: {}, metadata: { last_author: 'alter-wert-blieb-erhalten' } },
    })

    const app = buildTestApp({ db, spaces: [space], providerRegistry: schemaProvider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/auto-2' })
    expect(res.statusCode).toBe(200)
    expect(res.json().metadata.last_author).toBe('alter-wert-blieb-erhalten')
    expect(res.json().metadata.last_updated).toBe(updatedAt.toISOString())
    await app.close()
  })

  it('pages.lastAuthor unbekannt (null) UND kein Frontmatter-Altwert → last_author fehlt im Objekt', async () => {
    const updatedAt = new Date('2026-07-10T08:00:00.000Z')
    await db.insert(pages).values({
      id: 'auto-3', spaceId: space.id, path: 'auto-3/index.md', ref: 'main',
      title: 'Auto 3', lang: 'de', htmlRendered: '<h1>Auto 3</h1>', updatedAt,
      lastAuthor: null,
      frontmatter: { tags: [], relations: {} },
    })

    const app = buildTestApp({ db, spaces: [space], providerRegistry: schemaProvider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/auto-3' })
    expect(res.statusCode).toBe(200)
    expect('last_author' in res.json().metadata).toBe(false)
    expect(res.json().metadata.last_updated).toBe(updatedAt.toISOString())
    await app.close()
  })
})
