import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { parsePage } from '@f451/markdown'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, users } from '../src/db/schema.js'
import { derivePageId, indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const ADMIN_TOKEN = 'backfill-admin-token'

interface BackfillSpaceResultBody {
  updated: string[]
  skipped: string[]
  alreadyHadId: number
  error?: string
}

/**
 * `POST /admin/backfill-ids` (Phase 3.1, „Stabile Seiten-Id + Backfill +
 * Redirect"): durchgehend über `buildApp`/`app.inject()` gegen echten
 * Forgejo- und PG-Container. Deckt ab:
 *  - Injektion einer fehlenden `id` + abschließender Reindex (`pages.id`/
 *    `edges` migrieren auf die neue Id, Wikilink-Auflösung bleibt PFADBASIERT
 *    und damit unverändert korrekt).
 *  - Skip bei offenem Draft-Branch UND bei aktivem Lock.
 *  - Idempotenz (zweiter Lauf ändert nichts).
 *  - Redirect-Lookup (`GET /api/pages/:id`): eine alte `path:`-Fallback-Id,
 *    die nach dem Reindex keine Zeile mehr trifft, liefert `{redirectTo}`.
 */
describe.sequential('POST /admin/backfill-ids (Phase 3.1)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: ReturnType<typeof buildApp>

  let ohneIdFallbackId: string
  let offenerDraftFallbackId: string
  let mitLockFallbackId: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('backfill-ids')

    // Startseite MIT Id, verlinkt per Wikilink auf die Id-lose Seite unten —
    // beweist nach dem Backfill, dass der Reindex die Kante auf die NEUE Id
    // migriert (Wikilink-Auflösung selbst bleibt pfadbasiert, unverändert).
    await provider.writeFile(
      repo,
      'index.md',
      '---\nid: home\ntitle: Startseite\nlang: de\n---\n# Startseite\n\nSiehe [[ohne-id]].\n',
      { branch: 'main', message: 'seed' },
    )
    // Seite OHNE Frontmatter-`id` — Backfill-Kandidatin.
    await provider.writeFile(
      repo,
      'ohne-id/index.md',
      '---\ntitle: Ohne Id\nlang: de\n---\n# Ohne Id\n',
      { branch: 'main', message: 'seed' },
    )
    // Seite OHNE Id, aber mit offenem Draft-Branch → muss übersprungen werden.
    await provider.writeFile(
      repo,
      'mit-offenem-draft/index.md',
      '---\ntitle: Mit Offenem Draft\nlang: de\n---\n# Mit Offenem Draft\n',
      { branch: 'main', message: 'seed' },
    )
    // Seite OHNE Id, aber mit aktivem Lock → muss übersprungen werden.
    await provider.writeFile(
      repo,
      'mit-lock/index.md',
      '---\ntitle: Mit Lock\nlang: de\n---\n# Mit Lock\n',
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'backfill-space',
      name: 'Backfill',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    await indexSpace({ db, provider }, space)

    ohneIdFallbackId = derivePageId(space.id, 'ohne-id/index.md', undefined)
    offenerDraftFallbackId = derivePageId(space.id, 'mit-offenem-draft/index.md', undefined)
    mitLockFallbackId = derivePageId(space.id, 'mit-lock/index.md', undefined)

    // Offenen Draft-Branch simulieren (kein voller Draft-Workflow über die API
    // nötig — `backfillSpace` prüft nur `branchExists`, s. `routes/admin.ts`).
    await provider.createBranch(repo, draftBranchName(offenerDraftFallbackId), 'main')

    // Aktiven Lock simulieren (direkter DB-Insert — `backfillSpace` prüft nur
    // `loadFreshLock`, kein voller Lock-Workflow über die API nötig).
    await db.insert(users).values({ id: 'lock-holder', email: 'lock-holder@example.org', displayName: 'Lock Holder' })
    await db.insert(locks).values({ pageId: mitLockFallbackId, userId: 'lock-holder', userName: 'Lock Holder' })

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      adminToken: ADMIN_TOKEN,
    })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('ohne Admin-Token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/backfill-ids', payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it(
    'injiziert fehlende Ids, überspringt offenen Draft-Branch UND aktiven Lock, migriert ' +
      'main-Index (`pages.id`/`edges`) auf die neuen Ids per abschließendem Reindex',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/backfill-ids',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { space: space.id },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { perSpace: Record<string, BackfillSpaceResultBody> }
      const result = body.perSpace[space.id]!

      expect(result.updated).toEqual(['ohne-id/index.md'])
      expect(result.skipped.sort()).toEqual(['mit-lock/index.md', 'mit-offenem-draft/index.md'].sort())
      // Nur „home" hatte zu diesem Zeitpunkt bereits eine Id.
      expect(result.alreadyHadId).toBe(1)

      // Die übersprungenen Seiten behalten ihre bisherige Fallback-Id — der
      // Backfill hat ihre Datei NICHT angefasst.
      const draftPageRow = (
        await db.select().from(pages).where(and(eq(pages.id, offenerDraftFallbackId), eq(pages.ref, 'main')))
      )[0]
      expect(draftPageRow?.path).toBe('mit-offenem-draft/index.md')
      const lockPageRow = (
        await db.select().from(pages).where(and(eq(pages.id, mitLockFallbackId), eq(pages.ref, 'main')))
      )[0]
      expect(lockPageRow?.path).toBe('mit-lock/index.md')

      // Die injizierte Seite: die ALTE Fallback-Id existiert nicht mehr als
      // Zeile (Voll-Reindex hat sie gelöscht, s. `indexSpace`), stattdessen
      // eine NEUE Zeile mit derselben `path`, aber generierter Id.
      const oldRow = (
        await db.select().from(pages).where(and(eq(pages.id, ohneIdFallbackId), eq(pages.ref, 'main')))
      )[0]
      expect(oldRow).toBeUndefined()

      const newRow = (
        await db
          .select()
          .from(pages)
          .where(and(eq(pages.spaceId, space.id), eq(pages.path, 'ohne-id/index.md'), eq(pages.ref, 'main')))
      )[0]
      expect(newRow).toBeDefined()
      expect(newRow!.id).toMatch(/^p-[0-9a-z]{10}$/)
      expect(newRow!.id).not.toBe(ohneIdFallbackId)

      // Frontmatter der geschriebenen Datei enthält jetzt die injizierte Id UND
      // ist weiterhin ein valider, `parsePage`-fehlerfreier Frontmatter-Block.
      const fileOnMain = await provider.readFile(repo, 'ohne-id/index.md', 'main')
      const parsed = parsePage(fileOnMain.content)
      expect(parsed.frontmatterErrors).toEqual([])
      expect(parsed.frontmatter.id).toBe(newRow!.id)
      expect(parsed.frontmatter.title).toBe('Ohne Id')

      // Kanten-Migration: die Startseite verlinkt per Wikilink auf `ohne-id` —
      // nach dem Reindex muss die gerenderte href die NEUE Id tragen.
      const homeRes = await app.inject({ method: 'GET', url: '/api/pages/home' })
      expect(homeRes.statusCode).toBe(200)
      expect(homeRes.json().html).toContain(`/wiki/${space.id}/${encodeURIComponent(newRow!.id)}`)
      expect(homeRes.json().brokenLinks).toEqual([])
    },
  )

  it('Redirect-Lookup: die alte `path:`-Fallback-Id trifft keine Zeile mehr → {redirectTo: <neue Id>}', async () => {
    const newRow = (
      await db
        .select()
        .from(pages)
        .where(and(eq(pages.spaceId, space.id), eq(pages.path, 'ohne-id/index.md'), eq(pages.ref, 'main')))
    )[0]!

    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${encodeURIComponent(ohneIdFallbackId)}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ redirectTo: newRow.id })

    // Die neue kanonische Id liefert ganz normal die volle Seite.
    const canonicalRes = await app.inject({ method: 'GET', url: `/api/pages/${encodeURIComponent(newRow.id)}` })
    expect(canonicalRes.statusCode).toBe(200)
    expect(canonicalRes.json().path).toBe('ohne-id/index.md')
  })

  it('eine unbekannte `path:`-Id ohne (spaceId, path)-Treffer bleibt weiterhin 404 (kein falscher Redirect)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/${encodeURIComponent(`path:${space.id}/gibt-es-nicht/index.md`)}`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('ist idempotent: ein zweiter Lauf injiziert nichts mehr (updated leer, alreadyHadId gestiegen)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backfill-ids',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { space: space.id },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { perSpace: Record<string, BackfillSpaceResultBody> }
    const result = body.perSpace[space.id]!

    expect(result.updated).toEqual([])
    // "home" UND die zuvor injizierte "ohne-id"-Seite haben jetzt beide eine Id.
    expect(result.alreadyHadId).toBe(2)
    expect(result.skipped.sort()).toEqual(['mit-lock/index.md', 'mit-offenem-draft/index.md'].sort())
  })

  it('unbekannter Space → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/backfill-ids',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { space: 'does-not-exist' },
    })
    expect(res.statusCode).toBe(404)
  })
})
