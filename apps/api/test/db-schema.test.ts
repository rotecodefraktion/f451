import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/db/client.js'
import { edges, locks, pages, providerAccounts, sessions, spaces, tags, users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

describe('DB-Schema', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
  }, 120_000)

  afterAll(async () => {
    await handle.close()
    await pg.stop()
  })

  it('legt alle Index-Tabellen an', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `)
    const tableNames = result.rows.map((r) => r.table_name)
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'spaces',
        'pages',
        'edges',
        'tags',
        'locks',
        'users',
        'sessions',
        'provider_accounts',
      ]),
    )
  })

  it('erzwingt UNIQUE(spaceId, path, ref) auf pages', async () => {
    await db.insert(spaces).values({
      id: 'betrieb',
      provider: 'forgejo',
      owner: 'dev-docs',
      repo: 'betrieb',
      name: 'Betrieb',
      defaultLang: 'de',
    })

    await db.insert(pages).values({
      id: 'page-1',
      spaceId: 'betrieb',
      path: 'a/index.md',
      ref: 'main',
      title: 'A',
      lang: 'de',
    })

    await expect(
      db.insert(pages).values({
        id: 'page-1-dup',
        spaceId: 'betrieb',
        path: 'a/index.md',
        ref: 'main',
        title: 'A (Duplikat)',
        lang: 'de',
      }),
    ).rejects.toThrow()
  })

  it('hat einen GIN-Index auf pages.search_vector', async () => {
    const result = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where tablename = 'pages' and indexdef ilike '%using gin%'
    `)
    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.rows.some((r) => r.indexdef.includes('search_vector'))).toBe(true)
  })

  it('kaskadiert edges und tags beim Löschen einer Page', async () => {
    await db.insert(spaces).values({
      id: 'cascade-space',
      provider: 'forgejo',
      owner: 'dev-docs',
      repo: 'cascade',
      name: 'Cascade',
      defaultLang: 'de',
    })

    await db.insert(pages).values([
      {
        id: 'cascade-a',
        spaceId: 'cascade-space',
        path: 'a/index.md',
        ref: 'main',
        title: 'A',
        lang: 'de',
      },
      {
        id: 'cascade-b',
        spaceId: 'cascade-space',
        path: 'b/index.md',
        ref: 'main',
        title: 'B',
        lang: 'de',
      },
    ])

    await db.insert(edges).values({
      fromPageId: 'cascade-a',
      toPageId: 'cascade-b',
      rawTarget: 'b',
      type: 'link',
    })
    await db.insert(tags).values({ pageId: 'cascade-a', tag: 'wichtig' })
    // `locks.userId` ist eine NOT-NULL-FK auf `users.id` (P1-Fix Phase 2a) —
    // braucht daher eine echte `users`-Zeile.
    await db.insert(users).values({ id: 'cascade-lock-user', email: 'lock-user@example.org', displayName: 'alice' })
    await db.insert(locks).values({ pageId: 'cascade-a', userId: 'cascade-lock-user', userName: 'alice' })

    await db.delete(pages).where(sql`${pages.id} = 'cascade-a'`)

    const remainingEdges = await db
      .select()
      .from(edges)
      .where(sql`${edges.fromPageId} = 'cascade-a'`)
    const remainingTags = await db.select().from(tags).where(sql`${tags.pageId} = 'cascade-a'`)
    const remainingLocks = await db
      .select()
      .from(locks)
      .where(sql`${locks.pageId} = 'cascade-a'`)

    expect(remainingEdges).toHaveLength(0)
    expect(remainingTags).toHaveLength(0)
    expect(remainingLocks).toHaveLength(0)
  })

  it('kaskadiert locks beim Löschen des haltenden Users (P1-Fix Phase 2a: locks.userId FK auf users.id)', async () => {
    await db.insert(spaces).values({
      id: 'lock-cascade-space',
      provider: 'forgejo',
      owner: 'dev-docs',
      repo: 'lock-cascade',
      name: 'Lock Cascade',
      defaultLang: 'de',
    })
    await db.insert(pages).values({
      id: 'lock-cascade-page',
      spaceId: 'lock-cascade-space',
      path: 'a/index.md',
      ref: 'main',
      title: 'A',
      lang: 'de',
    })
    await db.insert(users).values({
      id: 'lock-cascade-user',
      email: 'lock-cascade@example.org',
      displayName: 'Lock Cascade User',
    })
    await db.insert(locks).values({
      pageId: 'lock-cascade-page',
      userId: 'lock-cascade-user',
      userName: 'Lock Cascade User',
    })

    await db.delete(users).where(sql`${users.id} = 'lock-cascade-user'`)

    const remainingLocks = await db
      .select()
      .from(locks)
      .where(sql`${locks.pageId} = 'lock-cascade-page'`)
    expect(remainingLocks).toHaveLength(0)
  })

  describe('edges.ref FK-Härtung (P1-Fix Phase 2a, umgesetzt Phase 2d Task 1)', () => {
    it('Broken-Link-Mechanik überlebt: Zielseite löschen → to_page_id NULL, ref bleibt "main"', async () => {
      await db.insert(spaces).values({
        id: 'fk-broken-link-space',
        provider: 'forgejo',
        owner: 'dev-docs',
        repo: 'fk-broken-link',
        name: 'FK Broken Link',
        defaultLang: 'de',
      })
      await db.insert(pages).values([
        {
          id: 'fk-broken-link-a',
          spaceId: 'fk-broken-link-space',
          path: 'a/index.md',
          ref: 'main',
          title: 'A',
          lang: 'de',
        },
        {
          id: 'fk-broken-link-b',
          spaceId: 'fk-broken-link-space',
          path: 'b/index.md',
          ref: 'main',
          title: 'B',
          lang: 'de',
        },
      ])
      await db.insert(edges).values({
        fromPageId: 'fk-broken-link-a',
        toPageId: 'fk-broken-link-b',
        rawTarget: 'b',
        type: 'link',
        ref: 'main',
      })

      await db.delete(pages).where(sql`${pages.id} = 'fk-broken-link-b'`)

      const rows = await db
        .select()
        .from(edges)
        .where(sql`${edges.fromPageId} = 'fk-broken-link-a'`)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.toPageId).toBeNull()
      expect(rows[0]!.ref).toBe('main')
    })

    it('lehnt eine Kante mit ref=NULL ab (schließt die MATCH-SIMPLE-Lücke: früher unbemerkt ungeprüfte to_page_id-Referenz)', async () => {
      await db.insert(spaces).values({
        id: 'fk-match-simple-space',
        provider: 'forgejo',
        owner: 'dev-docs',
        repo: 'fk-match-simple',
        name: 'FK Match Simple',
        defaultLang: 'de',
      })
      await db.insert(pages).values([
        {
          id: 'fk-match-simple-a',
          spaceId: 'fk-match-simple-space',
          path: 'a/index.md',
          ref: 'main',
          title: 'A',
          lang: 'de',
        },
        {
          id: 'fk-match-simple-b',
          spaceId: 'fk-match-simple-space',
          path: 'b/index.md',
          ref: 'main',
          title: 'B',
          lang: 'de',
        },
      ])

      // Roh-SQL statt Drizzle-Insert: der generierte Typ lässt `ref: null` gar
      // nicht mehr zu (NOT NULL), genau das ist der Beweis, dass die Lücke zu
      // ist — dieser INSERT muss an der DB-Constraint scheitern, nicht erst am
      // TS-Compiler.
      await expect(
        db.execute(sql`
          insert into edges (from_page_id, to_page_id, raw_target, type, label, ref)
          values ('fk-match-simple-a', 'fk-match-simple-b', 'b', 'link', '', NULL)
        `),
      ).rejects.toThrow()
    })

    it('lehnt eine Kante mit abweichender ref ohne passende pages(id,ref)-Zeile ab', async () => {
      await db.insert(spaces).values({
        id: 'fk-wrong-ref-space',
        provider: 'forgejo',
        owner: 'dev-docs',
        repo: 'fk-wrong-ref',
        name: 'FK Wrong Ref',
        defaultLang: 'de',
      })
      await db.insert(pages).values([
        {
          id: 'fk-wrong-ref-a',
          spaceId: 'fk-wrong-ref-space',
          path: 'a/index.md',
          ref: 'main',
          title: 'A',
          lang: 'de',
        },
        {
          id: 'fk-wrong-ref-b',
          spaceId: 'fk-wrong-ref-space',
          path: 'b/index.md',
          ref: 'main',
          title: 'B',
          lang: 'de',
        },
      ])

      // fk-wrong-ref-b existiert nur mit ref='main', nicht mit ref='draft'.
      await expect(
        db.insert(edges).values({
          fromPageId: 'fk-wrong-ref-a',
          toPageId: 'fk-wrong-ref-b',
          rawTarget: 'b',
          type: 'link',
          ref: 'draft',
        }),
      ).rejects.toThrow()
    })
  })

  describe('Auth-Schema (users, sessions, provider_accounts)', () => {
    it('kaskadiert sessions beim Löschen eines Users', async () => {
      await db.insert(users).values({
        id: 'user-cascade',
        email: 'cascade@example.org',
        displayName: 'Cascade User',
      })
      await db.insert(sessions).values({
        id: 'session-cascade',
        userId: 'user-cascade',
        expiresAt: new Date(Date.now() + 60_000),
      })

      await db.delete(users).where(sql`${users.id} = 'user-cascade'`)

      const remainingSessions = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.id} = 'session-cascade'`)
      expect(remainingSessions).toHaveLength(0)
    })

    it('kaskadiert provider_accounts beim Löschen eines Users', async () => {
      await db.insert(users).values({
        id: 'user-provider-cascade',
        email: 'provider-cascade@example.org',
        displayName: 'Provider Cascade User',
      })
      await db.insert(providerAccounts).values({
        userId: 'user-provider-cascade',
        provider: 'forgejo',
        providerLogin: 'octocat',
        encryptedAccessToken: 'v1:aa:bb:cc',
      })

      await db.delete(users).where(sql`${users.id} = 'user-provider-cascade'`)

      const remaining = await db
        .select()
        .from(providerAccounts)
        .where(sql`${providerAccounts.userId} = 'user-provider-cascade'`)
      expect(remaining).toHaveLength(0)
    })

    it('erzwingt PRIMARY KEY(user_id, provider) auf provider_accounts', async () => {
      await db.insert(users).values({
        id: 'user-pk',
        email: 'pk@example.org',
        displayName: 'PK User',
      })
      await db.insert(providerAccounts).values({
        userId: 'user-pk',
        provider: 'github',
        providerLogin: 'octocat',
        encryptedAccessToken: 'v1:aa:bb:cc',
      })

      await expect(
        db.insert(providerAccounts).values({
          userId: 'user-pk',
          provider: 'github',
          providerLogin: 'octocat-2',
          encryptedAccessToken: 'v1:dd:ee:ff',
        }),
      ).rejects.toThrow()

      // Anderer Provider für denselben User ist erlaubt (zusammengesetzter PK).
      await expect(
        db.insert(providerAccounts).values({
          userId: 'user-pk',
          provider: 'forgejo',
          providerLogin: 'octocat',
          encryptedAccessToken: 'v1:gg:hh:ii',
        }),
      ).resolves.not.toThrow()
    })

    it('erlaubt encryptedRefreshToken als NULL', async () => {
      await db.insert(users).values({
        id: 'user-null-refresh',
        email: 'null-refresh@example.org',
        displayName: 'Null Refresh User',
      })
      await expect(
        db.insert(providerAccounts).values({
          userId: 'user-null-refresh',
          provider: 'github',
          providerLogin: 'octocat',
          encryptedAccessToken: 'v1:aa:bb:cc',
        }),
      ).resolves.not.toThrow()
    })
  })
})
