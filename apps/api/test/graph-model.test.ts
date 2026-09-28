import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/client.js'
import { edges, pages, spaces, tags } from '../src/db/schema.js'
import {
  applyWorkflowStatus,
  buildSpaceGraph,
  neighborhood,
  type GraphData,
} from '../src/graph/space-graph.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/** Minimal-Seed: 4 Seiten in 'demo' (eine archiviert, eine als Draft-Doppelzeile),
 *  1 Fremd-Space-Seite, Kanten aller materialisierten Typen + 1 Broken Link. */
async function seed(db: Db): Promise<void> {
  // Mechanische Ergänzung ggü. Brief: `pages.spaceId` referenziert `spaces.id`
  // per NOT-NULL-FK (siehe apps/api/src/db/schema.ts) — der Brief-Seed setzt
  // pages direkt mit spaceId 'demo'/'other', ohne die zugehörigen Space-Zeilen
  // anzulegen. Ohne diese Inserts schlägt das Seeding mit einer FK-Verletzung
  // fehl. Ergänzt um die zwei minimal nötigen Space-Zeilen.
  await db.insert(spaces).values([
    { id: 'demo', provider: 'forgejo', owner: 'dev-docs', repo: 'demo', name: 'Demo', defaultLang: 'de' },
    { id: 'other', provider: 'forgejo', owner: 'dev-docs', repo: 'other', name: 'Other', defaultLang: 'de' },
  ])
  const base = { spaceId: 'demo', frontmatter: {}, frontmatterErrors: [], headings: [], plainText: '', htmlRendered: '', lang: 'de' }
  await db.insert(pages).values([
    { ...base, id: 'root', ref: 'main', path: 'index.md', title: 'Start', archived: false },
    { ...base, id: 'a', ref: 'main', path: 'a/index.md', title: 'Alpha', archived: false },
    { ...base, id: 'b', ref: 'main', path: 'b/index.md', title: 'Beta', archived: false },
    { ...base, id: 'alt', ref: 'main', path: 'alt/index.md', title: 'Altbestand', archived: true },
    // Draft-Doppelzeile zu 'a' — darf NICHT als eigener Knoten erscheinen:
    { ...base, id: 'a', ref: 'draft', path: 'a/index.md', title: 'Alpha (Entwurf)', archived: false },
    // Fremder Space — darf nie erscheinen:
    { ...base, id: 'x', spaceId: 'other', ref: 'main', path: 'x/index.md', title: 'Fremd', archived: false },
  ])
  await db.insert(edges).values([
    { fromPageId: 'a', toPageId: 'root', rawTarget: 'index.md', type: 'hierarchy', label: '', ref: 'main' },
    { fromPageId: 'b', toPageId: 'root', rawTarget: 'index.md', type: 'hierarchy', label: '', ref: 'main' },
    { fromPageId: 'alt', toPageId: 'root', rawTarget: 'index.md', type: 'hierarchy', label: '', ref: 'main' },
    { fromPageId: 'a', toPageId: 'b', rawTarget: 'b', type: 'link', label: '', ref: 'main' },
    { fromPageId: 'b', toPageId: 'a', rawTarget: 'a', type: 'relation', label: 'depends_on', ref: 'main' },
    // Broken Link — darf nie als Kante erscheinen (toPageId null):
    { fromPageId: 'a', toPageId: null, rawTarget: 'gibt-es-nicht', type: 'link', label: '', ref: 'main' },
  ])
  await db.insert(tags).values([
    { pageId: 'a', tag: 'ops', ref: 'main' },
    { pageId: 'b', tag: 'ops', ref: 'main' },
    { pageId: 'root', tag: 'start', ref: 'main' },
  ])
}

describe.sequential('Graph-Datenmodul', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    await seed(db)
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  describe('buildSpaceGraph', () => {
    it('liefert alle main-Seiten des Space als Knoten (keine Drafts, keine Fremd-Spaces)', async () => {
      const g = await buildSpaceGraph(db, 'demo', ['hierarchy', 'link', 'relation'])
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'alt', 'b', 'root'])
      const a = g.nodes.find((n) => n.id === 'a')
      expect(a).toMatchObject({ title: 'Alpha', path: 'a/index.md', status: 'released', tags: ['ops'] })
      expect(typeof a?.updatedAt).toBe('string')
      expect(g.nodes.find((n) => n.id === 'alt')?.status).toBe('archived')
    })

    it('liefert nur angeforderte Kantentypen und nie Broken Links', async () => {
      const g = await buildSpaceGraph(db, 'demo', ['link'])
      expect(g.edges).toEqual([{ from: 'a', to: 'b', type: 'link', label: '' }])
    })

    it('berechnet tag-Kanten zur Abfragezeit (Paare mit gemeinsamem Tag, Label = Tag)', async () => {
      const g = await buildSpaceGraph(db, 'demo', ['tag'])
      expect(g.edges).toEqual([{ from: 'a', to: 'b', type: 'tag', label: 'ops' }])
    })

    it('relation-Kanten tragen den Relationstyp als Label', async () => {
      const g = await buildSpaceGraph(db, 'demo', ['relation'])
      expect(g.edges).toEqual([{ from: 'b', to: 'a', type: 'relation', label: 'depends_on' }])
    })
  })

  describe('neighborhood', () => {
    const graph: GraphData = {
      nodes: (['c', 'n1', 'n2', 'far'] as const).map((id) => ({
        id, title: id.toUpperCase(), path: `${id}/index.md`, status: 'released', tags: [], updatedAt: '2026-07-12T00:00:00.000Z',
      })),
      edges: [
        { from: 'c', to: 'n1', type: 'link', label: '' },
        { from: 'n2', to: 'c', type: 'relation', label: 'depends_on' }, // eingehend!
        { from: 'far', to: 'n1', type: 'link', label: '' },
      ],
    }

    it('depth=1: Zentrum + direkte Nachbarn in BEIDEN Richtungen (eingehende Kanten zählen)', () => {
      const g = neighborhood(graph, 'c', 1)
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['c', 'n1', 'n2'])
      expect(g.edges).toHaveLength(2)
    })

    it('depth=2: erreicht auch far; Kanten nur zwischen enthaltenen Knoten', () => {
      const g = neighborhood(graph, 'c', 2)
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['c', 'far', 'n1', 'n2'])
      expect(g.edges).toHaveLength(3)
    })

    it('unbekanntes Zentrum → leerer Graph', () => {
      expect(neighborhood(graph, 'nope', 2)).toEqual({ nodes: [], edges: [] })
    })
  })

  describe('applyWorkflowStatus', () => {
    it('setzt working/review; archived hat Vorrang; review vor working', async () => {
      const g = await buildSpaceGraph(db, 'demo', ['hierarchy'])
      const enriched = applyWorkflowStatus(g, new Set(['a', 'alt', 'b']), new Set(['b']))
      const byId = new Map(enriched.nodes.map((n) => [n.id, n.status]))
      expect(byId.get('a')).toBe('working')
      expect(byId.get('b')).toBe('review')
      expect(byId.get('alt')).toBe('archived') // Vorrang vor working
      expect(byId.get('root')).toBe('released')
    })
  })
})
