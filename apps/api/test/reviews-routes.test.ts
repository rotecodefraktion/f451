import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundError, type GitProvider, type PullRequestInfo } from '@f451/git-provider'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { registerReviewRoutes } from '../src/routes/reviews.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { clearMetadataSchemaCache, METADATA_SCHEMA_PATH } from '../src/spaces/metadata-schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Review overview (f451#131): `GET /api/spaces/:space/reviews`. Plain Fastify
 * with a stubbed session (`x-test-user`), stubbed read/write checks and a fake
 * provider that only answers `listPullRequests` and the schema read; the page
 * index lives in a real Postgres.
 */

interface ReviewsResponse {
  versioning: boolean
  reviews: Array<{
    id: string
    title: string
    path: string
    isNew: boolean
    lastAuthor: string | null
    updatedAt: string
    prNumber: number
    prUrl: string
  }>
}

const space: SpaceConfig = {
  id: 'ops',
  name: 'Ops',
  provider: 'forgejo',
  owner: 'f451',
  repo: 'ops',
  defaultLang: 'en',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'ops' },
}

/** Per user: may read the space, may write to it. */
const USERS: Record<string, { read: boolean; write: boolean }> = {
  alice: { read: true, write: true },
  bob: { read: true, write: false },
  mallory: { read: false, write: false },
}

const as = (user: string) => ({ 'x-test-user': user })

function pr(number: number, headBranch: string): PullRequestInfo {
  return {
    number,
    state: 'open',
    title: `PR ${number}`,
    headBranch,
    baseBranch: 'main',
    url: `https://git.example/f451/ops/pulls/${number}`,
    mergeable: null,
  }
}

/** Mutable per test: the open PRs, a provider failure, the schema file. */
const providerState: { prs: PullRequestInfo[]; failPrs: boolean; schemaYaml: string | null } = {
  prs: [],
  failPrs: false,
  schemaYaml: null,
}

function fakeProvider(): GitProvider {
  const unexpected = (name: string) => (): never => {
    throw new Error(`fakeProvider.${name}: not expected in the review routes`)
  }
  return {
    async readFile(_repo, path) {
      if (path === METADATA_SCHEMA_PATH && providerState.schemaYaml !== null) {
        return { path, content: providerState.schemaYaml, sha: 'sha-schema' }
      }
      throw new NotFoundError(path)
    },
    async listPullRequests(_repo, opts) {
      if (providerState.failPrs) throw new Error('provider down')
      expect(opts).toMatchObject({ base: 'main', state: 'open' })
      return providerState.prs
    },
    readFileBinary: unexpected('readFileBinary'),
    listTree: unexpected('listTree'),
    getHeadSha: unexpected('getHeadSha'),
    writeFile: unexpected('writeFile'),
    writeFileBinary: unexpected('writeFileBinary'),
    deleteFile: unexpected('deleteFile'),
    commitFiles: unexpected('commitFiles'),
    createBranch: unexpected('createBranch'),
    deleteBranch: unexpected('deleteBranch'),
    listCommits: unexpected('listCommits'),
    countCommitsAhead: unexpected('countCommitsAhead'),
    createPullRequest: unexpected('createPullRequest'),
    getPullRequest: unexpected('getPullRequest'),
    requestReviewers: unexpected('requestReviewers'),
    submitPullRequestReview: unexpected('submitPullRequestReview'),
    mergePullRequest: unexpected('mergePullRequest'),
  }
}

describe.sequential('GET /api/spaces/:space/reviews', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance

  const updated = new Date('2026-10-01T12:00:00.000Z')

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })
    await db.insert(pages).values([
      // alpha: released page with a draft under review → changed.
      { id: 'alpha', spaceId: space.id, path: 'ops/alpha.md', ref: 'main', title: 'Alpha', lang: 'en' },
      { id: 'alpha', spaceId: space.id, path: 'ops/alpha.md', ref: 'draft', title: 'Alpha v2', lang: 'en', lastAuthor: 'Alice', updatedAt: updated },
      // beta: new page under review (no main row).
      { id: 'beta', spaceId: space.id, path: 'guide/beta.md', ref: 'draft', title: 'Beta', lang: 'en', updatedAt: updated },
      // gamma: draft still being edited, no PR → not listed.
      { id: 'gamma', spaceId: space.id, path: 'guide/gamma.md', ref: 'draft', title: 'Gamma', lang: 'en' },
      // delta: released, no draft.
      { id: 'delta', spaceId: space.id, path: 'ops/delta.md', ref: 'main', title: 'Delta', lang: 'en' },
    ])

    const provider = fakeProvider()
    app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerReviewRoutes(app, {
      db,
      spaces: [space],
      providerRegistry: () => provider,
      access: { canRead: async (userId) => USERS[userId]?.read === true },
      canWrite: async (userId) => USERS[userId]?.write === true,
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  beforeEach(() => {
    clearMetadataSchemaCache()
    // Path order is beta, alpha; the provider returns them the other way round
    // plus a PR that belongs to no draft.
    providerState.prs = [pr(7, draftBranchName('alpha')), pr(3, 'feature/unrelated'), pr(9, draftBranchName('beta'))]
    providerState.failPrs = false
    providerState.schemaYaml = null
  })

  it('unknown space → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/nope/reviews', headers: as('alice') })
    expect(res.statusCode).toBe(404)
    expect(res.json().status).toBe('not_found')
  })

  it('no read access → the same 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('mallory') })
    expect(res.statusCode).toBe(404)
    expect(res.json().status).toBe('not_found')
  })

  it('read access without write access → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('bob') })
    expect(res.statusCode).toBe(403)
    expect(res.json().status).toBe('forbidden')
    expect(typeof res.json().reason).toBe('string')
  })

  it('lists only drafts with an open PR, sorted by path, with new/changed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('alice') })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ReviewsResponse
    expect(body.reviews.map((r) => r.id)).toEqual(['beta', 'alpha'])
    expect(body.reviews.find((r) => r.id === 'gamma')).toBeUndefined()

    const [beta, alpha] = body.reviews
    expect(beta).toEqual({
      id: 'beta',
      title: 'Beta',
      path: 'guide/beta.md',
      isNew: true,
      lastAuthor: null,
      updatedAt: updated.toISOString(),
      prNumber: 9,
      prUrl: 'https://git.example/f451/ops/pulls/9',
    })
    expect(alpha).toMatchObject({ id: 'alpha', title: 'Alpha v2', isNew: false, lastAuthor: 'Alice', prNumber: 7 })
  })

  it('versioning is false without a schema file', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('alice') })
    expect((res.json() as ReviewsResponse).versioning).toBe(false)
  })

  it('versioning reflects the space schema', async () => {
    providerState.schemaYaml = 'versioning: true\n'
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('alice') })
    expect(res.statusCode).toBe(200)
    expect((res.json() as ReviewsResponse).versioning).toBe(true)
  })

  it('no open PRs → empty list', async () => {
    providerState.prs = []
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('alice') })
    expect(res.statusCode).toBe(200)
    expect((res.json() as ReviewsResponse).reviews).toEqual([])
  })

  it('provider error while listing PRs → 502', async () => {
    providerState.failPrs = true
    const res = await app.inject({ method: 'GET', url: '/api/spaces/ops/reviews', headers: as('alice') })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ status: 'error' })
    expect(typeof res.json().reason).toBe('string')
  })
})
