import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AA_THRESHOLDS, DEFAULT_THRESHOLDS, resolveTheme } from '@f451/design-tokens'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { registerThemeEditorRoutes } from '../src/routes/theme-editor.js'
import type { ThemeDeps } from '../src/routes/theme.js'
import { invalidateContrastThresholds } from '../src/theme/contrast-config.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { invalidateAllSpaceThemes, SPACE_THEME_PATH } from '../src/theme/space-theme.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 5 (settings page reads). Plain Fastify with a stubbed session and
 * access check (pattern `theme-routes.test.ts`): `x-test-user` sets `req.user`,
 * `access.canRead` lets `alice` read `docs` but nobody read `secret`; only
 * `alice` has push right, and only on the instance and `docs`.
 */

const instanceConfig: InstanceConfig = {
  provider: 'forgejo',
  owner: 'f451',
  repo: 'instance',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'instance' },
}

function spaceConfig(id: string, name: string): SpaceConfig {
  return {
    id,
    name,
    provider: 'forgejo',
    owner: 'f451',
    repo: id,
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'f451', repo: id },
  }
}

const docs = spaceConfig('docs', 'Docs')
const secret = spaceConfig('secret', 'Secret')

const LOW_CONTRAST_INSTANCE = 'name: House\nlight:\n  color-accent: "#dddddd"\n'
const INSTANCE_FILE = 'name: House\nlight:\n  color-accent: "#0b5fa5"\n'
const SPACE_FILE = 'name: Docs look\nlight:\n  color-accent: "#aa3300"\n'

/** Fake provider: only `readFile` of the two theme files works, every other method throws. */
function provider(files: { instance?: string; space?: string }): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the theme editor routes`)
  }
  return {
    async readFile(repo, path) {
      if (repo.repo === 'instance' && path === INSTANCE_THEME_PATH && files.instance !== undefined) {
        return { path, content: files.instance, sha: 'i' }
      }
      if (repo.repo === 'docs' && path === SPACE_THEME_PATH && files.space !== undefined) {
        return { path, content: files.space, sha: 's' }
      }
      throw new NotFoundError(path)
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

function buildEditorApp(
  files: { instance?: string; space?: string },
  opts: { withInstance?: boolean } = {},
): FastifyInstance {
  const repo = provider(files)
  const deps: ThemeDeps = {
    providerRegistry: () => repo,
    instanceConfig: opts.withInstance === false ? undefined : instanceConfig,
    spaces: [docs, secret],
    access: { canRead: async (userId, space) => userId === 'alice' && space.id === 'docs' },
    canWrite: async (userId, space) => userId === 'alice' && space.id !== 'secret',
    getUserProvider: async () => repo,
  }
  const app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    const userId = req.headers['x-test-user']
    req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
  })
  registerThemeEditorRoutes(app, deps)
  return app
}

const alice = { 'x-test-user': 'alice' }
const bob = { 'x-test-user': 'bob' }

describe('theme editor routes', () => {
  afterEach(() => {
    invalidateInstanceTheme()
    invalidateAllSpaceThemes()
    invalidateContrastThresholds()
  })

  it('GET /api/theme/scopes lists only readable spaces, with canWrite', async () => {
    const app = buildEditorApp({})
    const res = await app.inject({ method: 'GET', url: '/api/theme/scopes', headers: alice })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      instance: { available: true, canWrite: true },
      spaces: [{ id: 'docs', name: 'Docs', canWrite: true }],
    })
    await app.close()
  })

  it('GET /api/theme/scopes without push right → canWrite false, unreadable spaces hidden', async () => {
    const app = buildEditorApp({})
    const res = await app.inject({ method: 'GET', url: '/api/theme/scopes', headers: bob })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ instance: { available: true, canWrite: false }, spaces: [] })
    await app.close()
  })

  it('GET /api/theme/scopes: a throwing push-right probe counts as false', async () => {
    const repo = provider({})
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      req.user = { id: 'alice', email: 'alice@test.local', displayName: 'alice' }
    })
    registerThemeEditorRoutes(app, {
      providerRegistry: () => repo,
      instanceConfig,
      spaces: [docs],
      access: { canRead: async () => true },
      canWrite: async () => {
        throw new Error('provider down')
      },
      getUserProvider: async () => repo,
    })
    const res = await app.inject({ method: 'GET', url: '/api/theme/scopes' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      instance: { available: true, canWrite: false },
      spaces: [{ id: 'docs', name: 'Docs', canWrite: false }],
    })
    await app.close()
  })

  it('GET /api/theme/scopes without instance config → instance not available', async () => {
    const app = buildEditorApp({}, { withInstance: false })
    const res = await app.inject({ method: 'GET', url: '/api/theme/scopes', headers: alice })
    expect(res.json().instance).toEqual({ available: false, canWrite: false })
    await app.close()
  })

  it('editor, instance scope without a file → below and resolved are the defaults', async () => {
    const app = buildEditorApp({})
    const res = await app.inject({ method: 'GET', url: '/api/theme/editor?scope=instance', headers: alice })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const defaults = resolveTheme([])
    expect(body.scope).toEqual({ kind: 'instance' })
    expect(body.canWrite).toBe(true)
    expect(body.file).toBeNull()
    expect(body.problems).toEqual([])
    expect(body.belowLayers).toEqual([])
    expect(body.below).toEqual(defaults)
    expect(body.resolved).toEqual(defaults)
    expect(body.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(body.defaults).toEqual(DEFAULT_THRESHOLDS)
    expect(body.aa).toEqual(AA_THRESHOLDS)
    expect(body.thresholdsSource).toBe('default')
    expect(body.note).toBeNull()
    expect(body.rules).toEqual([])
    await app.close()
  })

  it('editor, instance scope with a file → resolved carries its accent, low contrast is reported', async () => {
    const app = buildEditorApp({ instance: LOW_CONTRAST_INSTANCE })
    const res = await app.inject({ method: 'GET', url: '/api/theme/editor?scope=instance', headers: bob })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.canWrite).toBe(false)
    expect(body.file.name).toBe('House')
    expect(body.below).toEqual(resolveTheme([]))
    expect(body.resolved.light['--color-accent']).toBe('#dddddd')
    expect(body.resolved.origin.light['--color-accent'].source).toBe('instance')
    expect(body.findings.length).toBeGreaterThan(0)
    const button = body.findings.find(
      (f: { mode: string; pair: { vorn: string; hinten: string } }) =>
        f.mode === 'light' && f.pair.vorn === '--color-accent-contrast' && f.pair.hinten === '--color-accent',
    )
    expect(button.belowThreshold).toBe(true)
    expect(button.belowAA).toBe(true)
    await app.close()
  })

  it('editor, space scope → below inherits the instance accent, resolved overrides it', async () => {
    const app = buildEditorApp({ instance: INSTANCE_FILE, space: SPACE_FILE })
    const res = await app.inject({ method: 'GET', url: '/api/theme/editor?scope=space&space=docs', headers: alice })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.scope).toEqual({ kind: 'space', id: 'docs', name: 'Docs' })
    expect(body.canWrite).toBe(true)
    expect(body.file.name).toBe('Docs look')
    expect(body.belowLayers.map((l: { source: string }) => l.source)).toEqual(['instance'])
    expect(body.below.light['--color-accent']).toBe('#0b5fa5')
    expect(body.below.origin.light['--color-accent'].source).toBe('instance')
    expect(body.resolved.light['--color-accent']).toBe('#aa3300')
    expect(body.resolved.origin.light['--color-accent'].source).toBe('space')
    await app.close()
  })

  it('editor, space scope: unknown and unreadable space answer the same 404', async () => {
    const app = buildEditorApp({ instance: INSTANCE_FILE, space: SPACE_FILE })
    const unknown = await app.inject({ method: 'GET', url: '/api/theme/editor?scope=space&space=nope', headers: alice })
    const denied = await app.inject({ method: 'GET', url: '/api/theme/editor?scope=space&space=docs', headers: bob })
    expect(unknown.statusCode).toBe(404)
    expect(denied.statusCode).toBe(404)
    expect(unknown.json().status).toBe('not_found')
    expect(denied.json().status).toBe('not_found')
    await app.close()
  })

  it('editor, instance scope without instance config → 404', async () => {
    const app = buildEditorApp({}, { withInstance: false })
    const res = await app.inject({ method: 'GET', url: '/api/theme/editor?scope=instance', headers: alice })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('editor with a missing or unknown scope → 400', async () => {
    const app = buildEditorApp({})
    for (const url of ['/api/theme/editor', '/api/theme/editor?scope=user', '/api/theme/editor?scope=space']) {
      const res = await app.inject({ method: 'GET', url, headers: alice })
      expect(res.statusCode, url).toBe(400)
    }
    await app.close()
  })
})
