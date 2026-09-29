import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { ForgejoProvider, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { createDb, type Db } from '../src/db/client.js'
import { edges, pages, spaces, tags } from '../src/db/schema.js'
import { indexSpace, type IndexReport } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Provider-Wrapper für Regressionstests (F1): delegiert alle Methoden an den
 * echten Provider, aber `readFile` wirft für `failPath` genau einmal einen
 * transienten Fehler (danach wieder normales Verhalten — simuliert einen
 * kurzzeitigen IO/Netzwerk-Ausfall statt eines dauerhaft fehlenden Pfads).
 */
function throwOnceOnReadFile(inner: GitProvider, failPath: string): GitProvider {
  let thrown = false
  return {
    readFile: async (repo, path, ref) => {
      if (path === failPath && !thrown) {
        thrown = true
        throw new Error('simulated transient IO error')
      }
      return inner.readFile(repo, path, ref)
    },
    readFileBinary: (repo, path, ref) => inner.readFileBinary(repo, path, ref),
    listTree: (repo, ref) => inner.listTree(repo, ref),
    getHeadSha: (repo, branch) => inner.getHeadSha(repo, branch),
    writeFile: (repo, path, content, opts) => inner.writeFile(repo, path, content, opts),
    writeFileBinary: (repo, path, content, opts) => inner.writeFileBinary(repo, path, content, opts),
    createBranch: (repo, name, fromBranch) => inner.createBranch(repo, name, fromBranch),
    deleteBranch: (repo, name) => inner.deleteBranch(repo, name),
    listCommits: (repo, opts) => inner.listCommits(repo, opts),
    createPullRequest: (repo, opts) => inner.createPullRequest(repo, opts),
    getPullRequest: (repo, number) => inner.getPullRequest(repo, number),
    mergePullRequest: (repo, number) => inner.mergePullRequest(repo, number),
  }
}

/** Schreibt eine Datei auf main (POST = anlegen). */
async function write(
  provider: ForgejoProvider,
  repo: RepoRef,
  path: string,
  content: string,
): Promise<void> {
  await provider.writeFile(repo, path, content, { branch: 'main', message: `seed: ${path}` })
}

/** Löscht eine Datei auf main über die Forgejo-Content-API (kein Provider-Vertrag). */
async function deleteFile(
  inst: ForgejoTestInstance,
  repo: RepoRef,
  path: string,
): Promise<void> {
  const provider = new ForgejoProvider({ baseUrl: inst.baseUrl, token: inst.token })
  const file = await provider.readFile(repo, path, 'main')
  const res = await fetch(
    `${inst.baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}/contents/${path}`,
    {
      method: 'DELETE',
      headers: { Authorization: `token ${inst.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'main', message: `delete ${path}`, sha: file.sha }),
    },
  )
  if (!res.ok) throw new Error(`Löschen fehlgeschlagen (${res.status}): ${await res.text()}`)
}

/** Seedet einen realistischen Wiki-Baum: 5 Seiten inkl. Unterordner, Wikilink,
 *  relativem Link, kaputtem Link, Relation, Tags und einer Seite mit kaputtem YAML. */
async function seed(provider: ForgejoProvider, repo: RepoRef): Promise<void> {
  await write(provider, repo, 'index.md', `---
id: home
title: Startseite
lang: de
tags:
  - start
---
# Startseite

Siehe [[betrieb/deployment]] und den fehlenden [[gibt-es-nicht]].
`)

  await write(provider, repo, 'betrieb/index.md', `---
id: betrieb
title: Betrieb
lang: de
tags: [betrieb, wichtig]
relations:
  depends_on:
    - deployment
---
# Betrieb

Zum [[Monitoring]] siehe dort.
`)

  await write(provider, repo, 'betrieb/deployment/index.md', `---
id: deployment
title: Deployment
lang: de
tags: [ops]
---
# Deployment

Details zum Deployment. Siehe [Monitoring](../monitoring/index.md).

![Diagramm](./img/arch.png)

![Architektur](_media/arch.drawio.svg)
`)

  await write(provider, repo, 'betrieb/monitoring/index.md', `---
id: monitoring
title: Monitoring
lang: en
tags: [ops, observability]
---
# Monitoring

Observability and monitoring dashboards.
`)

  await write(provider, repo, 'betrieb/broken-yaml/index.md', `---
title: "Kaputt
tags: [a, b
---
# Kaputte Seite

Body-Text der kaputten Seite.
`)
}

/** Reproduzierbare Momentaufnahme des Index-Zustands (ohne updatedAt/searchVector). */
async function snapshot(db: Db): Promise<{ pages: string; edges: string; tags: string }> {
  const pageRows = await db.select().from(pages)
  const edgeRows = await db.select().from(edges)
  const tagRows = await db.select().from(tags)
  const p = pageRows
    .map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      lang: r.lang,
      errorStatus: r.errorStatus,
      html: r.htmlRendered,
      plain: r.plainText,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const e = edgeRows
    .map((r) => ({ f: r.fromPageId, t: r.toPageId, raw: r.rawTarget, type: r.type, label: r.label }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const t = tagRows
    .map((r) => ({ p: r.pageId, tag: r.tag }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return { pages: JSON.stringify(p), edges: JSON.stringify(e), tags: JSON.stringify(t) }
}

describe.sequential('indexSpace (Voll-Reindex)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let firstReport: IndexReport

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('indexer')
    await seed(provider, repo)

    space = {
      id: 'betrieb',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('indexiert alle Seiten, Kanten, Tags, Hierarchie, Suche und HTML-Cache', async () => {
    firstReport = await indexSpace({ db, provider }, space)

    expect(firstReport.pagesIndexed).toBe(5)
    expect(firstReport.pagesWithErrors).toBe(1)
    expect(firstReport.brokenLinks).toBe(1)
    expect(firstReport.headSha).toMatch(/^[0-9a-f]{40}$/)

    // Seiten
    const allPages = await db.select().from(pages)
    expect(allPages).toHaveLength(5)
    const ids = allPages.map((p) => p.id).sort()
    expect(ids).toContain('home')
    expect(ids).toContain('betrieb')
    expect(ids).toContain('deployment')
    expect(ids).toContain('monitoring')
    // Seite ohne Frontmatter-id → deterministische Fallback-Id.
    expect(ids).toContain('path:betrieb/betrieb/broken-yaml/index.md')

    // Kaputtes YAML → Fehlerstatus + Rohtext als plainText, Batch lief weiter.
    const broken = allPages.find((p) => p.id === 'path:betrieb/betrieb/broken-yaml/index.md')!
    expect(broken.errorStatus).toBe('parse_error')
    expect(broken.plainText).toContain('Body-Text der kaputten Seite.')
    expect((broken.frontmatterErrors as string[]).length).toBeGreaterThan(0)

    // Wikilink (Pfad-Match) aufgelöst
    const linkDeployment = await db
      .select()
      .from(edges)
      .where(
        and(eq(edges.fromPageId, 'home'), eq(edges.rawTarget, 'betrieb/deployment'), eq(edges.type, 'link')),
      )
    expect(linkDeployment[0]?.toPageId).toBe('deployment')

    // Wikilink (Titel-Match, case-insensitive) aufgelöst
    const linkMonitoring = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'betrieb'), eq(edges.rawTarget, 'Monitoring'), eq(edges.type, 'link')))
    expect(linkMonitoring[0]?.toPageId).toBe('monitoring')

    // Relativer Link (Normalisierung relativ zur Quellseite) aufgelöst
    const relativeLink = await db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.fromPageId, 'deployment'),
          eq(edges.rawTarget, '../monitoring/index.md'),
          eq(edges.type, 'link'),
        ),
      )
    expect(relativeLink[0]?.toPageId).toBe('monitoring')

    // Kaputter Link → Broken-Link-Kante (toPageId null, rawTarget befüllt)
    const brokenLink = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'home'), eq(edges.rawTarget, 'gibt-es-nicht'), eq(edges.type, 'link')))
    expect(brokenLink).toHaveLength(1)
    expect(brokenLink[0]?.toPageId).toBeNull()

    // Relation aus Frontmatter (Label = Typ)
    const relation = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'betrieb'), eq(edges.type, 'relation'), eq(edges.label, 'depends_on')))
    expect(relation[0]?.toPageId).toBe('deployment')
    expect(relation[0]?.rawTarget).toBe('deployment')

    // Hierarchie aus Verzeichnisstruktur
    const hierBetrieb = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'betrieb'), eq(edges.type, 'hierarchy')))
    expect(hierBetrieb[0]?.toPageId).toBe('home')
    const hierDeployment = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'deployment'), eq(edges.type, 'hierarchy')))
    expect(hierDeployment[0]?.toPageId).toBe('betrieb')

    // Tags
    const betriebTags = await db.select().from(tags).where(eq(tags.pageId, 'betrieb'))
    expect(betriebTags.map((t) => t.tag).sort()).toEqual(['betrieb', 'wichtig'])
    const monitoringTags = await db.select().from(tags).where(eq(tags.pageId, 'monitoring'))
    expect(monitoringTags.map((t) => t.tag).sort()).toEqual(['observability', 'ops'])

    // Suchvektor gesetzt für alle Seiten
    const nullVectors = await db.select().from(pages).where(isNull(pages.searchVector))
    expect(nullVectors).toHaveLength(0)

    // Gestemmte Suche (de): "Deployments" findet die "Deployment"-Seite
    const stem = await db.execute<{ id: string }>(
      sql`select id from pages where search_vector @@ websearch_to_tsquery('german', 'Deployments')`,
    )
    expect(stem.rows.some((r) => r.id === 'deployment')).toBe(true)

    // HTML-Cache: aufgelöste Hrefs, Broken-Link-Markierung und Media-Pfad
    const home = (await db.select().from(pages).where(eq(pages.id, 'home')))[0]!
    expect(home.htmlRendered).toContain('/wiki/betrieb/deployment')
    expect(home.htmlRendered).toContain('broken-link')
    const deployment = (await db.select().from(pages).where(eq(pages.id, 'deployment')))[0]!
    expect(deployment.htmlRendered).toContain('/wiki/betrieb/monitoring')
    expect(deployment.htmlRendered).toContain('/media/deployment/img/arch.png')
    // Regression: führendes `_media/`-Präfix im src wird vor dem Bau der /media-URL
    // gestrippt (sonst würde die Media-Route serverseitig `_media/_media/...` suchen
    // und 404 liefern, siehe routes/media.ts).
    expect(deployment.htmlRendered).toContain('src="/media/deployment/arch.drawio.svg"')
  }, 120_000)

  it('ist idempotent: zweiter Lauf ergibt identischen Zustand', async () => {
    const before = await snapshot(db)
    const secondReport = await indexSpace({ db, provider }, space)

    expect(secondReport).toEqual(firstReport)
    const after = await snapshot(db)
    expect(after.pages).toEqual(before.pages)
    expect(after.edges).toEqual(before.edges)
    expect(after.tags).toEqual(before.tags)
  }, 120_000)

  it('löscht verschwundene Seiten und degradiert eingehende Kanten zu Broken Links', async () => {
    await deleteFile(forgejo, repo, 'betrieb/monitoring/index.md')
    const report = await indexSpace({ db, provider }, space)

    // Lösch-Fall: Seite verschwindet aus dem Index
    expect(report.pagesIndexed).toBe(4)
    const remaining = await db.select().from(pages)
    expect(remaining.map((p) => p.id)).not.toContain('monitoring')

    // SET-NULL-/Broken-Link-Fall: eingehende Kanten zeigen ins Leere, rawTarget bleibt
    const fromDeployment = await db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.fromPageId, 'deployment'),
          eq(edges.rawTarget, '../monitoring/index.md'),
          eq(edges.type, 'link'),
        ),
      )
    expect(fromDeployment).toHaveLength(1)
    expect(fromDeployment[0]?.toPageId).toBeNull()

    const fromBetrieb = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'betrieb'), eq(edges.rawTarget, 'Monitoring'), eq(edges.type, 'link')))
    expect(fromBetrieb[0]?.toPageId).toBeNull()

    // Jetzt drei Broken Links (gibt-es-nicht, deployment→monitoring, betrieb→monitoring)
    expect(report.brokenLinks).toBe(3)
  }, 120_000)
})

describe.sequential('indexSpace: transienter IO-Fehler beim Lesen (F1)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('indexer-io-error')
    await seed(provider, repo)

    space = {
      id: 'betrieb-io',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it(
    'überspringt eine Datei bei transientem readFile-Fehler statt die Seite zu leeren; ' +
      'zweiter Lauf ohne Fehler bringt alles auf den aktuellen Stand',
    async () => {
      const warnCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = []
      const logger = { warn: (msg: string, meta?: Record<string, unknown>) => warnCalls.push({ msg, meta }) }

      // Erstindex ohne Fehler: sauberer Ausgangszustand.
      const first = await indexSpace({ db, provider, logger }, space)
      expect(first.filesSkippedIo).toBe(0)
      expect(first.pagesIndexed).toBe(5)

      const deploymentBefore = (await db.select().from(pages).where(eq(pages.id, 'deployment')))[0]!
      const deploymentEdgesBefore = await db.select().from(edges).where(eq(edges.fromPageId, 'deployment'))
      const spaceRowBefore = (await db.select().from(spaces).where(eq(spaces.id, space.id)))[0]!
      expect(spaceRowBefore.indexedHeadSha).toBe(first.headSha)

      // Kante von 'home' auf 'deployment' (Wikilink) vor dem fehlerhaften Lauf.
      const inboundBefore = await db
        .select()
        .from(edges)
        .where(
          and(eq(edges.fromPageId, 'home'), eq(edges.rawTarget, 'betrieb/deployment'), eq(edges.type, 'link')),
        )
      expect(inboundBefore[0]?.toPageId).toBe('deployment')

      // readFile wirft für 'betrieb/deployment/index.md' genau einmal (transienter Fehler).
      const flakyProvider = throwOnceOnReadFile(provider, 'betrieb/deployment/index.md')
      const second = await indexSpace({ db, provider: flakyProvider, logger }, space)

      // Fehler wurde gezählt und geloggt, statt die Seite still zu leeren.
      expect(second.filesSkippedIo).toBe(1)
      expect(second.pagesIndexed).toBe(4)
      expect(warnCalls).toHaveLength(1)
      expect(warnCalls[0]?.meta?.path).toBe('betrieb/deployment/index.md')

      // Seite bleibt UNVERÄNDERT im Index (alter Inhalt, nicht geleert, nicht gelöscht).
      const deploymentAfter = (await db.select().from(pages).where(eq(pages.id, 'deployment')))[0]!
      expect(deploymentAfter).toEqual(deploymentBefore)

      // Ausgehende Kanten der übersprungenen Seite bleiben intakt (unangetastet).
      const deploymentEdgesAfter = await db.select().from(edges).where(eq(edges.fromPageId, 'deployment'))
      expect(deploymentEdgesAfter).toEqual(deploymentEdgesBefore)

      // Eingehende Kante (home → deployment) bleibt aufgelöst statt zu Broken Link zu degradieren.
      const inboundAfter = await db
        .select()
        .from(edges)
        .where(
          and(eq(edges.fromPageId, 'home'), eq(edges.rawTarget, 'betrieb/deployment'), eq(edges.type, 'link')),
        )
      expect(inboundAfter[0]?.toPageId).toBe('deployment')

      // indexedHeadSha NICHT auf den neuen HEAD gesetzt (Drift-Job soll den Lauf wiederholen).
      const spaceRowAfter = (await db.select().from(spaces).where(eq(spaces.id, space.id)))[0]!
      expect(spaceRowAfter.indexedHeadSha).toBe(spaceRowBefore.indexedHeadSha)

      // Zweiter Lauf ohne Fehler → alles wieder aktuell, inkl. indexedHeadSha.
      const third = await indexSpace({ db, provider, logger }, space)
      expect(third.filesSkippedIo).toBe(0)
      expect(third.pagesIndexed).toBe(5)
      const spaceRowThird = (await db.select().from(spaces).where(eq(spaces.id, space.id)))[0]!
      expect(spaceRowThird.indexedHeadSha).toBe(third.headSha)
      const deploymentFinal = (await db.select().from(pages).where(eq(pages.id, 'deployment')))[0]!
      expect(deploymentFinal.updatedAt.getTime()).toBeGreaterThan(deploymentBefore.updatedAt.getTime())
    },
    120_000,
  )
})

describe.sequential('indexSpace: _media/-Anhang-Links erzeugen keine Broken-Link-Kante (Bugfix Live-Betrieb)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('indexer-media-links')

    await write(provider, repo, 'index.md', `---
id: home
title: Startseite
lang: de
---
# Startseite

Anhang: [Handbuch](_media/handbuch.pdf) und ein kaputter Seiten-Link [[gibt-es-nicht]].
`)

    space = {
      id: 'betrieb-media',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it(
    'legt für einen _media/-Anhang-Link keine Kante an und zählt ihn nicht als Broken Link — ' +
      'ein echter kaputter Seiten-Link bleibt weiterhin broken (Regression)',
    async () => {
      const report = await indexSpace({ db, provider }, space)

      // Nur der echte kaputte Seiten-Link ("[[gibt-es-nicht]]") zählt — der Anhang nicht.
      expect(report.brokenLinks).toBe(1)

      // Anhang-Link erzeugt GAR KEINE Kante (weder aufgelöst noch broken).
      const mediaEdge = await db
        .select()
        .from(edges)
        .where(
          and(eq(edges.fromPageId, 'home'), eq(edges.rawTarget, '_media/handbuch.pdf'), eq(edges.type, 'link')),
        )
      expect(mediaEdge).toHaveLength(0)

      // Echter kaputter Seiten-Wikilink bleibt als Broken-Link-Kante bestehen (kein Regress).
      const brokenPageLink = await db
        .select()
        .from(edges)
        .where(and(eq(edges.fromPageId, 'home'), eq(edges.rawTarget, 'gibt-es-nicht'), eq(edges.type, 'link')))
      expect(brokenPageLink).toHaveLength(1)
      expect(brokenPageLink[0]?.toPageId).toBeNull()
    },
    120_000,
  )
})

describe.sequential('indexSpace: `.order`-Dateien → orderKey (Phase 3.3)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('indexer-order')

    await write(provider, repo, 'index.md', '---\nid: home\ntitle: Startseite\nlang: de\n---\n# Startseite\n')
    await write(provider, repo, 'a/index.md', '---\nid: a\ntitle: A\nlang: de\n---\n# A\n')
    await write(provider, repo, 'b/index.md', '---\nid: b\ntitle: B\nlang: de\n---\n# B\n')
    await write(provider, repo, 'c/index.md', '---\nid: c\ntitle: C\nlang: de\n---\n# C\n')
    // Reihenfolge der Kinder der Startseite: c vor a — `b` fehlt bewusst (kein
    // Eintrag → orderKey null), `zzz-unknown` ist eine Fremd-Id (kein
    // tatsächliches Kind, wird toleriert ignoriert), `c` kommt zusätzlich
    // DOPPELT vor (nur das erste Vorkommen zählt), eine leere Zeile dazwischen
    // wird übersprungen.
    await write(provider, repo, '.order', 'c\n\nzzz-unknown\nc\na\n')

    // Verschachtelte Ebene: Kinder von `a` (eigenes `.order` unter `a/.order`).
    await write(provider, repo, 'a/x/index.md', '---\nid: ax\ntitle: AX\nlang: de\n---\n# AX\n')
    await write(provider, repo, 'a/y/index.md', '---\nid: ay\ntitle: AY\nlang: de\n---\n# AY\n')
    await write(provider, repo, 'a/.order', 'ay\nax\n')

    space = {
      id: 'order-space',
      name: 'Order',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it(
    'berechnet orderKey aus der `.order`-Datei des Elternverzeichnisses (Fremd-Ids/Duplikate toleriert, ' +
      'fehlende Einträge → null) — auch auf tieferen Ebenen mit eigener `.order`-Datei',
    async () => {
      await indexSpace({ db, provider }, space)

      const rows = await db.select().from(pages).where(eq(pages.spaceId, space.id))
      const orderKeyOf = (id: string): number | null => rows.find((r) => r.id === id)!.orderKey

      // Wurzel-`.order` ("c, c, zzz-unknown, a"): c=0, a=1, b (nicht gelistet) → null.
      expect(orderKeyOf('c')).toBe(0)
      expect(orderKeyOf('a')).toBe(1)
      expect(orderKeyOf('b')).toBeNull()

      // `a/.order` ("ay, ax"): ay=0, ax=1 — unabhängig von der Wurzel-Ordnung.
      expect(orderKeyOf('ay')).toBe(0)
      expect(orderKeyOf('ax')).toBe(1)

      // Startseite selbst hat keine sinnvolle eigene Ordnung (kein Elternknoten).
      expect(rows.find((r) => r.id === 'home')!.orderKey).toBeNull()
    },
    120_000,
  )

  it(
    'Voll-Reindex verwirft eine bereits gesetzte Reihenfolge NICHT stillschweigend, ' +
      'sondern berechnet sie bei jedem Lauf NEU aus der `.order`-Datei',
    async () => {
      // Reihenfolge in der `.order`-Datei umdrehen (neuer Commit) und erneut indexieren.
      const file = await provider.readFile(repo, '.order', 'main')
      await provider.writeFile(repo, '.order', 'a\nc\n', {
        branch: 'main',
        message: 'test: Reihenfolge umdrehen',
        sha: file.sha,
      })

      await indexSpace({ db, provider }, space)

      const rows = await db.select().from(pages).where(eq(pages.spaceId, space.id))
      const orderKeyOf = (id: string): number | null => rows.find((r) => r.id === id)!.orderKey

      expect(orderKeyOf('a')).toBe(0)
      expect(orderKeyOf('c')).toBe(1)
    },
    120_000,
  )

  it('Seiten ohne `.order`-Datei im Verzeichnis bekommen orderKey null (alphabetischer Fallback)', async () => {
    // `b` liegt unter der Wurzel, deren `.order` sie nicht listet (s. o.) — bleibt null.
    const rows = await db.select().from(pages).where(eq(pages.spaceId, space.id))
    expect(rows.find((r) => r.id === 'b')!.orderKey).toBeNull()
  })
})

describe.sequential('indexSpace: Id-Konflikt zwischen zwei Spaces (Issue #7)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repoA: RepoRef
  let repoB: RepoRef
  let spaceA: SpaceConfig
  let spaceB: SpaceConfig

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repoA = await forgejo.createRepo('indexer-conflict-a')
    repoB = await forgejo.createRepo('indexer-conflict-b')

    // Space A: der spätere legitime Eigentümer der Id "shared" — ein Tag und eine
    // ausgehende Kante, um zu prüfen, dass Space B beides unangetastet lässt.
    await write(provider, repoA, 'index.md', `---
id: shared
title: A Home
lang: de
tags:
  - alpha
---
# A Home

Siehe [[other]].
`)
    await write(provider, repoA, 'other/index.md', `---
id: other
title: Other
lang: de
---
# Other
`)

    // Space B: unabhängig entstandene Seite mit derselben Frontmatter-Id (Kopierfehler/
    // Kollision) — genau der Fall aus Issue #7.
    await write(provider, repoB, 'index.md', `---
id: shared
title: B Home
lang: de
tags:
  - beta
---
# B Home

Inhalt von Space B.
`)

    spaceA = {
      id: 'conflict-a',
      name: 'Space A',
      provider: 'forgejo',
      owner: repoA.owner,
      repo: repoA.repo,
      defaultLang: 'de',
      repoRef: repoA,
    }
    spaceB = {
      id: 'conflict-b',
      name: 'Space B',
      provider: 'forgejo',
      owner: repoB.owner,
      repo: repoB.repo,
      defaultLang: 'de',
      repoRef: repoB,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it(
    'Space B darf die bereits Space A gehörende Seite nicht übernehmen — A bleibt ' +
      'Eigentümer, B meldet den Konflikt im Report statt die Zeile stillschweigend zu verschieben',
    async () => {
      // Space A zuerst indexieren: legitimer Eigentümer der Id "shared".
      const reportA = await indexSpace({ db, provider }, spaceA)
      expect(reportA.idConflicts).toEqual([])
      expect(reportA.pagesWithErrors).toBe(0)

      const sharedBefore = (await db.select().from(pages).where(eq(pages.id, 'shared')))[0]!
      expect(sharedBefore.spaceId).toBe('conflict-a')
      expect(sharedBefore.title).toBe('A Home')

      const tagsBefore = await db.select().from(tags).where(eq(tags.pageId, 'shared'))
      const edgesBefore = await db.select().from(edges).where(eq(edges.fromPageId, 'shared'))
      expect(tagsBefore.map((t) => t.tag)).toEqual(['alpha'])
      expect(edgesBefore).toHaveLength(1)
      expect(edgesBefore[0]?.toPageId).toBe('other')

      // Space B versucht, dieselbe Id zu indexieren — muss abgelehnt werden.
      const reportB = await indexSpace({ db, provider }, spaceB)
      expect(reportB.pagesIndexed).toBe(1)
      expect(reportB.pagesWithErrors).toBe(1)
      expect(reportB.idConflicts).toEqual([{ id: 'shared', path: 'index.md', ownerSpace: 'conflict-a' }])

      // Space A ist unverändert: gleicher Inhalt, gleiche Tags, gleiche Kanten.
      const sharedAfter = (await db.select().from(pages).where(eq(pages.id, 'shared')))[0]!
      expect(sharedAfter).toEqual(sharedBefore)
      const tagsAfter = await db.select().from(tags).where(eq(tags.pageId, 'shared'))
      const edgesAfter = await db.select().from(edges).where(eq(edges.fromPageId, 'shared'))
      expect(tagsAfter).toEqual(tagsBefore)
      expect(edgesAfter).toEqual(edgesBefore)

      // Space B selbst hat KEINE Zeile für "shared" — der Schreibversuch wurde abgelehnt,
      // nicht etwa unter einer anderen Id abgelegt.
      const bOwnedRows = await db.select().from(pages).where(eq(pages.spaceId, 'conflict-b'))
      expect(bOwnedRows).toHaveLength(0)
    },
    120_000,
  )

  it(
    'ein erneuter Reindex von Space B verschiebt die Seite weiterhin nicht (kein Ownership-Flip)',
    async () => {
      const before = (await db.select().from(pages).where(eq(pages.id, 'shared')))[0]!

      const report = await indexSpace({ db, provider }, spaceB)
      expect(report.idConflicts).toEqual([{ id: 'shared', path: 'index.md', ownerSpace: 'conflict-a' }])

      const after = (await db.select().from(pages).where(eq(pages.id, 'shared')))[0]!
      expect(after).toEqual(before)
    },
    120_000,
  )
})
