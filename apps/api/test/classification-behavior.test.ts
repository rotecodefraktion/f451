import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import type { Classification } from '@f451/markdown'
import { buildApp } from '../src/app.js'
import { createClassificationGate } from '../src/auth/classification-gate.js'
import { createDb, type Db } from '../src/db/client.js'
import { indexSpace } from '../src/indexer/index-space.js'
import { registerBrokenLinksRoutes } from '../src/routes/broken-links.js'
import { registerGraphRoutes } from '../src/routes/graph.js'
import { registerMediaRoutes } from '../src/routes/media.js'
import { registerPagesRoutes } from '../src/routes/pages.js'
import { registerSearchRoutes } from '../src/routes/search.js'
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
    await write(provider, repo, 'open/index.md', page('open', null, 'Kernel notes. See [[strict]] and [[conf]]. Also [[missing-open]].'))
    await write(provider, repo, 'conf/index.md', page('conf', 'confidential', 'Kernel secrets for the team. See [[missing-conf]].'))
    await write(
      provider,
      repo,
      'strict/index.md',
      page('strict', 'strictly-confidential', 'Kernel crown jewels. See [[open]] and [[missing-strict]].'),
    )
    // Public page for the token-limit listings (F-03/F-05); links only to
    // `conf`, so it stays out of `open`'s depth-1 neighbourhood.
    await write(provider, repo, 'pub/index.md', page('pub', 'public', 'Public notes. See [[conf]] and [[missing-pub]].'))
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

    /** Minimal app: search, graph and broken links, the token limit from a header. */
    function listingApp() {
      const a = Fastify()
      a.decorateRequest('user', null)
      a.decorateRequest('apiTokenMaxClassification', null)
      a.addHook('onRequest', async (req) => {
        const limit = req.headers['x-limit']
        req.apiTokenMaxClassification = typeof limit === 'string' ? (limit as Classification) : null
      })
      const deps = { db, spaces: [space], providerRegistry: () => provider }
      registerSearchRoutes(a, { ...deps, rateLimit: { max: 1000, windowMs: 60_000 } })
      registerGraphRoutes(a, deps)
      registerBrokenLinksRoutes(a, deps)
      return a
    }

    type Hit = { id: string }
    type Graph = { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string; label: string }> }
    type Report = Array<{ pageId: string; entries: Array<{ rawTarget: string; label: string }> }>

    it('search (F-03): a page above the token limit is not a hit at all', async () => {
      const a = listingApp()
      await a.ready()
      const ids = async (headers: Record<string, string>) =>
        ((await a.inject({ method: 'GET', url: '/api/search?q=Kernel', headers })).json() as Hit[]).map((h) => h.id)

      const internal = await ids({ 'x-limit': 'internal' })
      expect(internal).toContain('open')
      expect(internal).not.toContain('conf')
      // Prefix probing must not reveal the page either.
      const probe = await a.inject({
        method: 'GET',
        url: '/api/search?q=Kernel%20secr&prefix=true',
        headers: { 'x-limit': 'internal' },
      })
      expect((probe.json() as Hit[]).map((h) => h.id)).not.toContain('conf')

      expect(await ids({ 'x-limit': 'confidential' })).toContain('conf')
      // Session (no token): unchanged — confidential listed, strictly confidential not.
      const session = await ids({})
      expect(session).toEqual(expect.arrayContaining(['open', 'conf']))
      expect(session).not.toContain('strict')
      await a.close()
    })

    it('space graph (F-05): no nodes or edges above the token limit or strictly confidential', async () => {
      const a = listingApp()
      await a.ready()
      const graph = async (headers: Record<string, string>) =>
        (await a.inject({ method: 'GET', url: '/api/spaces/classified/graph?types=link,relation,hierarchy,tag', headers })).json() as Graph

      const pub = await graph({ 'x-limit': 'public' })
      const pubIds = pub.nodes.map((n) => n.id)
      expect(pubIds).toContain('pub')
      for (const id of ['open', 'conf', 'strict']) expect(pubIds).not.toContain(id)
      expect(pub.edges.every((e) => pubIds.includes(e.from) && pubIds.includes(e.to))).toBe(true)

      // Session: strictly confidential hidden like in the page graph, the rest stays.
      const session = await graph({})
      const sessionIds = session.nodes.map((n) => n.id)
      expect(sessionIds).toEqual(expect.arrayContaining(['open', 'conf', 'pub']))
      expect(sessionIds).not.toContain('strict')
      expect(session.edges.some((e) => e.from === 'strict' || e.to === 'strict')).toBe(false)
      await a.close()
    })

    it('broken links (F-05): no entries from pages above the token limit or strictly confidential', async () => {
      const a = listingApp()
      await a.ready()
      const report = async (headers: Record<string, string>) =>
        a.inject({ method: 'GET', url: '/api/spaces/classified/broken-links', headers })

      const pub = await report({ 'x-limit': 'public' })
      expect(pub.statusCode).toBe(200)
      expect((pub.json() as Report).map((r) => r.pageId)).toEqual(['pub'])
      expect(pub.body).not.toContain('missing-conf')
      expect(pub.body).not.toContain('missing-strict')

      const session = await report({})
      const sessionIds = (session.json() as Report).map((r) => r.pageId)
      expect(sessionIds).toEqual(expect.arrayContaining(['open', 'conf', 'pub']))
      expect(sessionIds).not.toContain('strict')
      expect(session.body).not.toContain('missing-strict')
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
