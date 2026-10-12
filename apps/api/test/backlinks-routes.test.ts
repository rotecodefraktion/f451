import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { edges } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { seedFixtureSpace } from './helpers/seed-space.js'

interface BacklinksResponse {
  backlinks: Array<{ id: string; title: string; excerpts: string[] }>
}

describe.sequential('Backlinks API', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('backlinks-api')
    await seedFixtureSpace(provider, repo)
    space = { id: 'betrieb', name: 'Betrieb', provider: 'forgejo', owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo }
    await indexSpace({ db, provider }, space)
    app = buildApp({ databaseUrl: pg.connectionString, spaces: [space], providerRegistry: () => provider })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('lists a page that links here, with an excerpt of the surrounding text', async () => {
    // Fixture: index.md (home) says "Siehe [[betrieb/deployment]] und den fehlenden [[gibt-es-nicht]]."
    const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/backlinks' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as BacklinksResponse
    const home = body.backlinks.find((b) => b.id === 'home')
    expect(home).toBeDefined()
    expect(home!.title).toBe('Startseite')
    expect(home!.excerpts.length).toBeGreaterThanOrEqual(1)
    expect(home!.excerpts[0]).toContain('Siehe')
    // Only body links count: betrieb's depends_on relation and the hierarchy
    // edge to betrieb do not make betrieb a backlink of deployment.
    expect(body.backlinks.map((b) => b.id)).not.toContain('betrieb')
  })

  it('returns an empty list for a page without incoming links', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/archiviert/backlinks' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ backlinks: [] })
  })

  it('unknown page → 404 (no existence oracle)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/gibt-es-nicht/backlinks' })
    expect(res.statusCode).toBe(404)
    expect(res.json().status).toBe('not_found')
  })

  it('a link row with an empty context still lists its source, with no excerpts', async () => {
    // Fixture: deployment links to monitoring via a relative link.
    await db
      .update(edges)
      .set({ context: '' })
      .where(and(eq(edges.toPageId, 'monitoring'), eq(edges.ref, 'main'), eq(edges.type, 'link')))
    const res = await app.inject({ method: 'GET', url: '/api/pages/monitoring/backlinks' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as BacklinksResponse
    expect(body.backlinks).toEqual(expect.arrayContaining([{ id: 'deployment', title: 'Deployment', excerpts: [] }]))
  })

  it('keeps at most three distinct excerpts per source page', async () => {
    // The edges PK is (fromPageId, rawTarget, type, label): extra rows with
    // different rawTargets for the same source and target are allowed.
    const extra = ['Erster Zusatz.', 'Zweiter Zusatz.', 'Zweiter Zusatz.', 'Dritter Zusatz.', 'Vierter Zusatz.']
    await db.insert(edges).values(
      extra.map((context, i) => ({
        fromPageId: 'home',
        toPageId: 'deployment',
        rawTarget: `extra-${i}`,
        type: 'link',
        label: '',
        ref: 'main',
        context,
      })),
    )
    const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/backlinks' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as BacklinksResponse
    const homeEntries = body.backlinks.filter((b) => b.id === 'home')
    expect(homeEntries).toHaveLength(1)
    const excerpts = homeEntries[0]!.excerpts
    expect(excerpts).toHaveLength(3)
    expect(new Set(excerpts).size).toBe(3)
  })
})
