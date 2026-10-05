import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { registerThemeRoutes, type ThemeDeps } from '../src/routes/theme.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { invalidateAllSpaceThemes, SPACE_THEME_PATH } from '../src/theme/space-theme.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 2, unit 2.2 (theme read routes). No Postgres container: with
 * `auth` set, `buildApp` only needs a `databaseUrl` for the pool, which never
 * connects — a request without a cookie does not touch the database. The
 * instance repo is a hand-built fake provider (as in `theme-instance.test.ts`).
 */

const instanceConfig: InstanceConfig = {
  provider: 'forgejo',
  owner: 'f451',
  repo: 'instance',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'instance' },
}

/** Fake provider: only `readFile` of the theme file works, every other method throws. */
function providerWithThemeFile(content: string | Error): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the theme routes`)
  }
  return {
    async readFile(_repo, path) {
      if (path !== INSTANCE_THEME_PATH) throw new NotFoundError(path)
      if (content instanceof Error) throw content
      return { path, content, sha: 'abc' }
    },
    readFileBinary: fail('readFileBinary'),
    listTree: fail('listTree'),
    getHeadSha: fail('getHeadSha'),
    writeFile: fail('writeFile'),
    writeFileBinary: fail('writeFileBinary'),
    createBranch: fail('createBranch'),
    deleteBranch: fail('deleteBranch'),
    listCommits: fail('listCommits'),
    createPullRequest: fail('createPullRequest'),
    getPullRequest: fail('getPullRequest'),
    listPullRequests: fail('listPullRequests'),
    requestReviewers: fail('requestReviewers'),
    submitPullRequestReview: fail('submitPullRequestReview'),
    mergePullRequest: fail('mergePullRequest'),
  }
}

/** App with the session gate active (auth on) and an instance repo serving `content`. */
function appWithTheme(content: string | Error) {
  const provider = providerWithThemeFile(content)
  return buildApp({
    databaseUrl: 'postgres://user:pass@localhost:1/db-not-used',
    auth: { tokenKey: Buffer.alloc(32, 1).toString('base64') },
    providerRegistry: () => provider,
    instanceConfig,
  })
}

const THEME_FILE = 'name: House\nlight:\n  color-accent: "#0b5fa5"\n  color-nope: "#000000"\n'

describe('theme routes', () => {
  afterEach(() => {
    invalidateInstanceTheme()
  })

  it('GET /api/theme/resolved without instance config → no layers, empty css', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/theme/resolved' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.layers).toEqual([])
    expect(body.css.root).toEqual([])
    expect(body.css.light).toEqual([])
    expect(body.css.dark).toEqual([])
    expect(body.brand).toBeNull()
    expect(body.origin.light['--color-accent']).toEqual({ source: 'default' })
    expect(body.attributes).toEqual({})
    await app.close()
  })

  it('GET /api/theme/resolved with an instance theme → its declarations and origin', async () => {
    const app = appWithTheme(THEME_FILE)
    const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=any' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.layers).toEqual(['instance'])
    expect(body.css.light).toContain('--color-accent: #0b5fa5;')
    expect(body.origin.light['--color-accent'].source).toBe('instance')
    expect(body.css.dark.some((d: string) => d.startsWith('--color-accent:'))).toBe(false)
    await app.close()
  })

  it('GET /api/theme/resolved carries the switch deviations as attributes', async () => {
    const app = appWithTheme('name: Switches\nbase:\n  chip-style: filled\n  callout-style: bar\n')
    const res = await app.inject({ method: 'GET', url: '/api/theme/resolved' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // `callout-style: bar` is the default — set, but no deviation (Review Focus 2)
    expect(body.attributes).toEqual({ 'chip-style': 'filled' })
    expect(body.origin.base['--callout-style'].source).toBe('instance')
    expect(body.css.root.some((d: string) => d.startsWith('--chip-style'))).toBe(false)
    await app.close()
  })

  it('anonymous requests (no cookie) get 200 on both routes while auth is on', async () => {
    const app = appWithTheme(THEME_FILE)
    for (const url of ['/api/theme', '/api/theme/resolved']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
    }
    await app.close()
  })

  it('GET /api/theme with a theme file → file, layer and dropped entries', async () => {
    const app = appWithTheme(THEME_FILE)
    const res = await app.inject({ method: 'GET', url: '/api/theme' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.origin).toBe('instance')
    expect(body.file.name).toBe('House')
    expect(body.layer.source).toBe('instance')
    expect(body.layer.light).toEqual({ '--color-accent': '#0b5fa5' })
    expect(body.errors.map((e: { code: string }) => e.code)).toEqual(['token_unknown'])
    expect(body.warnings).toEqual([])
    await app.close()
  })

  it('GET /api/theme without a theme file → 200 with empty values', async () => {
    const app = appWithTheme(new NotFoundError('not found'))
    const res = await app.inject({ method: 'GET', url: '/api/theme' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ file: null, layer: null, warnings: [], errors: [], origin: 'instance' })
    await app.close()
  })

  it('GET /api/theme without instance config → 200 with empty values', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/theme' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ file: null, layer: null, warnings: [], errors: [], origin: 'instance' })
    await app.close()
  })
})

/**
 * Theming Stage 3, unit 3.2 (space layer). Plain Fastify with a stubbed session
 * and access check (pattern `pages-routes.test.ts`): `x-test-user` sets `req.user`,
 * `access.canRead` lets only `alice` read the `docs` space.
 */
describe('theme routes — space layer', () => {
  const docs: SpaceConfig = {
    id: 'docs',
    name: 'Docs',
    provider: 'forgejo',
    owner: 'f451',
    repo: 'docs',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'f451', repo: 'docs' },
  }

  const INSTANCE_FILE = 'light:\n  color-accent: "#0b5fa5"\n  color-border: "#cccccc"\n'
  const SPACE_FILE = 'name: Docs look\nlight:\n  color-accent: "#aa3300"\n'

  /** Serves the instance file from repo `instance` and the space file from repo `docs`. */
  function twoRepoProvider(): GitProvider {
    const base = providerWithThemeFile('')
    return {
      ...base,
      async readFile(repo, path) {
        if (repo.repo === 'instance' && path === INSTANCE_THEME_PATH) return { path, content: INSTANCE_FILE, sha: 'i' }
        if (repo.repo === 'docs' && path === SPACE_THEME_PATH) return { path, content: SPACE_FILE, sha: 's' }
        throw new NotFoundError(path)
      },
    }
  }

  function appWithSpaces(): FastifyInstance {
    const provider = twoRepoProvider()
    const deps: ThemeDeps = {
      providerRegistry: () => provider,
      instanceConfig,
      spaces: [docs],
      access: { canRead: async (userId) => userId === 'alice' },
    }
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerThemeRoutes(app, deps)
    return app
  }

  afterEach(() => {
    invalidateInstanceTheme()
    invalidateAllSpaceThemes()
  })

  it('resolved with a readable space → both layers, space overrides, instance-only token inherited', async () => {
    const app = appWithSpaces()
    const res = await app.inject({
      method: 'GET',
      url: '/api/theme/resolved?space=docs',
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.layers).toEqual(['instance', 'space'])
    expect(body.css.light).toContain('--color-accent: #aa3300;')
    expect(body.css.light).not.toContain('--color-accent: #0b5fa5;')
    expect(body.origin.light['--color-accent'].source).toBe('space')
    expect(body.css.light).toContain('--color-border: #cccccc;')
    expect(body.origin.light['--color-border'].source).toBe('instance')
    await app.close()
  })

  it('resolved with an unknown space → instance only, 200', async () => {
    const app = appWithSpaces()
    const res = await app.inject({
      method: 'GET',
      url: '/api/theme/resolved?space=nope',
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.layers).toEqual(['instance'])
    expect(body.css.light).toContain('--color-accent: #0b5fa5;')
    await app.close()
  })

  it('resolved with a space the caller may not read (or anonymous) → instance only, 200', async () => {
    const app = appWithSpaces()
    for (const headers of [{ 'x-test-user': 'mallory' }, {}]) {
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers })
      expect(res.statusCode).toBe(200)
      expect(res.json().layers).toEqual(['instance'])
    }
    await app.close()
  })

  it('GET /api/spaces/:space/theme with read access → 200 with the space file', async () => {
    const app = appWithSpaces()
    const res = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme', headers: { 'x-test-user': 'alice' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.origin).toBe('space')
    expect(body.file.name).toBe('Docs look')
    expect(body.layer.source).toBe('space')
    expect(body.layer.light).toEqual({ '--color-accent': '#aa3300' })
    expect(body.errors).toEqual([])
    await app.close()
  })

  it('GET /api/spaces/:space/theme: unknown space and no read access answer the same 404', async () => {
    const app = appWithSpaces()
    const unknown = await app.inject({ method: 'GET', url: '/api/spaces/nope/theme', headers: { 'x-test-user': 'alice' } })
    const denied = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme', headers: { 'x-test-user': 'mallory' } })
    expect(unknown.statusCode).toBe(404)
    expect(denied.statusCode).toBe(404)
    expect(unknown.json().status).toBe('not_found')
    expect(denied.json().status).toBe('not_found')
    await app.close()
  })

  it('GET /api/spaces/:space/theme without a session → 401 from the session gate', async () => {
    const app = appWithTheme(THEME_FILE)
    const res = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
