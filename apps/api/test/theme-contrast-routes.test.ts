import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AA_THRESHOLDS, DEFAULT_THRESHOLDS } from '@f451/design-tokens'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { ConflictError, NotFoundError } from '@f451/git-provider'
import { registerThemeContrastRoutes, type ThemeContrastDeps } from '../src/routes/theme-contrast.js'
import { CONTRAST_CONFIG_PATH, invalidateContrastThresholds } from '../src/theme/contrast-config.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme, loadInstanceTheme } from '../src/theme/instance-theme.js'
import { invalidateAllSpaceThemes, loadSpaceTheme, SPACE_THEME_PATH } from '../src/theme/space-theme.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 4, unit 4.2 (contrast threshold routes). Plain Fastify with a stubbed
 * session (pattern `theme-routes.test.ts`): `x-test-user` sets `req.user`. One in-memory
 * repo store backs both the service-account registry and the users' providers, so a
 * write through a user's provider is visible to the next (cache-cleared) read.
 *
 * Users: `alice` has push right, `bob` is linked but may not push, `nolink` has no
 * linked provider account.
 */

const instanceConfig: InstanceConfig = {
  provider: 'forgejo',
  owner: 'f451',
  repo: 'instance',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'instance' },
}

const docs: SpaceConfig = {
  id: 'docs',
  name: 'Docs',
  provider: 'forgejo',
  owner: 'f451',
  repo: 'docs',
  defaultLang: 'de',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'docs' },
}

const noopLogger = { warn: () => {} }

interface Commit {
  op: 'write' | 'delete'
  repo: string
  path: string
  branch: string
  message: string
}

/** In-memory repos: files keyed by `<repo>:<path>`, every commit recorded, reads counted per path. */
function storeProvider() {
  const files = new Map<string, { content: string; sha: string }>()
  const commits: Commit[] = []
  const reads = new Map<string, number>()
  let seq = 0
  const key = (repo: RepoRef, path: string) => `${repo.repo}:${path}`
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the contrast routes`)
  }
  const provider: GitProvider = {
    async readFile(repo, path) {
      reads.set(key(repo, path), (reads.get(key(repo, path)) ?? 0) + 1)
      const file = files.get(key(repo, path))
      if (!file) throw new NotFoundError(path)
      return { path, content: file.content, sha: file.sha }
    },
    async writeFile(repo, path, content, opts) {
      const existing = files.get(key(repo, path))
      if (existing && opts.sha !== existing.sha) throw new ConflictError('sha mismatch')
      seq += 1
      files.set(key(repo, path), { content, sha: `sha-${seq}` })
      commits.push({ op: 'write', repo: repo.repo, path, branch: opts.branch, message: opts.message })
      return { commitSha: `c-${seq}` }
    },
    async deleteFile(repo, path, opts) {
      const existing = files.get(key(repo, path))
      if (!existing) throw new NotFoundError(path)
      if (opts.sha !== existing.sha) throw new ConflictError('sha mismatch')
      seq += 1
      files.delete(key(repo, path))
      commits.push({ op: 'delete', repo: repo.repo, path, branch: opts.branch, message: opts.message })
      return { commitSha: `c-${seq}` }
    },
    readFileBinary: fail('readFileBinary'),
    listTree: fail('listTree'),
    getHeadSha: fail('getHeadSha'),
    writeFileBinary: fail('writeFileBinary'),
    commitFiles: fail('commitFiles'),
    createBranch: fail('createBranch'),
    deleteBranch: fail('deleteBranch'),
    listCommits: fail('listCommits'),
    countCommitsAhead: fail('countCommitsAhead'),
    createPullRequest: fail('createPullRequest'),
    getPullRequest: fail('getPullRequest'),
    listPullRequests: fail('listPullRequests'),
    requestReviewers: fail('requestReviewers'),
    submitPullRequestReview: fail('submitPullRequestReview'),
    mergePullRequest: fail('mergePullRequest'),
  }
  return {
    provider,
    commits,
    file: (repo: string, path: string) => files.get(`${repo}:${path}`)?.content,
    put: (repo: string, path: string, content: string) => files.set(`${repo}:${path}`, { content, sha: 'seed' }),
    reads: (repo: string, path: string) => reads.get(`${repo}:${path}`) ?? 0,
  }
}

type Store = ReturnType<typeof storeProvider>

function appWith(store: Store, overrides: Partial<ThemeContrastDeps> = {}): FastifyInstance {
  const deps: ThemeContrastDeps = {
    providerRegistry: () => store.provider,
    instanceConfig,
    canWrite: async (userId, space) => {
      expect(space.repoRef).toEqual(instanceConfig.repoRef)
      return userId === 'alice'
    },
    getUserProvider: async (userId) => (userId === 'nolink' ? null : store.provider),
    ...overrides,
  }
  const app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    const userId = req.headers['x-test-user']
    req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
  })
  registerThemeContrastRoutes(app, deps)
  return app
}

describe('contrast threshold routes', () => {
  afterEach(() => {
    invalidateContrastThresholds()
    invalidateInstanceTheme()
    invalidateAllSpaceThemes()
  })

  it('GET without a file → defaults, source default, the AA reference', async () => {
    const app = appWith(storeProvider())
    const res = await app.inject({ method: 'GET', url: '/api/theme/contrast', headers: { 'x-test-user': 'bob' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      thresholds: DEFAULT_THRESHOLDS,
      defaults: DEFAULT_THRESHOLDS,
      aa: AA_THRESHOLDS,
      source: 'default',
      note: null,
      problems: [],
    })
    await app.close()
  })

  it('GET with a file → its values, source instance', async () => {
    const store = storeProvider()
    store.put('instance', CONTRAST_CONFIG_PATH, 'thresholds:\n  ui-text: 3.0\nnote: Q4\n')
    const app = appWith(store)
    const res = await app.inject({ method: 'GET', url: '/api/theme/contrast', headers: { 'x-test-user': 'bob' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().thresholds).toEqual({ ...DEFAULT_THRESHOLDS, shortText: 3 })
    expect(res.json().source).toBe('instance')
    expect(res.json().note).toBe('Q4')
    await app.close()
  })

  it('PUT with a value out of range → 422 threshold_out_of_range naming the key, nothing written', async () => {
    const store = storeProvider()
    const app = appWith(store)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers: { 'x-test-user': 'alice' },
      payload: { shortText: 1 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'threshold_out_of_range', key: 'shortText', min: 1.5, max: 7 })
    expect(store.commits).toEqual([])
    await app.close()
  })

  it('PUT with a numeric string → 422, no type coercion', async () => {
    const store = storeProvider()
    const app = appWith(store)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers: { 'x-test-user': 'alice' },
      payload: { nonText: '3.0' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'threshold_not_a_number', key: 'nonText' })
    await app.close()
  })

  it('PUT without push right → 403; without a linked account → 403 connect', async () => {
    const store = storeProvider()
    const app = appWith(store)
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers: { 'x-test-user': 'bob' },
      payload: { shortText: 3 },
    })
    expect(denied.statusCode).toBe(403)
    const unlinked = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers: { 'x-test-user': 'nolink' },
      payload: { shortText: 3 },
    })
    expect(unlinked.statusCode).toBe(403)
    expect(unlinked.json().action).toBe('connect')
    expect(store.commits).toEqual([])
    await app.close()
  })

  it('PUT without an instance config → 404', async () => {
    const app = appWith(storeProvider(), { instanceConfig: undefined })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers: { 'x-test-user': 'alice' },
      payload: { shortText: 3 },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PUT ok → writes the YAML to main, returns the new state and clears every theme cache', async () => {
    const store = storeProvider()
    const app = appWith(store)
    const headers = { 'x-test-user': 'alice' }

    // Prime all three caches.
    const before = await app.inject({ method: 'GET', url: '/api/theme/contrast', headers })
    expect(before.json().source).toBe('default')
    await loadInstanceTheme({ providerRegistry: () => store.provider, instanceConfig }, noopLogger)
    await loadSpaceTheme({ providerRegistry: () => store.provider }, docs, noopLogger)
    const contrastReads = store.reads('instance', CONTRAST_CONFIG_PATH)
    const instanceReads = store.reads('instance', INSTANCE_THEME_PATH)
    const spaceReads = store.reads('docs', SPACE_THEME_PATH)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers,
      payload: { shortText: 3, incidental: 2.5, note: 'Tints remixed in Q4' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      thresholds: { ...DEFAULT_THRESHOLDS, shortText: 3, incidental: 2.5 },
      source: 'instance',
      note: 'Tints remixed in Q4',
    })

    expect(store.commits).toEqual([
      { op: 'write', repo: 'instance', path: CONTRAST_CONFIG_PATH, branch: 'main', message: 'Contrast thresholds' },
    ])
    const written = store.file('instance', CONTRAST_CONFIG_PATH)!
    expect(written).toContain('ui-text: 3')
    expect(written).toContain('incidental: 2.5')
    expect(written).not.toContain('body-text')

    // The next read goes back to the repo (cache cleared) and sees the written file.
    const after = await app.inject({ method: 'GET', url: '/api/theme/contrast', headers })
    expect(after.json().thresholds).toEqual({ ...DEFAULT_THRESHOLDS, shortText: 3, incidental: 2.5 })
    expect(after.json().source).toBe('instance')
    expect(store.reads('instance', CONTRAST_CONFIG_PATH)).toBeGreaterThan(contrastReads)

    // The instance and space theme caches were emptied too.
    await loadInstanceTheme({ providerRegistry: () => store.provider, instanceConfig }, noopLogger)
    await loadSpaceTheme({ providerRegistry: () => store.provider }, docs, noopLogger)
    expect(store.reads('instance', INSTANCE_THEME_PATH)).toBe(instanceReads + 1)
    expect(store.reads('docs', SPACE_THEME_PATH)).toBe(spaceReads + 1)
    await app.close()
  })

  it('PUT over an existing file passes its sha (update, not create)', async () => {
    const store = storeProvider()
    store.put('instance', CONTRAST_CONFIG_PATH, 'thresholds:\n  ui-text: 3.0\n')
    const app = appWith(store)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme/contrast',
      headers: { 'x-test-user': 'alice' },
      payload: { shortText: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(store.file('instance', CONTRAST_CONFIG_PATH)).toContain('ui-text: 4')
    await app.close()
  })

  it('DELETE → removes the file, back to the defaults; without push right 403', async () => {
    const store = storeProvider()
    store.put('instance', CONTRAST_CONFIG_PATH, 'thresholds:\n  ui-text: 3.0\n')
    const app = appWith(store)

    const denied = await app.inject({ method: 'DELETE', url: '/api/theme/contrast', headers: { 'x-test-user': 'bob' } })
    expect(denied.statusCode).toBe(403)
    expect(store.file('instance', CONTRAST_CONFIG_PATH)).toBeDefined()

    const headers = { 'x-test-user': 'alice' }
    const primed = await app.inject({ method: 'GET', url: '/api/theme/contrast', headers })
    expect(primed.json().source).toBe('instance')

    const res = await app.inject({ method: 'DELETE', url: '/api/theme/contrast', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ thresholds: DEFAULT_THRESHOLDS, source: 'default' })
    expect(store.file('instance', CONTRAST_CONFIG_PATH)).toBeUndefined()
    expect(store.commits.map((c) => [c.op, c.branch])).toEqual([['delete', 'main']])

    const after = await app.inject({ method: 'GET', url: '/api/theme/contrast', headers })
    expect(after.json().source).toBe('default')
    await app.close()
  })

  it('DELETE without a file → 200 defaults, no commit', async () => {
    const store = storeProvider()
    const app = appWith(store)
    const res = await app.inject({ method: 'DELETE', url: '/api/theme/contrast', headers: { 'x-test-user': 'alice' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().source).toBe('default')
    expect(store.commits).toEqual([])
    await app.close()
  })
})
