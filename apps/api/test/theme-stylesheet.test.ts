import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../src/db/client.js'
import type { OpsCounters } from '../src/ops/counters.js'
import { registerThemeRoutes, type ThemeDeps } from '../src/routes/theme.js'
import { registerThemeStylesheetRoutes } from '../src/routes/theme-stylesheet.js'
import { registerWebhookRoutes, type WebhookIndexResult } from '../src/routes/webhooks.js'
import { invalidateBrand } from '../src/theme/brand-cache.js'
import { invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { invalidateLibrary } from '../src/theme/library.js'
import { invalidateAllSpaceThemes } from '../src/theme/space-theme.js'
import { loadFontSet, loadStylesheet, loadStylesheetState } from '../src/theme/stylesheet.js'
import { invalidateStylesheet } from '../src/theme/stylesheet-cache.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theme stylesheet (f451#61), modelled on `brand.test.ts`: plain Fastify with a
 * stubbed session (`x-test-user`). One in-memory repo store backs the service
 * registry (read path, with `listTree`/`readFileBinary` for the fonts) and the
 * per-user providers (write path, with `commitFiles`).
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

const USERS: Record<string, { read: boolean; push: boolean }> = {
  alice: { read: true, push: true },
  bob: { read: true, push: false },
  mallory: { read: false, push: false },
}

const silent = { warn: () => {}, debug: () => {} }

type Store = Map<string, { content: string | Buffer; sha: string }>

interface Commit {
  user: string
  repo: string
  message: string
  changes: { op: 'write' | 'delete'; path: string }[]
}

const fileKey = (repo: RepoRef, path: string) => `${repo.repo}:${path}`

/** `user` = whose token the provider carries; `null` = the service account (read only). */
function fakeProvider(store: Store, commits: Commit[], user: string | null): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected for the stylesheet`)
  }
  let seq = 0
  return {
    async readFile(repo, path) {
      const file = store.get(fileKey(repo, path))
      if (!file) throw new NotFoundError(path)
      const content = Buffer.isBuffer(file.content) ? file.content.toString('utf8') : file.content
      return { path, content, sha: file.sha }
    },
    async readFileBinary(repo, path) {
      const file = store.get(fileKey(repo, path))
      if (!file) throw new NotFoundError(path)
      const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8')
      return { content, sha: file.sha }
    },
    async listTree(repo) {
      const prefix = `${repo.repo}:`
      return [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, file]) => ({ path: key.slice(prefix.length), type: 'file' as const, sha: file.sha }))
    },
    async commitFiles(repo, changes, opts) {
      if (user === null) throw new Error('the service account must not write')
      for (const change of changes) {
        if (change.op === 'delete') {
          if (!store.has(fileKey(repo, change.path))) throw new NotFoundError(change.path)
          store.delete(fileKey(repo, change.path))
        } else {
          seq += 1
          store.set(fileKey(repo, change.path), { content: change.content.toString('utf8'), sha: `${user}-${seq}` })
        }
      }
      commits.push({
        user,
        repo: repo.repo,
        message: opts.message,
        changes: changes.map((c) => ({ op: c.op, path: c.path })),
      })
      return { commitSha: `c-${commits.length}` }
    },
    writeFile: fail('writeFile'),
    deleteFile: fail('deleteFile'),
    getHeadSha: fail('getHeadSha'),
    writeFileBinary: fail('writeFileBinary'),
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

function resetCaches() {
  invalidateInstanceTheme()
  invalidateAllSpaceThemes()
  invalidateLibrary()
  invalidateBrand()
  invalidateStylesheet()
}

/** `files`: `<repo>:<path>` → content; each seeded file gets the sha `seed:<path>`. */
function setup(files: Record<string, string | Buffer> = {}) {
  resetCaches()
  const store: Store = new Map()
  for (const [key, content] of Object.entries(files)) store.set(key, { content, sha: `seed:${key}` })
  const commits: Commit[] = []
  const service = fakeProvider(store, commits, null)

  const deps: ThemeDeps = {
    providerRegistry: () => service,
    instanceConfig,
    spaces: [docs],
    access: { canRead: async (userId) => USERS[userId]?.read === true },
    canWrite: async (userId) => USERS[userId]?.push === true,
    getUserProvider: async (userId) => (USERS[userId] ? fakeProvider(store, commits, userId) : null),
  }

  const app: FastifyInstance = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    const userId = req.headers['x-test-user']
    req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
  })
  registerThemeRoutes(app, deps)
  registerThemeStylesheetRoutes(app, deps)
  return { app, deps, store, commits, service }
}

const as = (user: string) => ({ 'x-test-user': user })
const cssPut = (user: string) => ({ ...as(user), 'content-type': 'text/css' })

const INSTANCE_CSS = "@font-face { font-family: 'Haus'; src: url(fonts/haus.woff2) format('woff2'); }\nbody { color: red; }\n"
const SPACE_CSS = "@font-face { font-family: 'Docs'; src: url(fonts/docs.woff2) format('woff2'); }\n"

/** A WOFF2 font of `size` bytes: the magic `wOF2`, then zeros. */
function woff2(size = 64): Buffer {
  return Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(size - 4)])
}

describe('theme stylesheet', () => {
  afterEach(resetCaches)

  describe('GET stylesheet', () => {
    it('instance: 200 text/css + nosniff + ETag + public cache, font URLs rewritten; 304 on If-None-Match', async () => {
      const { app } = setup({ 'instance:_meta/theme.css': INSTANCE_CSS })
      const res = await app.inject({ method: 'GET', url: '/api/theme/stylesheet' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('public, max-age=300')
      const etag = res.headers.etag
      expect(etag).toBe('"seed:instance:_meta/theme.css"')
      expect(res.body).toContain('url("/api/theme/fonts/haus.woff2")')
      expect(res.body).not.toContain('url(fonts/')
      expect(res.body).toContain('body { color: red; }')

      const again = await app.inject({ method: 'GET', url: '/api/theme/stylesheet', headers: { 'if-none-match': etag as string } })
      expect(again.statusCode).toBe(304)
      expect(again.body).toBe('')
      await app.close()
    })

    it('space: own file with private cache and space font URLs; no fallback to the instance file; 404 when unreadable', async () => {
      const { app } = setup({ 'instance:_meta/theme.css': INSTANCE_CSS, 'docs:_meta/theme.css': SPACE_CSS })
      const res = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/stylesheet', headers: as('bob') })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
      expect(res.headers['cache-control']).toBe('private, max-age=300')
      expect(res.headers.etag).toBe('"seed:docs:_meta/theme.css"')
      expect(res.body).toContain('url("/api/spaces/docs/theme/fonts/docs.woff2")')

      const hidden = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/stylesheet', headers: as('mallory') })
      const unknown = await app.inject({ method: 'GET', url: '/api/spaces/nope/theme/stylesheet', headers: as('alice') })
      expect(hidden.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
      await app.close()

      const instanceOnly = setup({ 'instance:_meta/theme.css': INSTANCE_CSS })
      const none = await instanceOnly.app.inject({ method: 'GET', url: '/api/spaces/docs/theme/stylesheet', headers: as('alice') })
      expect(none.statusCode).toBe(404)
      await instanceOnly.app.close()

      const empty = setup()
      expect((await empty.app.inject({ method: 'GET', url: '/api/theme/stylesheet' })).statusCode).toBe(404)
      await empty.app.close()
    })

    it('a 300-KB theme.css committed by hand → 404 and a warning; the state says too_large', async () => {
      const big = `body { color: red; }\n/* ${'x'.repeat(300 * 1024)} */\n`
      const { app, deps } = setup({ 'instance:_meta/theme.css': big })
      const log = { warn: vi.fn(), debug: vi.fn() }
      expect(await loadStylesheet(deps, { kind: 'instance' }, log)).toBeNull()
      expect(log.warn).toHaveBeenCalledOnce()
      expect((await loadStylesheetState(deps, { kind: 'instance' }, log)).status).toBe('too_large')

      expect((await app.inject({ method: 'GET', url: '/api/theme/stylesheet' })).statusCode).toBe(404)
      await app.close()
    })

    it('a rule violation in the repo → 404 and a warning naming code and line', async () => {
      const { app, deps } = setup({ 'instance:_meta/theme.css': 'a { color: red; }\n@import url(fonts/x.woff2);\n' })
      const log = { warn: vi.fn(), debug: vi.fn() }
      expect(await loadStylesheet(deps, { kind: 'instance' }, log)).toBeNull()
      expect(log.warn).toHaveBeenCalledOnce()
      const logged = log.warn.mock.calls[0]![0] as { problems: { code: string; line: number }[] }
      expect(logged.problems).toContainEqual({ code: 'css_import', line: 2 })
      const state = await loadStylesheetState(deps, { kind: 'instance' }, log)
      expect(state.status).toBe('invalid')

      expect((await app.inject({ method: 'GET', url: '/api/theme/stylesheet' })).statusCode).toBe(404)
      await app.close()
    })

    it('is cached; invalidateInstanceTheme empties it', async () => {
      const { deps, store } = setup({ 'instance:_meta/theme.css': INSTANCE_CSS })
      const first = await loadStylesheet(deps, { kind: 'instance' }, silent)
      store.set('instance:_meta/theme.css', { content: 'body { color: blue; }', sha: 'changed' })
      expect(await loadStylesheet(deps, { kind: 'instance' }, silent)).toEqual(first)
      invalidateInstanceTheme()
      expect((await loadStylesheet(deps, { kind: 'instance' }, silent))?.sha).toBe('changed')
    })
  })

  describe('GET fonts', () => {
    it('instance font: 200 font/woff2 + ETag + long public cache; 304 on If-None-Match', async () => {
      const { app } = setup({ 'instance:_meta/fonts/haus.woff2': woff2() })
      const res = await app.inject({ method: 'GET', url: '/api/theme/fonts/haus.woff2' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('font/woff2')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('public, max-age=86400')
      expect(res.headers.etag).toBe('"seed:instance:_meta/fonts/haus.woff2"')
      expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('wOF2')

      const again = await app.inject({
        method: 'GET',
        url: '/api/theme/fonts/haus.woff2',
        headers: { 'if-none-match': res.headers.etag as string },
      })
      expect(again.statusCode).toBe(304)
      await app.close()
    })

    it('wrong magic bytes, over 1 MB, a bad name or a missing file → 404', async () => {
      const { app, deps } = setup({
        'instance:_meta/fonts/fake.woff2': Buffer.from('not a font at all'),
        'instance:_meta/fonts/huge.woff2': woff2(1024 * 1024 + 1),
        'instance:_meta/fonts/Bad_Name.woff2': woff2(),
        'instance:_meta/fonts/ok.woff2': woff2(),
      })
      for (const name of ['fake.woff2', 'huge.woff2', 'Bad_Name.woff2', 'missing.woff2', 'ok.ttf']) {
        const res = await app.inject({ method: 'GET', url: `/api/theme/fonts/${name}` })
        expect(res.statusCode, name).toBe(404)
      }
      expect((await app.inject({ method: 'GET', url: '/api/theme/fonts/ok.woff2' })).statusCode).toBe(200)

      const set = await loadFontSet(deps, { kind: 'instance' }, silent)
      expect(Object.fromEntries(set.map((f) => [f.name, f.problem]))).toEqual({
        'Bad_Name.woff2': 'font_name',
        'fake.woff2': 'font_not_woff2',
        'huge.woff2': 'font_too_large',
        'ok.woff2': null,
      })
      await app.close()
    })

    it('fonts beyond 4 MB per repo (in name order) → 404, the ones before stay', async () => {
      const files: Record<string, Buffer> = {}
      for (const n of ['a', 'b', 'c', 'd', 'e']) files[`instance:_meta/fonts/${n}.woff2`] = woff2(900 * 1024)
      const { app, deps } = setup(files)
      for (const n of ['a', 'b', 'c', 'd']) {
        expect((await app.inject({ method: 'GET', url: `/api/theme/fonts/${n}.woff2` })).statusCode, n).toBe(200)
      }
      expect((await app.inject({ method: 'GET', url: '/api/theme/fonts/e.woff2' })).statusCode).toBe(404)
      const set = await loadFontSet(deps, { kind: 'instance' }, silent)
      expect(set.find((f) => f.name === 'e.woff2')?.problem).toBe('font_total_exceeded')
      await app.close()
    })

    it('space font: private cache; 404 for an unreadable space and no fallback to the instance font', async () => {
      const { app } = setup({
        'instance:_meta/fonts/haus.woff2': woff2(),
        'docs:_meta/fonts/docs.woff2': woff2(),
      })
      const res = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/fonts/docs.woff2', headers: as('bob') })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('private, max-age=86400')
      expect(res.headers.etag).toBe('"seed:docs:_meta/fonts/docs.woff2"')

      const hidden = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/fonts/docs.woff2', headers: as('mallory') })
      const instanceFont = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/fonts/haus.woff2', headers: as('bob') })
      expect(hidden.statusCode).toBe(404)
      expect(instanceFont.statusCode).toBe(404)
      await app.close()
    })
  })

  describe('PUT / DELETE', () => {
    it('PUT: one commit of _meta/theme.css with the caller token; GET serves it', async () => {
      const { app, store, commits } = setup()
      const res = await app.inject({ method: 'PUT', url: '/api/theme/stylesheet', headers: cssPut('alice'), payload: INSTANCE_CSS })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ url: '/api/theme/stylesheet' })
      expect(commits).toEqual([
        { user: 'alice', repo: 'instance', message: 'Theme: stylesheet', changes: [{ op: 'write', path: '_meta/theme.css' }] },
      ])
      expect(store.get('instance:_meta/theme.css')!.content).toBe(INSTANCE_CSS)

      const served = await app.inject({ method: 'GET', url: '/api/theme/stylesheet' })
      expect(served.statusCode).toBe(200)
      expect(served.headers.etag).toBe('"alice-1"')
      await app.close()
    })

    it('PUT to a space goes to the space repo', async () => {
      const { app, commits } = setup()
      const res = await app.inject({ method: 'PUT', url: '/api/spaces/docs/theme/stylesheet', headers: cssPut('alice'), payload: SPACE_CSS })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ url: '/api/spaces/docs/theme/stylesheet' })
      expect(commits[0]).toMatchObject({ user: 'alice', repo: 'docs', changes: [{ op: 'write', path: '_meta/theme.css' }] })
      await app.close()
    })

    it('PUT 422 per rule with the code and line, nothing committed', async () => {
      const { app, commits } = setup()
      const cases: [string, string][] = [
        ['a { color: red; }\n@import "x.css";\n', 'css_import'],
        ['a { background: url(https://example.org/x.png); }\n', 'css_url'],
        ['a { background: url(/api/x); }\n', 'css_url'],
        ['a { width: expression(1); }\n', 'css_forbidden'],
        ['a { behavior: url(data:x); }\n', 'css_forbidden'],
      ]
      for (const [css, code] of cases) {
        const res = await app.inject({ method: 'PUT', url: '/api/theme/stylesheet', headers: cssPut('alice'), payload: css })
        expect(res.statusCode, css).toBe(422)
        const body = res.json() as { status: string; errors: { code: string; line?: number }[] }
        expect(body.status).toBe('invalid')
        expect(body.errors.map((e) => e.code), css).toContain(code)
        expect(body.errors.every((e) => typeof e.line === 'number'), css).toBe(true)
      }
      const imported = await app.inject({
        method: 'PUT',
        url: '/api/theme/stylesheet',
        headers: cssPut('alice'),
        payload: 'a { color: red; }\n@import "x.css";\n',
      })
      expect(imported.json().errors).toContainEqual(expect.objectContaining({ code: 'css_import', line: 2 }))
      expect(commits).toEqual([])
      await app.close()
    })

    it('PUT over 256 KB → 422 css_too_large, nothing committed', async () => {
      const { app, commits } = setup()
      const big = `body { color: red; }\n/* ${'x'.repeat(300 * 1024)} */\n`
      const res = await app.inject({ method: 'PUT', url: '/api/theme/stylesheet', headers: cssPut('alice'), payload: big })
      expect(res.statusCode).toBe(422)
      expect(res.json().errors[0].code).toBe('css_too_large')
      expect(commits).toEqual([])
      await app.close()
    })

    it('403 without push right, 404 on an unreadable space, nothing committed', async () => {
      const { app, commits } = setup({ 'instance:_meta/theme.css': INSTANCE_CSS })
      const instance = await app.inject({ method: 'PUT', url: '/api/theme/stylesheet', headers: cssPut('bob'), payload: INSTANCE_CSS })
      const space = await app.inject({ method: 'PUT', url: '/api/spaces/docs/theme/stylesheet', headers: cssPut('bob'), payload: SPACE_CSS })
      const del = await app.inject({ method: 'DELETE', url: '/api/theme/stylesheet', headers: as('bob') })
      const delSpace = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/theme/stylesheet', headers: as('bob') })
      const hidden = await app.inject({ method: 'PUT', url: '/api/spaces/docs/theme/stylesheet', headers: cssPut('mallory'), payload: SPACE_CSS })
      expect([instance.statusCode, space.statusCode, del.statusCode, delSpace.statusCode]).toEqual([403, 403, 403, 403])
      expect(hidden.statusCode).toBe(404)
      expect(commits).toEqual([])
      await app.close()
    })

    it('DELETE removes the file in one commit with the caller token; then GET and DELETE answer 404', async () => {
      const { app, store, commits } = setup({ 'docs:_meta/theme.css': SPACE_CSS })
      expect((await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/stylesheet', headers: as('alice') })).statusCode).toBe(200)

      const res = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/theme/stylesheet', headers: as('alice') })
      expect(res.statusCode).toBe(204)
      expect(commits).toEqual([
        { user: 'alice', repo: 'docs', message: 'Theme: remove stylesheet', changes: [{ op: 'delete', path: '_meta/theme.css' }] },
      ])
      expect(store.has('docs:_meta/theme.css')).toBe(false)

      expect((await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/stylesheet', headers: as('alice') })).statusCode).toBe(404)
      const again = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/theme/stylesheet', headers: as('alice') })
      expect(again.statusCode).toBe(404)
      expect(commits).toHaveLength(1)
      await app.close()
    })
  })

  describe('webhook', () => {
    it('a push touching _meta/theme.css or _meta/fonts/ empties the space cache', async () => {
      const { deps, store, service } = setup({ 'docs:_meta/theme.css': SPACE_CSS, 'docs:_meta/fonts/docs.woff2': woff2() })
      const space = { kind: 'space' as const, space: docs }
      expect((await loadStylesheet(deps, space, silent))?.sha).toBe('seed:docs:_meta/theme.css')
      expect((await loadFontSet(deps, space, silent)).map((f) => f.sha)).toEqual(['seed:docs:_meta/fonts/docs.woff2'])

      store.set('docs:_meta/theme.css', { content: 'body { color: blue; }', sha: 'css-2' })
      store.set('docs:_meta/fonts/docs.woff2', { content: woff2(), sha: 'font-2' })
      // Still cached.
      expect((await loadStylesheet(deps, space, silent))?.sha).toBe('seed:docs:_meta/theme.css')

      const secret = 'hook-secret'
      const hooks = Fastify()
      const indexed: Promise<WebhookIndexResult>[] = []
      let resolveIndexed: (r: WebhookIndexResult) => void = () => {}
      registerWebhookRoutes(hooks, {
        // Indexing fails against this stub (no database) — only the invalidation before it matters here.
        db: {} as unknown as Db,
        spaces: [docs],
        providerRegistry: () => service,
        secrets: { forgejo: secret },
        counters: { increment: () => {} } as unknown as OpsCounters,
        onIndexed: (r) => resolveIndexed(r),
      })

      async function push(paths: string[]) {
        indexed.push(new Promise((resolve) => (resolveIndexed = resolve)))
        const body = JSON.stringify({
          ref: 'refs/heads/main',
          repository: { name: 'docs', owner: { login: 'f451' } },
          commits: [{ modified: paths }],
        })
        const res = await hooks.inject({
          method: 'POST',
          url: '/webhooks/forgejo',
          headers: {
            'content-type': 'application/json',
            'x-gitea-signature': createHmac('sha256', secret).update(body).digest('hex'),
          },
          payload: body,
        })
        expect(res.statusCode).toBe(202)
        await indexed.at(-1)
      }

      await push(['_meta/theme.css'])
      expect((await loadStylesheet(deps, space, silent))?.sha).toBe('css-2')

      store.set('docs:_meta/fonts/docs.woff2', { content: woff2(), sha: 'font-3' })
      await push(['_meta/fonts/docs.woff2'])
      expect((await loadFontSet(deps, space, silent)).map((f) => f.sha)).toEqual(['font-3'])
      await hooks.close()
    })
  })

  describe('resolved.stylesheets', () => {
    it('instance, then space, each with ?v=<sha7>', async () => {
      const { app } = setup({ 'instance:_meta/theme.css': INSTANCE_CSS, 'docs:_meta/theme.css': SPACE_CSS })
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('bob') })
      expect(res.json().stylesheets).toEqual([
        `/api/theme/stylesheet?v=${'seed:instance:_meta/theme.css'.slice(0, 7)}`,
        `/api/spaces/docs/theme/stylesheet?v=${'seed:docs:_meta/theme.css'.slice(0, 7)}`,
      ])
      // An unreadable space contributes nothing.
      const hidden = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('mallory') })
      expect(hidden.json().stylesheets).toHaveLength(1)
      await app.close()
    })

    it('a space without its own file → only the instance URL; none anywhere → []', async () => {
      const own = setup({ 'instance:_meta/theme.css': INSTANCE_CSS })
      const res = await own.app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('bob') })
      expect(res.json().stylesheets).toEqual([`/api/theme/stylesheet?v=${'seed:instance:_meta/theme.css'.slice(0, 7)}`])
      await own.app.close()

      const empty = setup()
      expect((await empty.app.inject({ method: 'GET', url: '/api/theme/resolved' })).json().stylesheets).toEqual([])
      await empty.app.close()
    })

    it('an invalid instance file is left out; the valid space file stays', async () => {
      const { app } = setup({ 'instance:_meta/theme.css': '@import "x.css";', 'docs:_meta/theme.css': SPACE_CSS })
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('bob') })
      expect(res.json().stylesheets).toEqual([`/api/spaces/docs/theme/stylesheet?v=${'seed:docs:_meta/theme.css'.slice(0, 7)}`])
      await app.close()
    })
  })
})
