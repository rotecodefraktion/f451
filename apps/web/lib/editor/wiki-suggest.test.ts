import { describe, expect, it } from 'vitest'
import { deriveWikiLinkTarget, suggestWikiTargets, type WikiSuggestDeps } from './wiki-suggest.js'

interface FakeResult {
  id: string
  title: string
  path: string
}

/** Baut einen `searchPages`-Fake, der pro `ref` eine feste Trefferliste liefert —
 *  Muster: injizierbare Deps statt echtem `fetch` (Brief: „injizierbare deps"). */
function fakeDeps(byRef: { main?: FakeResult[]; draft?: FakeResult[] }): WikiSuggestDeps {
  return {
    searchPages: async (_query, options) => {
      const results = options.ref === 'draft' ? (byRef.draft ?? []) : (byRef.main ?? [])
      return results.map((r) => ({ ...r, space: 'betrieb', snippet: '' }))
    },
  }
}

describe('suggestWikiTargets', () => {
  it('liefert [] bei leerer Query, ohne searchPages aufzurufen', async () => {
    let calls = 0
    const deps: WikiSuggestDeps = {
      searchPages: async () => {
        calls += 1
        return []
      },
    }
    const result = await suggestWikiTargets('', 'betrieb', deps)
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })

  it('merged main- und draft-Treffer und dedupliziert nach id', async () => {
    const deps = fakeDeps({
      main: [{ id: 'p1', title: 'Netzwerk', path: 'betrieb/netzwerk/index.md' }],
      draft: [{ id: 'p2', title: 'Netz-Failover', path: 'betrieb/runbooks/netz-failover/index.md' }],
    })
    const result = await suggestWikiTargets('netz', 'betrieb', deps)
    expect(result.map((r) => r.id).sort()).toEqual(['p1', 'p2'])
  })

  it('Draft-Treffer gewinnt bei gleicher id (isDraft:true) statt des main-Treffers', async () => {
    const deps = fakeDeps({
      main: [{ id: 'p1', title: 'Netzwerk (alt)', path: 'betrieb/netzwerk/index.md' }],
      draft: [{ id: 'p1', title: 'Netzwerk (neu)', path: 'betrieb/netzwerk/index.md' }],
    })
    const result = await suggestWikiTargets('netz', 'betrieb', deps)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ id: 'p1', title: 'Netzwerk (neu)', path: 'betrieb/netzwerk/index.md', isDraft: true })
  })

  it('main-Treffer ohne Draft-Gegenstück bleibt isDraft:false', async () => {
    const deps = fakeDeps({ main: [{ id: 'p1', title: 'Netzwerk', path: 'betrieb/netzwerk/index.md' }] })
    const result = await suggestWikiTargets('netz', 'betrieb', deps)
    expect(result[0]?.isDraft).toBe(false)
  })

  it('begrenzt auf maximal 8 Treffer', async () => {
    const main = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      title: `Seite ${i}`,
      path: `betrieb/seite-${i}/index.md`,
    }))
    const deps = fakeDeps({ main })
    const result = await suggestWikiTargets('seite', 'betrieb', deps)
    expect(result).toHaveLength(8)
  })

  it('verwirft das Ergebnis, wenn das übergebene Signal inzwischen abgebrochen wurde (Abbruch-Signal)', async () => {
    const controller = new AbortController()
    let resolveMain: (value: FakeResult[]) => void = () => {}
    const deps: WikiSuggestDeps = {
      searchPages: async (_query, options) => {
        if (options.ref === 'draft') return []
        return new Promise<FakeResult[]>((resolve) => {
          resolveMain = resolve
        }).then((results) => results.map((r) => ({ ...r, space: 'betrieb', snippet: '' })))
      },
    }

    const pending = suggestWikiTargets('netz', 'betrieb', deps, controller.signal)
    controller.abort()
    resolveMain([{ id: 'p1', title: 'Netzwerk', path: 'betrieb/netzwerk/index.md' }])

    expect(await pending).toEqual([])
  })

  it('liefert Ergebnisse normal, wenn das Signal nicht abgebrochen wurde', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ main: [{ id: 'p1', title: 'Netzwerk', path: 'betrieb/netzwerk/index.md' }] })
    const result = await suggestWikiTargets('netz', 'betrieb', deps, controller.signal)
    expect(result).toHaveLength(1)
  })

  it('sucht mit prefix:true — Tipp-Suche, unvollständiges letztes Wort matcht (Phase 3a)', async () => {
    const seen: Array<boolean | undefined> = []
    const deps: WikiSuggestDeps = {
      searchPages: async (_query, options) => {
        seen.push(options.prefix)
        return []
      },
    }
    await suggestWikiTargets('deplo', 'betrieb', deps)
    // Beide parallelen Anfragen (main + draft) laufen mit Präfix-Matching.
    expect(seen).toEqual([true, true])
  })
})

describe('deriveWikiLinkTarget', () => {
  it('leitet das Ziel als Verzeichnispfad ohne /index.md ab', () => {
    expect(
      deriveWikiLinkTarget({ title: 'Deployment', path: 'betrieb/deployment/index.md' }),
    ).toEqual({ target: 'betrieb/deployment', alias: 'Deployment' })
  })

  it('fällt bei Wurzel-index.md auf den Titel als Ziel zurück (kein Alias)', () => {
    expect(deriveWikiLinkTarget({ title: 'Start', path: 'index.md' })).toEqual({
      target: 'Start',
      alias: null,
    })
  })

  it('setzt keinen Alias, wenn Titel und abgeleitetes Ziel identisch sind', () => {
    expect(
      deriveWikiLinkTarget({ title: 'deployment', path: 'deployment/index.md' }),
    ).toEqual({ target: 'deployment', alias: null })
  })
})
