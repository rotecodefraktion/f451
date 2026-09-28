import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/client.js'
import { pageVersions, spaces } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

describe('page_versions', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    // page_versions.spaceId ist eine NOT-NULL-FK auf spaces.id — vor den
    // Testfällen einmalig anlegen.
    await db.insert(spaces).values({
      id: 'handbuch',
      provider: 'forgejo',
      owner: 'dev-docs',
      repo: 'handbuch',
      name: 'Handbuch',
      defaultLang: 'de',
    })
  }, 120_000)

  afterAll(async () => {
    await handle.close()
    await pg.stop()
  })

  it('sortiert Versionen numerisch über major/minor/patch', async () => {
    await db.insert(pageVersions).values([
      {
        pageId: 'p-1',
        spaceId: 'handbuch',
        version: '1.2.0',
        major: 1,
        minor: 2,
        patch: 0,
        mergeSha: 'sha-b',
        blobSha: 'blob-b',
        author: 'A',
        note: '',
      },
      {
        pageId: 'p-1',
        spaceId: 'handbuch',
        version: '1.10.0',
        major: 1,
        minor: 10,
        patch: 0,
        mergeSha: 'sha-c',
        blobSha: 'blob-c',
        author: 'A',
        note: '',
      },
      {
        pageId: 'p-1',
        spaceId: 'handbuch',
        version: '1.0.0',
        major: 1,
        minor: 0,
        patch: 0,
        mergeSha: 'sha-a',
        blobSha: 'blob-a',
        author: 'A',
        note: '',
      },
    ])

    const rows = await db
      .select()
      .from(pageVersions)
      .where(eq(pageVersions.pageId, 'p-1'))
      .orderBy(desc(pageVersions.major), desc(pageVersions.minor), desc(pageVersions.patch))

    // Textsortierung würde '1.10.0' vor '1.2.0' fälschlich hinter '1.2.0'
    // einordnen (String-Vergleich '1' < '2') — die numerischen Spalten
    // major/minor/patch verhindern das.
    expect(rows.map((r) => r.version)).toEqual(['1.10.0', '1.2.0', '1.0.0'])
  })

  it('lässt dieselbe Version pro Seite nur einmal zu', async () => {
    await db.insert(pageVersions).values({
      pageId: 'p-2',
      spaceId: 'handbuch',
      version: '1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      mergeSha: 'sha-a',
      blobSha: 'blob-a',
      author: 'A',
      note: '',
    })
    await expect(
      db.insert(pageVersions).values({
        pageId: 'p-2',
        spaceId: 'handbuch',
        version: '1.0.0',
        major: 1,
        minor: 0,
        patch: 0,
        mergeSha: 'sha-x',
        blobSha: 'blob-x',
        author: 'B',
        note: '',
      }),
    ).rejects.toThrow()
  })
})
