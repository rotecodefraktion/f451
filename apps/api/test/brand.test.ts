import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { registerBrandRoutes } from '../src/routes/brand.js'
import { registerThemeRoutes, type ThemeDeps } from '../src/routes/theme.js'
import { loadBrandFile, resolveBrand } from '../src/theme/brand.js'
import { invalidateBrand } from '../src/theme/brand-cache.js'
import { invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { invalidateLibrary } from '../src/theme/library.js'
import { invalidateAllSpaceThemes } from '../src/theme/space-theme.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 8, unit 8.1 (brand). Plain Fastify with a stubbed session
 * (`x-test-user`, pattern `theme-library.test.ts`). One in-memory repo store backs
 * the service registry (read path) and the per-user providers (write path, with
 * `commitFiles`), so a read after a write sees the commit.
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

type Store = Map<string, { content: string; sha: string }>

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
    throw new Error(`GitProvider.${name}: not expected for the brand`)
  }
  let seq = 0
  return {
    async readFile(repo, path) {
      const file = store.get(fileKey(repo, path))
      if (!file) throw new NotFoundError(path)
      return { path, content: file.content, sha: file.sha }
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
    listTree: async () => [],
    readFileBinary: fail('readFileBinary'),
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

/** `files`: `<repo>:<path>` → content; each seeded file gets the sha `seed:<path>`. */
function setup(files: Record<string, string> = {}) {
  // The loaders cache module-wide; a second setup inside one test must not see
  // the first app's files.
  invalidateInstanceTheme()
  invalidateAllSpaceThemes()
  invalidateLibrary()
  invalidateBrand()
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
  registerBrandRoutes(app, deps)
  return { app, deps, store, commits }
}

const as = (user: string) => ({ 'x-test-user': user })
const svgPut = (user: string) => ({ ...as(user), 'content-type': 'image/svg+xml' })

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>'
const SPACE_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"></circle></svg>'
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"></rect></svg>'

const INSTANCE_BRAND = 'brand:\n  name: Acme\n  logo: brand/logo.svg\n  favicon: brand/favicon.svg\n'

const instanceFiles = {
  'instance:_meta/theme.yaml': INSTANCE_BRAND,
  'instance:_meta/brand/logo.svg': LOGO,
  'instance:_meta/brand/favicon.svg': FAVICON,
}

describe('brand', () => {
  afterEach(() => {
    invalidateInstanceTheme()
    invalidateAllSpaceThemes()
    invalidateLibrary()
    invalidateBrand()
  })

  describe('resolveBrand / loadBrandFile', () => {
    it('instance only: name, logo and favicon from the instance file', async () => {
      const { deps } = setup(instanceFiles)
      expect(await resolveBrand(deps, undefined, silent)).toEqual({
        name: 'Acme',
        logo: true,
        favicon: true,
        logoScope: 'instance',
      })
      // A space without a brand block inherits all of it.
      expect(await resolveBrand(deps, docs, silent)).toEqual({
        name: 'Acme',
        logo: true,
        favicon: true,
        logoScope: 'instance',
      })
    })

    it('no brand anywhere → nothing set', async () => {
      const { deps } = setup()
      expect(await resolveBrand(deps, docs, silent)).toEqual({ name: null, logo: false, favicon: false, logoScope: null })
    })

    it('the space file overrides name and logo; the favicon stays the instance one', async () => {
      const { deps } = setup({
        ...instanceFiles,
        'docs:_meta/theme.yaml': 'brand:\n  name: Docs Wiki\n  logo: brand/logo.svg\n',
        'docs:_meta/brand/logo.svg': SPACE_LOGO,
      })
      expect(await resolveBrand(deps, docs, silent)).toEqual({
        name: 'Docs Wiki',
        logo: true,
        favicon: true,
        logoScope: 'space',
      })
      const file = await loadBrandFile(deps, { kind: 'space', space: docs }, 'logo', silent)
      expect(file?.svg).toContain('circle')
      expect(file?.sha).toBe('seed:docs:_meta/brand/logo.svg')
    })

    it('a favicon in a space file is ignored', async () => {
      const { deps } = setup({
        'docs:_meta/theme.yaml': 'brand:\n  favicon: brand/favicon.svg\n',
        'docs:_meta/brand/favicon.svg': FAVICON,
      })
      expect((await resolveBrand(deps, docs, silent)).favicon).toBe(false)
      expect(await loadBrandFile(deps, { kind: 'space', space: docs }, 'favicon', silent)).toBeNull()
    })

    it('a file over 256 KB in the repo → null with a warning', async () => {
      const big = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(300 * 1024)} --><rect width="1" height="1"></rect></svg>`
      const { deps } = setup({ 'instance:_meta/theme.yaml': 'brand:\n  logo: brand/logo.svg\n', 'instance:_meta/brand/logo.svg': big })
      const log = { warn: vi.fn(), debug: vi.fn() }
      expect(await loadBrandFile(deps, { kind: 'instance' }, 'logo', log)).toBeNull()
      expect(log.warn).toHaveBeenCalledOnce()
    })

    it('is cached; invalidateInstanceTheme empties it', async () => {
      const { deps, store } = setup(instanceFiles)
      const first = await loadBrandFile(deps, { kind: 'instance' }, 'logo', silent)
      store.set('instance:_meta/brand/logo.svg', { content: SPACE_LOGO, sha: 'changed' })
      expect(await loadBrandFile(deps, { kind: 'instance' }, 'logo', silent)).toEqual(first)
      invalidateInstanceTheme()
      expect((await loadBrandFile(deps, { kind: 'instance' }, 'logo', silent))?.sha).toBe('changed')
    })
  })

  describe('GET', () => {
    it('GET /api/brand/logo → 200 image/svg+xml with ETag, then 304 on If-None-Match', async () => {
      const { app } = setup(instanceFiles)
      const res = await app.inject({ method: 'GET', url: '/api/brand/logo' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/)
      expect(res.headers['cache-control']).toBe('public, max-age=300')
      const etag = res.headers.etag
      expect(etag).toBe('"seed:instance:_meta/brand/logo.svg"')
      expect(res.body).toContain('<rect')

      const again = await app.inject({ method: 'GET', url: '/api/brand/logo', headers: { 'if-none-match': etag as string } })
      expect(again.statusCode).toBe(304)
      expect(again.body).toBe('')

      const favicon = await app.inject({ method: 'GET', url: '/api/brand/favicon' })
      expect(favicon.statusCode).toBe(200)
      expect(favicon.headers.etag).toBe('"seed:instance:_meta/brand/favicon.svg"')
      await app.close()
    })

    it('space logo: own file, else the instance one; 404 for an unreadable space or no logo at all', async () => {
      const { app } = setup(instanceFiles)
      const inherited = await app.inject({ method: 'GET', url: '/api/spaces/docs/brand/logo', headers: as('bob') })
      expect(inherited.statusCode).toBe(200)
      expect(inherited.headers.etag).toBe('"seed:instance:_meta/brand/logo.svg"')

      const unreadable = await app.inject({ method: 'GET', url: '/api/spaces/docs/brand/logo', headers: as('mallory') })
      const unknown = await app.inject({ method: 'GET', url: '/api/spaces/nope/brand/logo', headers: as('alice') })
      expect(unreadable.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
      await app.close()

      const empty = setup()
      const none = await empty.app.inject({ method: 'GET', url: '/api/spaces/docs/brand/logo', headers: as('alice') })
      const noInstance = await empty.app.inject({ method: 'GET', url: '/api/brand/logo' })
      expect(none.statusCode).toBe(404)
      expect(noInstance.statusCode).toBe(404)
      await empty.app.close()
    })
  })

  describe('PUT / DELETE', () => {
    it('PUT logo: the sanitizer strips a <script>, answers sanitized: true, one commit with file and pointer', async () => {
      const { app, store, commits } = setup({
        'instance:_meta/theme.yaml': 'name: House\nlight:\n  color-accent: "#0b5fa5"\n',
      })
      const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"></rect></svg>'
      const res = await app.inject({ method: 'PUT', url: '/api/theme/brand/logo', headers: svgPut('alice'), payload: dirty })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ sanitized: true, url: '/api/brand/logo' })

      expect(commits).toEqual([
        {
          user: 'alice',
          repo: 'instance',
          message: 'Brand: logo',
          changes: [
            { op: 'write', path: '_meta/brand/logo.svg' },
            { op: 'write', path: '_meta/theme.yaml' },
          ],
        },
      ])
      expect(store.get('instance:_meta/brand/logo.svg')!.content).not.toContain('script')
      expect(parseYaml(store.get('instance:_meta/theme.yaml')!.content)).toEqual({
        name: 'House',
        light: { 'color-accent': '#0b5fa5' },
        brand: { logo: 'brand/logo.svg' },
      })

      const served = await app.inject({ method: 'GET', url: '/api/brand/logo' })
      expect(served.statusCode).toBe(200)
      expect(served.body).toContain('<rect')
      expect(served.body).not.toContain('script')
      await app.close()
    })

    it('PUT of a clean SVG → sanitized: false; a space logo goes to the space repo', async () => {
      const { app, commits } = setup()
      const res = await app.inject({ method: 'PUT', url: '/api/spaces/docs/brand/logo', headers: svgPut('alice'), payload: LOGO })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ sanitized: false, url: '/api/spaces/docs/brand/logo' })
      expect(commits[0]).toMatchObject({ repo: 'docs', changes: [{ path: '_meta/brand/logo.svg' }, { path: '_meta/theme.yaml' }] })
      await app.close()
    })

    it('PNG body → 422 brand_not_svg, nothing committed', async () => {
      const { app, commits } = setup()
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
      const res = await app.inject({
        method: 'PUT',
        url: '/api/theme/brand/logo',
        headers: { ...as('alice'), 'content-type': 'image/png' },
        payload: png,
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().errors[0].code).toBe('brand_not_svg')
      expect(commits).toEqual([])
      await app.close()
    })

    it('body over 256 KB → 422 brand_too_large, nothing committed', async () => {
      const { app, commits } = setup()
      const big = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(300 * 1024)} --><rect width="1" height="1"></rect></svg>`
      const res = await app.inject({ method: 'PUT', url: '/api/theme/brand/logo', headers: svgPut('alice'), payload: big })
      expect(res.statusCode).toBe(422)
      expect(res.json().errors[0].code).toBe('brand_too_large')
      expect(commits).toEqual([])
      await app.close()
    })

    it('403 without push right, 404 on an unreadable space, nothing committed', async () => {
      const { app, commits } = setup()
      const instance = await app.inject({ method: 'PUT', url: '/api/theme/brand/logo', headers: svgPut('bob'), payload: LOGO })
      const favicon = await app.inject({ method: 'PUT', url: '/api/theme/brand/favicon', headers: svgPut('bob'), payload: FAVICON })
      const space = await app.inject({ method: 'PUT', url: '/api/spaces/docs/brand/logo', headers: svgPut('bob'), payload: LOGO })
      const hidden = await app.inject({ method: 'PUT', url: '/api/spaces/docs/brand/logo', headers: svgPut('mallory'), payload: LOGO })
      const del = await app.inject({ method: 'DELETE', url: '/api/theme/brand/logo', headers: as('bob') })
      expect([instance.statusCode, favicon.statusCode, space.statusCode, del.statusCode]).toEqual([403, 403, 403, 403])
      expect(hidden.statusCode).toBe(404)
      expect(commits).toEqual([])
      await app.close()
    })

    it('DELETE removes file and pointer in one commit; then GET and DELETE answer 404', async () => {
      const { app, store, commits } = setup(instanceFiles)
      expect((await app.inject({ method: 'GET', url: '/api/brand/logo' })).statusCode).toBe(200)

      const res = await app.inject({ method: 'DELETE', url: '/api/theme/brand/logo', headers: as('alice') })
      expect(res.statusCode).toBe(204)
      expect(commits).toEqual([
        {
          user: 'alice',
          repo: 'instance',
          message: 'Brand: remove logo',
          changes: [
            { op: 'delete', path: '_meta/brand/logo.svg' },
            { op: 'write', path: '_meta/theme.yaml' },
          ],
        },
      ])
      expect(store.has('instance:_meta/brand/logo.svg')).toBe(false)
      expect(parseYaml(store.get('instance:_meta/theme.yaml')!.content)).toEqual({
        brand: { name: 'Acme', favicon: 'brand/favicon.svg' },
      })

      expect((await app.inject({ method: 'GET', url: '/api/brand/logo' })).statusCode).toBe(404)
      const again = await app.inject({ method: 'DELETE', url: '/api/theme/brand/logo', headers: as('alice') })
      expect(again.statusCode).toBe(404)
      expect(commits).toHaveLength(1)
      await app.close()
    })

    it('DELETE of the last brand entry removes the emptied theme file', async () => {
      const { app, store, commits } = setup({
        'docs:_meta/theme.yaml': 'brand:\n  logo: brand/logo.svg\n',
        'docs:_meta/brand/logo.svg': SPACE_LOGO,
      })
      const res = await app.inject({ method: 'DELETE', url: '/api/spaces/docs/brand/logo', headers: as('alice') })
      expect(res.statusCode).toBe(204)
      expect(commits[0]!.changes).toEqual([
        { op: 'delete', path: '_meta/brand/logo.svg' },
        { op: 'delete', path: '_meta/theme.yaml' },
      ])
      expect(store.size).toBe(0)
      await app.close()
    })
  })

  describe('resolved.brand', () => {
    it('null without any brand', async () => {
      const { app } = setup()
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved' })
      expect(res.json().brand).toBeNull()
      await app.close()
    })

    it('instance brand → instance URLs, also for a space that inherits', async () => {
      const { app } = setup(instanceFiles)
      const expected = { name: 'Acme', logoUrl: '/api/brand/logo', faviconUrl: '/api/brand/favicon' }
      expect((await app.inject({ method: 'GET', url: '/api/theme/resolved' })).json().brand).toEqual(expected)
      const space = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('bob') })
      expect(space.json().brand).toEqual(expected)
      await app.close()
    })

    it('a space with its own logo → the space URL; name only → name without URLs', async () => {
      const own = setup({
        ...instanceFiles,
        'docs:_meta/theme.yaml': 'brand:\n  name: Docs Wiki\n  logo: brand/logo.svg\n',
        'docs:_meta/brand/logo.svg': SPACE_LOGO,
      })
      const res = await own.app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('bob') })
      expect(res.json().brand).toEqual({
        name: 'Docs Wiki',
        logoUrl: '/api/spaces/docs/brand/logo',
        faviconUrl: '/api/brand/favicon',
      })
      await own.app.close()

      invalidateInstanceTheme()
      invalidateAllSpaceThemes()
      invalidateBrand()
      const nameOnly = setup({ 'instance:_meta/theme.yaml': 'brand:\n  name: Acme\n' })
      const plain = await nameOnly.app.inject({ method: 'GET', url: '/api/theme/resolved' })
      expect(plain.json().brand).toEqual({ name: 'Acme', logoUrl: null, faviconUrl: null })
      await nameOnly.app.close()
    })
  })
})
