import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { pageReleases } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { write } from './helpers/seed-space.js'

/** Release archive, read path (#40): reconstruction from `_releases/`, routes, media. */
describe.sequential('release archive read path', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: ReturnType<typeof buildApp>
  const copyPath = 'ops/_releases/1.0.0/page.md'

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('release-read')
    await write(provider, repo, '_meta/schema.yaml', 'versioning: true\n')
    await write(provider, repo, 'ops/index.md', '---\nid: ops\ntitle: Ops\nversion: 1.1.0\n---\n# Ops\n\nToday\n')
    await write(
      provider,
      repo,
      copyPath,
      '---\ntitle: Ops\nversion: 1.0.0\nchangelog:\n  - version: 1.0.0\n    date: 2026-09-01\n    author: Jane\n    note: First\n'
        + 'release:\n  version: 1.0.0\n  date: 2026-09-01\n  by: Jane\n  source: ops\n---\n# Ops\n\nBack then\n\n![net](_media/net.png)\n',
    )
    await provider.writeFileBinary(repo, 'ops/_releases/1.0.0/_media/net.png', Buffer.from('frozen-png'), {
      branch: 'main',
      message: 'seed media',
    })
    space = { id: 'rr', name: 'RR', provider: 'forgejo', owner: repo.owner, repo: repo.repo, defaultLang: 'en', repoRef: repo }
    await indexSpace({ db, provider }, space)
    app = buildApp({ databaseUrl: pg.connectionString, spaces: [space], providerRegistry: () => provider })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('reindex rebuilds the row from the copy', async () => {
    const rows = await db.select().from(pageReleases).where(eq(pageReleases.pageId, 'ops'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ version: '1.0.0', path: copyPath, author: 'Jane', note: 'First', tampered: false })
  })

  it('lists and renders the frozen copy, images from its own folder', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/pages/ops/releases' })
    expect(list.json().releases.map((r: { version: string }) => r.version)).toEqual(['1.0.0'])

    const res = await app.inject({ method: 'GET', url: '/api/pages/ops/releases/1.0.0' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.html).toContain('Back then')
    expect(body.html).toContain('/media/ops/net.png?release=1.0.0')
    expect(body.release).toMatchObject({ version: '1.0.0', current: '1.1.0', tampered: false })

    const media = await app.inject({ method: 'GET', url: '/media/ops/net.png?release=1.0.0' })
    expect(media.statusCode).toBe(200)
    expect(media.body).toBe('frozen-png')

    const page = await app.inject({ method: 'GET', url: '/api/pages/ops' })
    expect(page.json().latestRelease).toBe('1.0.0')

    expect((await app.inject({ method: 'GET', url: '/api/pages/ops/releases/9.9.9' })).statusCode).toBe(404)
  })

  it('a changed copy is marked tampered, a deleted copy loses its row', async () => {
    const file = await provider.readFile(repo, copyPath, 'main')
    await provider.writeFile(repo, copyPath, file.content.replace('Back then', 'Rewritten'), {
      branch: 'main',
      message: 'tamper',
      sha: file.sha,
    })
    await indexSpace({ db, provider }, space)
    expect((await db.select().from(pageReleases).where(eq(pageReleases.pageId, 'ops')))[0]!.tampered).toBe(true)

    const changed = await provider.readFile(repo, copyPath, 'main')
    const media = await provider.readFileBinary(repo, 'ops/_releases/1.0.0/_media/net.png', 'main')
    await provider.commitFiles(
      repo,
      [
        { op: 'delete', path: copyPath, sha: changed.sha },
        { op: 'delete', path: 'ops/_releases/1.0.0/_media/net.png', sha: media.sha },
      ],
      { branch: 'main', message: 'drop release' },
    )
    await indexSpace({ db, provider }, space)
    expect(await db.select().from(pageReleases).where(eq(pageReleases.pageId, 'ops'))).toHaveLength(0)
  })
})
