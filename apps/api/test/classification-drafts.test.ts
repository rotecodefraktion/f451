import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import type { Classification } from '@f451/markdown'
import { createClassificationGate } from '../src/auth/classification-gate.js'
import { createDb, type Db } from '../src/db/client.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { indexDraftPage } from '../src/drafts/save.js'
import { indexSpace } from '../src/indexer/index-space.js'
import { registerDraftsRoutes } from '../src/routes/drafts.js'
import { registerMediaRoutes } from '../src/routes/media.js'
import { registerWorkflowRoutes } from '../src/routes/workflow.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { clearMetadataSchemaCache } from '../src/spaces/metadata-schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { write } from './helpers/seed-space.js'

/**
 * F-04: routes that deliver draft content judge the stricter of main and
 * draft. `memo` is internal on main and its draft raises it to confidential;
 * `conf` is confidential on main and its draft lowers it to internal.
 */
describe.sequential('token limit on drafts', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  const page = (id: string, cls: Classification | null, body: string) =>
    `---\nid: ${id}\ntitle: ${id}\nlang: en\n${cls ? `classification: ${cls}\n` : ''}---\n# ${id}\n\n${body}\n`

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    clearMetadataSchemaCache()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('classified-drafts')
    await write(provider, repo, '_meta/schema.yaml', 'classification:\n  default: internal\n')
    await write(provider, repo, 'memo/index.md', page('memo', null, 'Weekly memo.'))
    await write(provider, repo, 'conf/index.md', page('conf', 'confidential', 'Team secrets.'))

    space = {
      id: 'classified-drafts',
      name: 'Classified drafts',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'en',
      repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    // Drafts written straight to the branch: no `ref='draft'` index row yet,
    // so the handlers' frontmatter check is what decides.
    const drafts = [
      ['memo', 'confidential', 'Draft secret.'],
      ['conf', 'internal', 'Downgraded draft.'],
    ] as const
    for (const [id, cls, body] of drafts) {
      const branch = draftBranchName(id)
      const path = `${id}/index.md`
      await provider.createBranch(repo, branch, 'main')
      const current = await provider.readFile(repo, path, branch)
      await provider.writeFile(repo, path, page(id, cls, body), { branch, message: 'draft', sha: current.sha })
    }
    await provider.writeFileBinary(repo, 'memo/_media/draft.png', Buffer.from('draft-png'), {
      branch: draftBranchName('memo'),
      message: 'm',
    })
    await provider.createPullRequest(repo, { head: draftBranchName('memo'), base: 'main', title: 'memo' })
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  /** Draft, workflow and media routes behind the gate; every request has a
   *  user, the token limit comes from a header (none = browser session). */
  function draftApp() {
    const a = Fastify()
    a.decorateRequest('user', null)
    a.decorateRequest('apiTokenMaxClassification', null)
    a.addHook('onRequest', async (req) => {
      req.user = { id: 'u1', email: 'u1@test.local', displayName: 'u1' }
      const limit = req.headers['x-limit']
      req.apiTokenMaxClassification = typeof limit === 'string' ? (limit as Classification) : null
    })
    a.addHook('preHandler', createClassificationGate({ db, spaces: [space], providerRegistry: () => provider }))
    const deps = {
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => provider,
    }
    registerDraftsRoutes(a, deps)
    registerWorkflowRoutes(a, deps)
    registerMediaRoutes(a, { ...deps, providerRegistry: () => provider })
    return a
  }

  it('draft above the token limit: /draft and /review answer 403', async () => {
    const a = draftApp()
    await a.ready()
    const headers = { 'x-limit': 'internal' }
    for (const [method, url] of [
      ['GET', '/api/pages/memo/draft'],
      ['POST', '/api/pages/memo/draft'],
      ['GET', '/api/pages/memo/review'],
    ] as const) {
      const res = await a.inject({ method, url, headers })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().reason).toBe('token_classification_limit')
    }
    await a.close()
  })

  it('draft within the token limit or a session: full access', async () => {
    const a = draftApp()
    await a.ready()
    for (const headers of [{ 'x-limit': 'confidential' }, {}]) {
      const draft = await a.inject({ method: 'GET', url: '/api/pages/memo/draft', headers })
      expect(draft.statusCode).toBe(200)
      expect(draft.json().content).toContain('Draft secret.')
      const review = await a.inject({ method: 'GET', url: '/api/pages/memo/review', headers })
      expect(review.statusCode).toBe(200)
    }
    await a.close()
  })

  it('indexed draft class guards routes that do not read the page (draft media)', async () => {
    const content = (await provider.readFile(repo, 'memo/index.md', draftBranchName('memo'))).content
    await indexDraftPage(db, space, 'memo', 'memo/index.md', content)
    const a = draftApp()
    await a.ready()
    const url = '/media/memo/draft.png?ref=draft'
    const over = await a.inject({ method: 'GET', url, headers: { 'x-limit': 'internal' } })
    expect(over.statusCode).toBe(403)
    expect(over.json().reason).toBe('token_classification_limit')
    expect((await a.inject({ method: 'GET', url, headers: { 'x-limit': 'confidential' } })).statusCode).toBe(200)
    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(200)
    await a.close()
  })

  it('draft class lower than main: main still decides', async () => {
    const content = (await provider.readFile(repo, 'conf/index.md', draftBranchName('conf'))).content
    await indexDraftPage(db, space, 'conf', 'conf/index.md', content)
    const a = draftApp()
    await a.ready()
    const over = await a.inject({ method: 'GET', url: '/api/pages/conf/draft', headers: { 'x-limit': 'internal' } })
    expect(over.statusCode).toBe(403)
    expect(over.json().reason).toBe('token_classification_limit')
    const within = await a.inject({ method: 'GET', url: '/api/pages/conf/draft', headers: { 'x-limit': 'confidential' } })
    expect(within.statusCode).toBe(200)
    expect(within.json().content).toContain('Downgraded draft.')
    await a.close()
  })
})
