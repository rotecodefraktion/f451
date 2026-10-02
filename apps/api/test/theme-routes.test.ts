import { afterEach, describe, expect, it } from 'vitest'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { buildApp } from '../src/app.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import type { InstanceConfig } from '../src/spaces/config.js'

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
