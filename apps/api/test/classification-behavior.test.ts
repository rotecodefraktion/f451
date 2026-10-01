import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import type { Classification } from '@f451/markdown'
import { buildApp } from '../src/app.js'
import { createClassificationGate } from '../src/auth/classification-gate.js'
import { createDb, type Db } from '../src/db/client.js'
import { indexSpace } from '../src/indexer/index-space.js'
import { registerMediaRoutes } from '../src/routes/media.js'
import { registerPagesRoutes } from '../src/routes/pages.js'
import { registerVersionRoutes } from '../src/routes/versions.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { clearMetadataSchemaCache } from '../src/spaces/metadata-schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { write } from './helpers/seed-space.js'

/** Security classifications, part 2 (#39): search, graph and token limit. */
describe.sequential('classification behaviour', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: ReturnType<typeof buildApp>

  const page = (id: string, cls: Classification | null, body: string) =>
    `---\nid: ${id}\ntitle: ${id}\nlang: en\n${cls ? `classification: ${cls}\n` : ''}---\n# ${id}\n\n${body}\n`

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    clearMetadataSchemaCache()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('classified')
    await write(provider, repo, '_meta/schema.yaml', 'classification:\n  default: internal\n')
    await write(provider, repo, 'open/index.md', page('open', null, 'Kernel notes. See [[strict]] and [[conf]].'))
    await write(provider, repo, 'conf/index.md', page('conf', 'confidential', 'Kernel secrets for the team.'))
    await write(provider, repo, 'strict/index.md', page('strict', 'strictly-confidential', 'Kernel crown jewels. See [[open]].'))
    await provider.writeFileBinary(repo, 'conf/_media/plan.png', Buffer.from('conf-png'), { branch: 'main', message: 'm' })
    // A frozen release of `open` from a time it was still confidential.
    await write(
      provider,
      repo,
      'open/_releases/1.0.0/page.md',
      '---\ntitle: open\nclassification: confidential\nrelease:\n  version: 1.0.0\n  date: 2026-09-01\n  by: Jane\n  source: open\n---\n# open\n\nOld secret\n',
    )
    await provider.writeFileBinary(repo, 'open/_releases/1.0.0/_media/old.png', Buffer.from('old'), { branch: 'main', message: 'm' })

    space = {
      id: 'classified',
      name: 'Classified',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'en',
      repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    app = buildApp({ databaseUrl: pg.connectionString, spaces: [space], providerRegistry: () => provider })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('search: strictly confidential never appears, confidential without snippet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=Kernel' })
    expect(res.statusCode).toBe(200)
    const hits = res.json() as Array<{ id: string; snippet: string; classification?: string }>
    const byId = new Map(hits.map((h) => [h.id, h]))
    expect(byId.has('strict')).toBe(false)
    expect(byId.get('conf')).toMatchObject({ snippet: '', classification: 'confidential' })
    expect(byId.get('open')!.snippet).not.toBe('')
    expect(byId.get('open')!.classification).toBe('internal')
  })

  it('graph: strictly confidential page is not a neighbour of others, keeps its own graph', async () => {
    const fromOpen = (await app.inject({ method: 'GET', url: '/api/pages/open/graph?depth=1' })).json() as {
      nodes: Array<{ id: string }>
    }
    expect(fromOpen.nodes.map((n) => n.id).sort()).toEqual(['conf', 'open'])

    const fromStrict = (await app.inject({ method: 'GET', url: '/api/pages/strict/graph?depth=1' })).json() as {
      nodes: Array<{ id: string }>
    }
    expect(fromStrict.nodes.map((n) => n.id)).toContain('strict')
  })

  it('page response carries the effective class', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/open' })
    expect(res.json()).toMatchObject({
      classification: 'internal',
      classificationSettings: { default: 'internal', max: 'strictly-confidential' },
    })
  })

  describe('token limit', () => {
    /** Minimal app: pages routes + the gate, the token limit from a header. */
    function tokenApp() {
      const a = Fastify()
      a.decorateRequest('user', null)
      a.decorateRequest('apiTokenMaxClassification', null)
      a.addHook('onRequest', async (req) => {
        const limit = req.headers['x-limit']
        req.apiTokenMaxClassification = typeof limit === 'string' ? (limit as Classification) : null
      })
      a.addHook('preHandler', createClassificationGate({ db, spaces: [space], providerRegistry: () => provider }))
      registerPagesRoutes(a, { db, spaces: [space], providerRegistry: () => provider })
      registerMediaRoutes(a, { db, spaces: [space], providerRegistry: () => provider })
      registerVersionRoutes(a, { db, spaces: [space], providerRegistry: () => provider })
      a.post('/api/pages/:id/draft', async () => ({ ok: true }))
      return a
    }

    it('over the limit: page is restricted, other page routes 403', async () => {
      const a = tokenApp()
      await a.ready()
      const page = await a.inject({ method: 'GET', url: '/api/pages/conf', headers: { 'x-limit': 'internal' } })
      expect(page.statusCode).toBe(200)
      expect(page.json()).toMatchObject({ restricted: true, html: '', title: 'conf', classification: 'confidential' })

      const raw = await a.inject({ method: 'GET', url: '/api/pages/conf/raw', headers: { 'x-limit': 'internal' } })
      expect(raw.statusCode).toBe(403)
      expect(raw.json().reason).toBe('token_classification_limit')

      const write = await a.inject({ method: 'POST', url: '/api/pages/conf/draft', headers: { 'x-limit': 'internal' } })
      expect(write.statusCode).toBe(403)
      await a.close()
    })

    it('attachments and frozen copies follow the stricter class', async () => {
      const a = tokenApp()
      await a.ready()
      const h = { 'x-limit': 'internal' }
      expect((await a.inject({ method: 'GET', url: '/media/conf/plan.png', headers: h })).statusCode).toBe(403)
      expect((await a.inject({ method: 'GET', url: '/media/conf/plan.png' })).statusCode).toBe(200)
      // `open` is internal today, its frozen 1.0.0 was confidential.
      expect((await a.inject({ method: 'GET', url: '/api/pages/open/releases/1.0.0', headers: h })).statusCode).toBe(403)
      expect((await a.inject({ method: 'GET', url: '/media/open/old.png?release=1.0.0', headers: h })).statusCode).toBe(403)
      const ok = await a.inject({ method: 'GET', url: '/api/pages/open/releases/1.0.0', headers: { 'x-limit': 'confidential' } })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().html).toContain('Old secret')
      await a.close()
    })

    it('within the limit or without a token: full access', async () => {
      const a = tokenApp()
      await a.ready()
      const within = await a.inject({ method: 'GET', url: '/api/pages/conf', headers: { 'x-limit': 'confidential' } })
      expect(within.json().restricted).toBeUndefined()
      expect(within.json().html).not.toBe('')

      const session = await a.inject({ method: 'GET', url: '/api/pages/conf/raw' })
      expect(session.statusCode).toBe(200)

      const draft = await a.inject({ method: 'POST', url: '/api/pages/open/draft', headers: { 'x-limit': 'internal' } })
      expect(draft.statusCode).toBe(200)
      await a.close()
    })
  })
})
