import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { builtinTemplates, parseThemeFile } from '@f451/design-tokens'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { registerThemeRoutes, type ThemeDeps } from '../src/routes/theme.js'
import { registerThemeLibraryRoutes } from '../src/routes/theme-library.js'
import { invalidateContrastThresholds } from '../src/theme/contrast-config.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { expandLayer, invalidateLibrary, loadLibrary, type LibraryEntry } from '../src/theme/library.js'
import { invalidateAllSpaceThemes, invalidateSpaceTheme, SPACE_THEME_PATH } from '../src/theme/space-theme.js'
import type { InstanceConfig, SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 7, unit 7.2 (theme library). Plain Fastify with a stubbed session
 * (`x-test-user`, pattern `theme-write.test.ts`). One in-memory repo store backs the
 * service registry (read path, may list and read) and the per-user providers (write
 * path), so a read after a write sees the commit.
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

interface Call {
  op: 'write' | 'delete'
  user: string
  repo: string
  path: string
  message: string
}

const fileKey = (repo: RepoRef, path: string) => `${repo.repo}:${path}`

/** `user` = whose token the provider carries; `null` = the service account (read only). */
function fakeProvider(store: Store, calls: Call[], trees: string[], user: string | null): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the theme library`)
  }
  let seq = 0
  return {
    async readFile(repo, path) {
      const file = store.get(fileKey(repo, path))
      if (!file) throw new NotFoundError(path)
      return { path, content: file.content, sha: file.sha }
    },
    async listTree(repo) {
      trees.push(repo.repo)
      const prefix = `${repo.repo}:`
      const entries = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, file]) => ({ path: key.slice(prefix.length), type: 'file' as const, sha: file.sha }))
      return [{ path: '_meta', type: 'dir' as const, sha: 'd1' }, ...entries]
    },
    async writeFile(repo, path, content, opts) {
      if (user === null) throw new Error('the service account must not write')
      seq += 1
      calls.push({ op: 'write', user, repo: repo.repo, path, message: opts.message })
      store.set(fileKey(repo, path), { content, sha: `${user}-${seq}` })
      return { commitSha: `c-${seq}` }
    },
    async deleteFile(repo, path, opts) {
      if (user === null) throw new Error('the service account must not delete')
      if (!store.has(fileKey(repo, path))) throw new NotFoundError(path)
      calls.push({ op: 'delete', user, repo: repo.repo, path, message: opts.message })
      store.delete(fileKey(repo, path))
      return { commitSha: 'c-delete' }
    },
    readFileBinary: fail('readFileBinary'),
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

/** `files`: `<repo>:<path>` → YAML text. */
function setup(files: Record<string, string> = {}) {
  const store: Store = new Map()
  for (const [key, content] of Object.entries(files)) store.set(key, { content, sha: 'seed' })
  const calls: Call[] = []
  const trees: string[] = []
  const service = fakeProvider(store, calls, trees, null)

  const deps: ThemeDeps = {
    providerRegistry: () => service,
    instanceConfig,
    spaces: [docs],
    access: { canRead: async (userId) => USERS[userId]?.read === true },
    canWrite: async (userId) => USERS[userId]?.push === true,
    getUserProvider: async (userId) => (USERS[userId] ? fakeProvider(store, calls, trees, userId) : null),
  }

  const app: FastifyInstance = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    const userId = req.headers['x-test-user']
    req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
  })
  registerThemeRoutes(app, deps)
  registerThemeLibraryRoutes(app, deps)
  return { app, deps, store, calls, trees, service }
}

const as = (user: string) => ({ 'x-test-user': user })
const BUILTIN = builtinTemplates()[0]!.slug

const FOKUS = 'name: Fokus (house)\nbase:\n  weight-text: "400"\nlight:\n  color-accent: "#0b5fa5"\n'

describe('theme library', () => {
  afterEach(() => {
    invalidateInstanceTheme()
    invalidateAllSpaceThemes()
    invalidateContrastThresholds()
    invalidateLibrary()
  })

  describe('loadLibrary', () => {
    it('lists the built-ins with origin builtin when the instance repo has no templates', async () => {
      const { deps } = setup()
      const library = await loadLibrary(deps, { kind: 'instance' }, silent)
      expect(library.map((e) => [e.slug, e.origin])).toEqual(builtinTemplates().map((t) => [t.slug, 'builtin']))
    })

    it('an instance template replaces the built-in of the same slug in place; other files are ignored', async () => {
      const { deps } = setup({
        [`instance:_meta/themes/${BUILTIN}.yaml`]: 'name: Ours\nlight:\n  color-accent: "#0b5fa5"\n',
        'instance:_meta/themes/house.yaml': 'name: House\nbase:\n  weight-text: "400"\n',
        'instance:_meta/themes/README.md': '# not a template',
        'instance:_meta/themes/Bad_Slug.yaml': 'name: Bad\n',
        'instance:_meta/themes/sub/deep.yaml': 'name: Deep\n',
      })
      const library = await loadLibrary(deps, { kind: 'instance' }, silent)
      const same = library.filter((e) => e.slug === BUILTIN)
      expect(same).toHaveLength(1)
      expect(same[0]).toMatchObject({ origin: 'instance', name: 'Ours', file: { light: { 'color-accent': '#0b5fa5' } } })
      expect(library.findIndex((e) => e.slug === BUILTIN)).toBe(0)
      expect(library.at(-1)).toMatchObject({ slug: 'house', origin: 'instance', name: 'House' })
      expect(library.map((e) => e.slug)).not.toContain('Bad_Slug')
      expect(library.map((e) => e.slug)).not.toContain('deep')
    })

    it('skips a template with `use` or with errors, with a warning', async () => {
      const { deps } = setup({
        'instance:_meta/themes/nested.yaml': 'name: Nested\nuse: house\n',
        'instance:_meta/themes/broken.yaml': 'name: Broken\nlight:\n  color-nope: red\n',
        'instance:_meta/themes/ok.yaml': 'name: Ok\n',
      })
      const log = { warn: vi.fn(), debug: vi.fn() }
      const library = await loadLibrary(deps, { kind: 'instance' }, log)
      const slugs = library.map((e) => e.slug)
      expect(slugs).toContain('ok')
      expect(slugs).not.toContain('nested')
      expect(slugs).not.toContain('broken')
      expect(log.warn).toHaveBeenCalledTimes(2)
    })

    it('a space scope adds the space templates after the instance library; same slug stays in both namespaces', async () => {
      const { deps } = setup({
        'instance:_meta/themes/fokus.yaml': FOKUS,
        'docs:_meta/themes/fokus.yaml': 'name: Docs Fokus\nlight:\n  color-accent: "#aa3300"\n',
        'docs:_meta/themes/plain.yaml': 'name: Plain\n',
      })
      const library = await loadLibrary(deps, { kind: 'space', space: docs }, silent)
      const fokus = library.filter((e) => e.slug === 'fokus').map((e) => [e.origin, e.name])
      expect(fokus).toContainEqual(['instance', 'Fokus (house)'])
      expect(fokus).toContainEqual(['space', 'Docs Fokus'])
      expect(library.at(-1)).toMatchObject({ slug: 'plain', origin: 'space' })
      // The instance scope does not see space templates.
      const instanceOnly = await loadLibrary(deps, { kind: 'instance' }, silent)
      expect(instanceOnly.some((e) => e.origin === 'space')).toBe(false)
    })

    it('caches per repo for 5 minutes; invalidateSpaceTheme / invalidateInstanceTheme reread their repo', async () => {
      const { deps, trees } = setup({ 'docs:_meta/themes/plain.yaml': 'name: Plain\n' })
      await loadLibrary(deps, { kind: 'space', space: docs }, silent)
      await loadLibrary(deps, { kind: 'space', space: docs }, silent)
      expect(trees).toEqual(['instance', 'docs'])

      invalidateSpaceTheme('docs')
      await loadLibrary(deps, { kind: 'space', space: docs }, silent)
      expect(trees).toEqual(['instance', 'docs', 'docs'])

      invalidateInstanceTheme()
      await loadLibrary(deps, { kind: 'space', space: docs }, silent)
      expect(trees).toEqual(['instance', 'docs', 'docs', 'instance'])
    })
  })

  describe('use resolution', () => {
    it('a space file with `use: instance/fokus` → template values below, own values on top', async () => {
      const { app } = setup({
        'instance:_meta/themes/fokus.yaml': FOKUS,
        [`docs:${SPACE_THEME_PATH}`]: 'use: instance/fokus\nlight:\n  color-accent: "#aa3300"\n',
      })
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('alice') })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.origin.base['--weight-text']).toEqual({ source: 'space', template: 'fokus' })
      expect(body.origin.light['--color-accent']).toEqual({ source: 'space' })
      expect(body.css.light.join('\n')).toContain('#aa3300')
      expect(body.css.root.join('\n')).toContain('400')
      expect(body.layers).toEqual(['space'])
      await app.close()
    })

    it('`use: <slug>` in a space names the space library, `instance/<slug>` the instance one', async () => {
      const { app } = setup({
        'instance:_meta/themes/fokus.yaml': FOKUS,
        'docs:_meta/themes/fokus.yaml': 'name: Docs Fokus\nlight:\n  color-accent: "#aa3300"\n',
        [`docs:${SPACE_THEME_PATH}`]: 'use: fokus\n',
      })
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('alice') })
      expect(res.json().origin.light['--color-accent']).toEqual({ source: 'space', template: 'fokus' })
      expect(res.json().css.light.join('\n')).toContain('#aa3300')
      await app.close()
    })

    it('an unknown `use` → the layer applies without a template, with a warning', async () => {
      const { app } = setup({
        [`instance:${INSTANCE_THEME_PATH}`]: 'light:\n  color-accent: "#0b5fa5"\n',
        [`docs:${SPACE_THEME_PATH}`]: 'use: instance/gone\n',
      })
      const res = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('alice') })
      expect(res.statusCode).toBe(200)
      expect(res.json().origin.light['--color-accent']).toEqual({ source: 'instance' })
      expect(res.json().origin.base['--weight-text']).toEqual({ source: 'default' })
      await app.close()

      const log = { warn: vi.fn() }
      const parsed = parseThemeFile({ use: 'instance/gone', light: { 'color-accent': '#aa3300' } }, 'space')
      const layers = expandLayer(parsed, [] as LibraryEntry[], log)
      expect(layers).toEqual([parsed.layer])
      expect(log.warn).toHaveBeenCalledOnce()
    })

    it('a user layer never resolves an unprefixed slug (no own library)', () => {
      const library: LibraryEntry[] = [{ slug: 'fokus', name: 'Fokus', origin: 'instance', file: { name: 'Fokus' } }]
      const log = { warn: vi.fn() }
      const own = parseThemeFile({ use: 'fokus' }, 'user')
      expect(expandLayer(own, library, log)).toHaveLength(1)
      const prefixed = parseThemeFile({ use: 'instance/fokus' }, 'user')
      expect(expandLayer(prefixed, library, log)).toEqual([{ source: 'user', template: 'fokus' }, prefixed.layer])
    })

    it('PUT of a theme with an unknown `use` → 422 use_unknown; with a known one → 200', async () => {
      const { app, calls } = setup({ 'instance:_meta/themes/fokus.yaml': FOKUS })
      const bad = await app.inject({
        method: 'PUT',
        url: '/api/spaces/docs/theme',
        headers: as('alice'),
        payload: { use: 'instance/gone' },
      })
      expect(bad.statusCode).toBe(422)
      expect(bad.json().errors[0].code).toBe('use_unknown')
      expect(calls).toEqual([])

      const ownLibrary = await app.inject({
        method: 'PUT',
        url: '/api/spaces/docs/theme',
        headers: as('alice'),
        payload: { use: 'fokus' },
      })
      expect(ownLibrary.statusCode).toBe(422)

      const ok = await app.inject({
        method: 'PUT',
        url: '/api/spaces/docs/theme',
        headers: as('alice'),
        payload: { use: 'instance/fokus' },
      })
      expect(ok.statusCode).toBe(200)
      expect(calls.map((c) => c.path)).toEqual([SPACE_THEME_PATH])
      await app.close()
    })
  })

  describe('routes', () => {
    it('GET /api/theme/library and the space list', async () => {
      const { app } = setup({ 'docs:_meta/themes/plain.yaml': 'name: Plain\n' })
      const instance = await app.inject({ method: 'GET', url: '/api/theme/library', headers: as('bob') })
      expect(instance.statusCode).toBe(200)
      expect(instance.json().templates.every((t: LibraryEntry) => t.origin === 'builtin')).toBe(true)

      const space = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/library', headers: as('bob') })
      expect(space.statusCode).toBe(200)
      expect(space.json().templates.at(-1)).toMatchObject({ slug: 'plain', name: 'Plain', origin: 'space' })

      const unreadable = await app.inject({ method: 'GET', url: '/api/spaces/docs/theme/library', headers: as('mallory') })
      const unknown = await app.inject({ method: 'GET', url: '/api/spaces/nope/theme/library', headers: as('alice') })
      expect(unreadable.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
      expect(unreadable.json()).toMatchObject({ status: 'not_found' })
      await app.close()
    })

    it('PUT: 403 without push right, 404 on an unreadable space, nothing committed', async () => {
      const { app, calls } = setup()
      const body = { name: 'House', base: { 'weight-text': '400' } }
      const instance = await app.inject({ method: 'PUT', url: '/api/theme/library/house', headers: as('bob'), payload: body })
      const space = await app.inject({
        method: 'PUT',
        url: '/api/spaces/docs/theme/library/house',
        headers: as('mallory'),
        payload: body,
      })
      expect(instance.statusCode).toBe(403)
      expect(space.statusCode).toBe(404)
      expect(calls).toEqual([])
      await app.close()
    })

    it('PUT ok → writes _meta/themes/<slug>.yaml with the caller token and the list shows it', async () => {
      const { app, calls, store } = setup()
      await app.inject({ method: 'GET', url: '/api/theme/library', headers: as('alice') }) // prime the cache
      const res = await app.inject({
        method: 'PUT',
        url: '/api/theme/library/house',
        headers: as('alice'),
        payload: { name: 'House', base: { 'weight-text': '400' } },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().template).toMatchObject({ slug: 'house', name: 'House', origin: 'instance' })
      expect(calls).toEqual([
        { op: 'write', user: 'alice', repo: 'instance', path: '_meta/themes/house.yaml', message: 'Theme template: House' },
      ])
      expect(parseYaml(store.get('instance:_meta/themes/house.yaml')!.content)).toEqual({
        name: 'House',
        base: { 'weight-text': '400' },
      })

      const list = await app.inject({ method: 'GET', url: '/api/theme/library', headers: as('alice') })
      expect(list.json().templates.at(-1)).toMatchObject({ slug: 'house', origin: 'instance' })

      const space = await app.inject({
        method: 'PUT',
        url: '/api/spaces/docs/theme/library/house',
        headers: as('alice'),
        payload: { name: 'Docs House' },
      })
      expect(space.statusCode).toBe(200)
      expect(space.json().template).toMatchObject({ slug: 'house', origin: 'space' })
      expect(calls.at(-1)).toMatchObject({ repo: 'docs', path: '_meta/themes/house.yaml' })
      await app.close()
    })

    it('PUT of a template with `use` → 422 template_no_nesting', async () => {
      const { app, calls } = setup()
      const res = await app.inject({
        method: 'PUT',
        url: '/api/theme/library/house',
        headers: as('alice'),
        payload: { name: 'House', use: 'other' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().errors.map((e: { code: string }) => e.code)).toContain('template_no_nesting')
      expect(calls).toEqual([])
      await app.close()
    })

    it('PUT with contrast below the threshold → 422 contrast, like a theme', async () => {
      const { app, calls } = setup()
      const res = await app.inject({
        method: 'PUT',
        url: '/api/theme/library/pale',
        headers: as('alice'),
        payload: { name: 'Pale', light: { 'color-accent': '#dddddd' } },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().status).toBe('contrast')
      expect(calls).toEqual([])
      await app.close()
    })

    it('a slug outside [a-z0-9-]{1,40} → 422 slug_invalid', async () => {
      const { app, calls } = setup()
      const res = await app.inject({
        method: 'PUT',
        url: '/api/theme/library/Not_A_Slug',
        headers: as('alice'),
        payload: { name: 'x' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().errors[0].code).toBe('slug_invalid')
      expect(calls).toEqual([])
      await app.close()
    })

    it('PUT and DELETE of a built-in slug → 405', async () => {
      const { app, calls } = setup()
      const put = await app.inject({
        method: 'PUT',
        url: `/api/theme/library/${BUILTIN}`,
        headers: as('alice'),
        payload: { name: 'Mine' },
      })
      const del = await app.inject({ method: 'DELETE', url: `/api/theme/library/${BUILTIN}`, headers: as('alice') })
      expect(put.statusCode).toBe(405)
      expect(del.statusCode).toBe(405)
      expect(calls).toEqual([])
      await app.close()
    })

    it('DELETE: 403 without push right, 404 without the file, 204 removes it; a dangling `use` falls back', async () => {
      // `house`, not `fokus`: a built-in slug cannot be deleted (405).
      const { app, calls } = setup({
        'instance:_meta/themes/house.yaml': FOKUS,
        [`docs:${SPACE_THEME_PATH}`]: 'use: instance/house\n',
      })
      const before = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('alice') })
      expect(before.json().origin.base['--weight-text']).toEqual({ source: 'space', template: 'house' })

      const denied = await app.inject({ method: 'DELETE', url: '/api/theme/library/house', headers: as('bob') })
      expect(denied.statusCode).toBe(403)
      const missing = await app.inject({ method: 'DELETE', url: '/api/theme/library/nothing', headers: as('alice') })
      expect(missing.statusCode).toBe(404)

      const res = await app.inject({ method: 'DELETE', url: '/api/theme/library/house', headers: as('alice') })
      expect(res.statusCode).toBe(204)
      expect(calls).toEqual([
        { op: 'delete', user: 'alice', repo: 'instance', path: '_meta/themes/house.yaml', message: 'Theme template: remove house' },
      ])

      const after = await app.inject({ method: 'GET', url: '/api/theme/resolved?space=docs', headers: as('alice') })
      expect(after.statusCode).toBe(200)
      expect(after.json().origin.base['--weight-text']).toEqual({ source: 'default' })
      await app.close()
    })
  })
})
