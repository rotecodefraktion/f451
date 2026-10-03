import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { parse as parseYaml } from 'yaml'
import { buildApp } from '../src/app.js'
import { createSession, SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { users, userSettings } from '../src/db/schema.js'
import type { InstanceConfig } from '../src/spaces/config.js'
import { invalidateContrastThresholds } from '../src/theme/contrast-config.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../src/theme/instance-theme.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Theming Stage 6 (personal theme): `GET`/`PUT`/`DELETE /api/me/theme` and the
 * user layer of `GET /api/theme/resolved`, against the Postgres test database
 * with the real session gate (`buildApp` with `auth`). The instance repo is a
 * fake provider serving one theme file (pattern `theme-routes.test.ts`).
 */

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

const instanceConfig: InstanceConfig = {
  provider: 'forgejo',
  owner: 'f451',
  repo: 'instance',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'instance' },
}

const INSTANCE_FILE = 'light:\n  color-accent: "#0b5fa5"\n  color-border: "#cccccc"\n'

/** Serves the instance theme; every other path (e.g. `_meta/contrast.yaml`) is missing. */
function instanceProvider(): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the personal theme routes`)
  }
  return {
    async readFile(_repo, path) {
      if (path === INSTANCE_THEME_PATH) return { path, content: INSTANCE_FILE, sha: 'i' }
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

describe.sequential('personal theme (/api/me/theme)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance
  let userCounter = 0

  beforeAll(async () => {
    invalidateInstanceTheme()
    invalidateContrastThresholds()
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    const provider = instanceProvider()
    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      providerRegistry: () => provider,
      instanceConfig,
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    invalidateInstanceTheme()
    invalidateContrastThresholds()
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  /** A fresh user with a session; returns the id and the cookies for `inject`. */
  async function signedIn(prefix: string): Promise<{ userId: string; cookies: Record<string, string> }> {
    userCounter += 1
    const userId = `${prefix}-${userCounter}`
    await db.insert(users).values({ id: userId, email: `${userId}@example.org`, displayName: userId })
    const session = await createSession(db, userId)
    return { userId, cookies: { [SESSION_COOKIE_NAME]: session.id } }
  }

  function put(cookies: Record<string, string>, payload: unknown) {
    return app.inject({ method: 'PUT', url: '/api/me/theme', cookies, payload: payload as object })
  }

  it('GET without a row → 200 with an empty file', async () => {
    const { cookies } = await signedIn('empty')
    const res = await app.inject({ method: 'GET', url: '/api/me/theme', cookies })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.file).toEqual({})
    expect(body.problems).toEqual([])
    expect(Array.isArray(body.warnings)).toBe(true)
  })

  it('PUT JSON, then GET returns the stored file', async () => {
    const { cookies } = await signedIn('json')
    const file = { name: 'Mine', light: { 'color-accent': '#aa3300' } }
    const putRes = await put(cookies, file)
    expect(putRes.statusCode).toBe(200)
    expect(putRes.json().file).toEqual(file)

    const getRes = await app.inject({ method: 'GET', url: '/api/me/theme', cookies })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().file).toEqual(file)
  })

  it('PUT YAML stores the same file as the equivalent JSON', async () => {
    const { cookies: jsonCookies } = await signedIn('rt-json')
    const { cookies: yamlCookies } = await signedIn('rt-yaml')

    const jsonRes = await put(jsonCookies, { name: 'Round trip', light: { 'color-accent': '#aa3300' } })
    const yamlRes = await app.inject({
      method: 'PUT',
      url: '/api/me/theme',
      cookies: yamlCookies,
      headers: { 'content-type': 'application/yaml' },
      payload: 'name: Round trip\nlight:\n  color-accent: "#AA3300"\n',
    })
    expect(jsonRes.statusCode).toBe(200)
    expect(yamlRes.statusCode).toBe(200)
    expect(yamlRes.json().file).toEqual(jsonRes.json().file)

    const stored = await app.inject({ method: 'GET', url: '/api/me/theme', cookies: yamlCookies })
    expect(stored.json().file).toEqual(jsonRes.json().file)
  })

  it('GET ?format=yaml → text/yaml that parses back to the file', async () => {
    const { cookies } = await signedIn('yaml-out')
    const file = { name: 'Export', light: { 'color-accent': '#aa3300' }, dark: { 'color-accent': '#ff8855' } }
    expect((await put(cookies, file)).statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: '/api/me/theme?format=yaml', cookies })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/yaml')
    expect(parseYaml(res.body)).toEqual(file)

    // The export goes back in unchanged.
    const reimport = await app.inject({
      method: 'PUT',
      url: '/api/me/theme',
      cookies,
      headers: { 'content-type': 'text/yaml' },
      payload: res.body,
    })
    expect(reimport.statusCode).toBe(200)
    expect(reimport.json().file).toEqual(file)
  })

  it('a brand block is dropped with a problem, not stored', async () => {
    const { cookies } = await signedIn('brand')
    const res = await put(cookies, { light: { 'color-accent': '#aa3300' }, brand: { name: 'Me' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.file.brand).toBeUndefined()
    expect(body.problems.map((p: { code: string }) => p.code)).toContain('brand_ignored')
  })

  it('contrast below threshold does not block: #dddddd accent → 200 with warnings', async () => {
    const { cookies } = await signedIn('contrast')
    const res = await put(cookies, { light: { 'color-accent': '#dddddd' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.file.light['color-accent']).toBe('#dddddd')
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(body.warnings.every((w: { belowThreshold: boolean }) => w.belowThreshold)).toBe(true)
  })

  it('a locked token → 422 token_locked, nothing stored', async () => {
    const { userId, cookies } = await signedIn('locked')
    const res = await put(cookies, { base: { 'measure-full': '90%' } })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.status).toBe('invalid')
    expect(body.errors.map((e: { code: string }) => e.code)).toContain('token_locked')
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(rows).toEqual([])
  })

  it('an API token gets 403 session_required on every method', async () => {
    const { cookies } = await signedIn('token')
    const minted = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies,
      payload: { label: 'theme probe', scope: 'write' },
    })
    expect(minted.statusCode).toBe(200)
    const authorization = `Bearer ${(minted.json() as { token: string }).token}`

    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/me/theme',
        headers: { authorization },
        ...(method === 'PUT' ? { payload: { light: { 'color-accent': '#aa3300' } } } : {}),
      })
      expect(res.statusCode, method).toBe(403)
      expect(res.json().error, method).toBe('session_required')
    }
  })

  it('DELETE → 204, also when there is no row', async () => {
    const { userId, cookies } = await signedIn('delete')
    expect((await put(cookies, { light: { 'color-accent': '#aa3300' } })).statusCode).toBe(200)

    const first = await app.inject({ method: 'DELETE', url: '/api/me/theme', cookies })
    const second = await app.inject({ method: 'DELETE', url: '/api/me/theme', cookies })
    expect(first.statusCode).toBe(204)
    expect(second.statusCode).toBe(204)
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(rows).toEqual([])
  })

  it('deleting the user removes the row (on delete cascade)', async () => {
    const { userId, cookies } = await signedIn('cascade')
    expect((await put(cookies, { light: { 'color-accent': '#aa3300' } })).statusCode).toBe(200)
    expect(await db.select().from(userSettings).where(eq(userSettings.userId, userId))).toHaveLength(1)

    await db.delete(users).where(eq(users.id, userId))
    expect(await db.select().from(userSettings).where(eq(userSettings.userId, userId))).toEqual([])
  })

  it('resolved with a session carries the user layer last, and its value wins', async () => {
    const { cookies } = await signedIn('resolved')
    expect((await put(cookies, { light: { 'color-accent': '#aa3300' } })).statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: '/api/theme/resolved', cookies })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.layers).toEqual(['instance', 'user'])
    expect(body.css.light).toContain('--color-accent: #aa3300;')
    expect(body.css.light).not.toContain('--color-accent: #0b5fa5;')
    expect(body.origin.light['--color-accent'].source).toBe('user')
    // A token the user layer does not set is still inherited from the instance.
    expect(body.css.light).toContain('--color-border: #cccccc;')

    const anonymous = await app.inject({ method: 'GET', url: '/api/theme/resolved' })
    expect(anonymous.statusCode).toBe(200)
    expect(anonymous.json().layers).toEqual(['instance'])
  })
})
