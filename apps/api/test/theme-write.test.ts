import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { registerThemeRoutes, type ThemeDeps } from '../src/routes/theme.js'
import { invalidateContrastThresholds } from '../src/theme/contrast-config.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { invalidateAllSpaceThemes, SPACE_THEME_PATH } from '../src/theme/space-theme.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 4, unit 4.1 (theme write path). Plain Fastify with a stubbed
 * session (`x-test-user`), access check and push-right flag per user (pattern
 * `theme-routes.test.ts`). One in-memory repo store backs both the service
 * registry (read path) and the per-user providers (write path), so a GET after
 * a write sees what the write committed. The service provider refuses to write:
 * a commit through it would mean the route bypassed the caller's own token.
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

/** Per user: may read the `docs` space, and `permissions.push` on the repos. */
const USERS: Record<string, { read: boolean; push: boolean }> = {
  alice: { read: true, push: true },
  bob: { read: true, push: false },
  mallory: { read: false, push: false },
}

interface Call {
  op: 'write' | 'delete'
  user: string
  repo: string
  path: string
  content?: string
  branch: string
  message: string
  sha?: string
}

type Store = Map<string, { content: string; sha: string }>

const fileKey = (repo: RepoRef, path: string) => `${repo.repo}:${path}`

/** `user` = whose token the provider carries; `null` = the service account (read only). */
function fakeProvider(store: Store, calls: Call[], user: string | null): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the theme write routes`)
  }
  const nextSha = () => `sha-${calls.length + 1}`
  return {
    async readFile(repo, path) {
      const file = store.get(fileKey(repo, path))
      if (!file) throw new NotFoundError(path)
      return { path, content: file.content, sha: file.sha }
    },
    async writeFile(repo, path, content, opts) {
      if (user === null) throw new Error('the service account must not write a theme')
      const sha = nextSha()
      calls.push({ op: 'write', user, repo: repo.repo, path, content, ...opts })
      store.set(fileKey(repo, path), { content, sha })
      return { commitSha: `commit-${sha}` }
    },
    async deleteFile(repo, path, opts) {
      if (user === null) throw new Error('the service account must not delete a theme')
      if (!store.has(fileKey(repo, path))) throw new NotFoundError(path)
      calls.push({ op: 'delete', user, repo: repo.repo, path, ...opts })
      store.delete(fileKey(repo, path))
      return { commitSha: 'commit-delete' }
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
}

/** Initial files: `instance` → instance `_meta/theme.yaml`, `docs` → space `_meta/theme.yaml`. */
function setup(files: { instance?: string; docs?: string } = {}, opts: { instanceConfig?: InstanceConfig | null } = {}) {
  const store: Store = new Map()
  if (files.instance !== undefined) store.set(`instance:${INSTANCE_THEME_PATH}`, { content: files.instance, sha: 'sha-0' })
  if (files.docs !== undefined) store.set(`docs:${SPACE_THEME_PATH}`, { content: files.docs, sha: 'sha-0' })
  const calls: Call[] = []
  const service = fakeProvider(store, calls, null)

  const deps: ThemeDeps = {
    providerRegistry: () => service,
    instanceConfig: opts.instanceConfig === null ? undefined : (opts.instanceConfig ?? instanceConfig),
    spaces: [docs],
    access: { canRead: async (userId) => USERS[userId]?.read === true },
    canWrite: async (userId) => USERS[userId]?.push === true,
    getUserProvider: async (userId) => (USERS[userId] ? fakeProvider(store, calls, userId) : null),
  }

  const app: FastifyInstance = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    const userId = req.headers['x-test-user']
    req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
  })
  registerThemeRoutes(app, deps)
  return { app, store, calls }
}

const as = (user: string) => ({ 'x-test-user': user })

describe('theme write routes', () => {
  afterEach(() => {
    invalidateInstanceTheme()
    invalidateAllSpaceThemes()
    invalidateContrastThresholds()
  })

  it('PUT without push right → 403, nothing committed (instance and space)', async () => {
    const { app, calls } = setup()
    const body = { light: { 'color-accent': '#0b5fa5' } }
    const instance = await app.inject({ method: 'PUT', url: '/api/theme', headers: as('bob'), payload: body })
    const space = await app.inject({ method: 'PUT', url: '/api/spaces/docs/theme', headers: as('bob'), payload: body })
    expect(instance.statusCode).toBe(403)
    expect(space.statusCode).toBe(403)
    expect(calls).toEqual([])
    await app.close()
  })

  it('PUT/DELETE on an unknown or unreadable space → the same 404', async () => {
    const { app, calls } = setup({ docs: 'name: x\n' })
    const body = { name: 'x' }
    const unknown = await app.inject({ method: 'PUT', url: '/api/spaces/nope/theme', headers: as('alice'), payload: body })
    const denied = await app.inject({ method: 'PUT', url: '/api/spaces/docs/theme', headers: as('mallory'), payload: body })
    const deniedDelete = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/theme', headers: as('mallory') })
    for (const res of [unknown, denied, deniedDelete]) {
      expect(res.statusCode).toBe(404)
      expect(res.json().status).toBe('not_found')
    }
    expect(calls).toEqual([])
    await app.close()
  })

  it('PUT /api/theme without an instance config → 404', async () => {
    const { app } = setup({}, { instanceConfig: null })
    const res = await app.inject({ method: 'PUT', url: '/api/theme', headers: as('alice'), payload: { name: 'x' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().status).toBe('not_found')
    await app.close()
  })

  it('a locked token (measure-full) → 422 token_locked naming the token', async () => {
    const { app, calls } = setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme',
      headers: as('alice'),
      payload: { base: { 'measure-full': '90%' } },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.status).toBe('invalid')
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].code).toBe('token_locked')
    expect(body.errors[0].token).toBe('--measure-full')
    expect(calls).toEqual([])
    await app.close()
  })

  it('an unknown top-level key (thresholds) → 422 key_unknown on write', async () => {
    const { app, calls } = setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme',
      headers: as('alice'),
      payload: { thresholds: { 'body-text': 3 } },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().errors.map((e: { code: string }) => e.code)).toEqual(['key_unknown'])
    expect(calls).toEqual([])
    await app.close()
  })

  // Review Focus 5 asks for `measure-wide` below an inherited `measure`. The catalog's
  // corridors make that unreachable (`--measure` 60–80ch, `--measure-wide` 80–120ch), so
  // the same property — a rule broken only through an inherited value, named with its
  // layer — is shown with the weight-gap rule.
  it('a rule broken only through the inherited instance value → 422 naming both tokens and layers', async () => {
    const { app, calls } = setup({ instance: 'base:\n  weight-text: 600\n' })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/spaces/docs/theme',
      headers: as('alice'),
      payload: { base: { 'weight-strong': '680' } },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.status).toBe('invalid')
    expect(body.rules).toHaveLength(1)
    const [violation] = body.rules
    expect(violation.rule).toBe('weight-gap')
    expect(violation.tokens).toEqual(
      expect.arrayContaining([
        { token: '--weight-text', value: '600', source: 'instance' },
        { token: '--weight-strong', value: '680', source: 'space' },
      ]),
    )
    expect(violation.message).toContain('--weight-text 600 (instance)')
    expect(violation.message).toContain('--weight-strong 680 (space)')
    expect(calls).toEqual([])
    await app.close()
  })

  it('the same space file passes when the instance sets a value the rule accepts', async () => {
    const { app, calls } = setup({ instance: 'base:\n  weight-text: 400\n' })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/spaces/docs/theme',
      headers: as('alice'),
      payload: { base: { 'weight-strong': '680' } },
    })
    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(1)
    await app.close()
  })

  it('a too-light accent on the default background → 422 contrast with the failing findings', async () => {
    const { app, calls } = setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/theme',
      headers: as('alice'),
      payload: { light: { 'color-accent': '#dddddd' } },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.status).toBe('contrast')
    expect(body.contrast.length).toBeGreaterThan(0)
    for (const finding of body.contrast) {
      expect(finding.belowThreshold).toBe(true)
      expect(finding.mode).toBe('light')
    }
    expect(
      body.contrast.some(
        (f: { pair: { vorn: string; hinten: string } }) =>
          f.pair.vorn.includes('--color-accent') || f.pair.hinten.includes('--color-accent'),
      ),
    ).toBe(true)
    expect(calls).toEqual([])
    await app.close()
  })

  it('a valid PUT /api/theme commits YAML with the user token and the next GET shows it at once', async () => {
    const { app, calls } = setup({ instance: 'name: Old\n' })
    // Warm the 5-minute cache with the old state, so the GET below proves the invalidation.
    const before = await app.inject({ method: 'GET', url: '/api/theme' })
    expect(before.json().file).toEqual({ name: 'Old' })

    const file = { name: 'House', base: { 'weight-text': '400' }, light: { 'color-accent': '#0b5fa5' } }
    const res = await app.inject({ method: 'PUT', url: '/api/theme', headers: as('alice'), payload: file })
    expect(res.statusCode).toBe(200)
    expect(res.json().origin).toBe('instance')
    expect(res.json().file).toEqual(file)
    expect(res.json().layer.light).toEqual({ '--color-accent': '#0b5fa5' })

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call).toMatchObject({
      op: 'write',
      user: 'alice',
      repo: 'instance',
      path: INSTANCE_THEME_PATH,
      branch: 'main',
      message: 'Theme: House',
      sha: 'sha-0',
    })
    expect(parseYaml(call!.content!)).toEqual(file)

    const after = await app.inject({ method: 'GET', url: '/api/theme' })
    expect(after.json().file).toEqual(file)
    await app.close()
  })

  it('a valid PUT on a space without a name → commit message "Theme: update", GET shows it', async () => {
    const { app, calls } = setup()
    const file = { light: { 'color-accent': '#aa3300' } }
    const res = await app.inject({ method: 'PUT', url: '/api/spaces/docs/theme', headers: as('alice'), payload: file })
    expect(res.statusCode).toBe(200)
    expect(res.json().origin).toBe('space')
    expect(calls[0]).toMatchObject({ op: 'write', repo: 'docs', path: SPACE_THEME_PATH, message: 'Theme: update' })
    expect(calls[0]!.sha).toBeUndefined()
    expect(parseYaml(calls[0]!.content!)).toEqual(file)

    const after = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme', headers: as('alice') })
    expect(after.json().file).toEqual(file)
    await app.close()
  })

  it('DELETE /api/theme → 204, the next GET shows no theme, a second DELETE → 404', async () => {
    const { app, calls } = setup({ instance: 'name: House\n' })
    expect((await app.inject({ method: 'GET', url: '/api/theme' })).json().file).toEqual({ name: 'House' })

    const res = await app.inject({ method: 'DELETE', url: '/api/theme', headers: as('alice') })
    expect(res.statusCode).toBe(204)
    expect(calls).toEqual([
      { op: 'delete', user: 'alice', repo: 'instance', path: INSTANCE_THEME_PATH, branch: 'main', message: 'Theme: remove', sha: 'sha-0' },
    ])

    const after = await app.inject({ method: 'GET', url: '/api/theme' })
    expect(after.json()).toEqual({ file: null, layer: null, warnings: [], errors: [], origin: 'instance' })

    const again = await app.inject({ method: 'DELETE', url: '/api/theme', headers: as('alice') })
    expect(again.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE on a space: 403 without push right, 204 with it, then GET shows no theme', async () => {
    const { app, calls } = setup({ docs: 'name: Docs look\n' })
    expect((await app.inject({ method: 'GET', url: '/api/spaces/docs/theme', headers: as('alice') })).json().file).toEqual({
      name: 'Docs look',
    })

    const denied = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/theme', headers: as('bob') })
    expect(denied.statusCode).toBe(403)
    expect(calls).toEqual([])

    const res = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/theme', headers: as('alice') })
    expect(res.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme', headers: as('alice') })
    expect(after.json().file).toBeNull()
    await app.close()
  })
})

describe('theme write routes behind the real session gate', () => {
  it('PUT and DELETE /api/theme without a session → 401 (the public exemption covers reads only)', async () => {
    const provider = fakeProvider(new Map(), [], null)
    const app = buildApp({
      databaseUrl: 'postgres://user:pass@localhost:1/db-not-used',
      auth: { tokenKey: Buffer.alloc(32, 1).toString('base64') },
      providerRegistry: () => provider,
      instanceConfig,
    })
    const put = await app.inject({ method: 'PUT', url: '/api/theme', payload: { name: 'x' } })
    const del = await app.inject({ method: 'DELETE', url: '/api/theme' })
    expect(put.statusCode).toBe(401)
    expect(del.statusCode).toBe(401)
    await app.close()
    invalidateInstanceTheme()
  })
})
