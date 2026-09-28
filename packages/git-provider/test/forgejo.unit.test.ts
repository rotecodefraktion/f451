import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici'
import { ForgejoProvider } from '../src/forgejo.js'
import { ProviderError } from '../src/errors.js'
import type { RepoRef } from '../src/types.js'

const repo: RepoRef = { provider: 'forgejo', owner: 'acme', repo: 'docs' }

describe('ForgejoProvider (Fixtures)', () => {
  let agent: MockAgent
  let prev: Dispatcher

  beforeEach(() => {
    prev = getGlobalDispatcher()
    agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
  })

  afterEach(async () => {
    setGlobalDispatcher(prev)
    await agent.close()
  })

  function api() {
    return agent.get('https://git.example.test')
  }

  function provider() {
    return new ForgejoProvider({ baseUrl: 'https://git.example.test', token: 't' })
  }

  function entries(prefix: string, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      path: `${prefix}/datei-${i}.md`,
      type: 'blob',
      sha: `${prefix}${i}`,
    }))
  }

  it('listTree mappt blob/tree auf file/dir', async () => {
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/git/trees/main?recursive=true&page=1&per_page=1000', method: 'GET' })
      .reply(200, {
        truncated: false,
        total_count: 2,
        tree: [
          { path: 'README.md', type: 'blob', sha: 'aaa' },
          { path: 'betrieb', type: 'tree', sha: 'bbb' },
        ],
      })

    expect(await provider().listTree(repo, 'main')).toEqual([
      { path: 'README.md', type: 'file', sha: 'aaa' },
      { path: 'betrieb', type: 'dir', sha: 'bbb' },
    ])
  })

  it('holt alle Seiten, wenn der Baum größer als eine Seite ist', async () => {
    // Forgejo deckelt per_page auf 1000 und setzt `truncated: true`, sobald der
    // Baum nicht in EINE Seite passt — die Gesamtliste ist über `page` trotzdem
    // vollständig abrufbar (echter Fall: Space "handbuch", 1309 Einträge).
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/git/trees/main?recursive=true&page=1&per_page=1000', method: 'GET' })
      .reply(200, { truncated: true, total_count: 1309, page: 1, tree: entries('a', 1000) })
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/git/trees/main?recursive=true&page=2&per_page=1000', method: 'GET' })
      .reply(200, { truncated: true, total_count: 1309, page: 2, tree: entries('b', 309) })

    const tree = await provider().listTree(repo, 'main')
    expect(tree).toHaveLength(1309)
    expect(tree[0]).toEqual({ path: 'a/datei-0.md', type: 'file', sha: 'a0' })
    expect(tree[1308]).toEqual({ path: 'b/datei-308.md', type: 'file', sha: 'b308' })
  })

  it('bricht ab, wenn der Baum trotz Paging unvollständig bleibt', async () => {
    // Liefert eine Seite eine leere Liste, obwohl total_count mehr verspricht,
    // würde eine naive Schleife ewig weiterlaufen — hier muss ein Fehler statt
    // eines still unvollständigen Baums herauskommen (fail-loud).
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/git/trees/main?recursive=true&page=1&per_page=1000', method: 'GET' })
      .reply(200, { truncated: true, total_count: 5000, page: 1, tree: entries('a', 1000) })
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/git/trees/main?recursive=true&page=2&per_page=1000', method: 'GET' })
      .reply(200, { truncated: true, total_count: 5000, page: 2, tree: [] })

    await expect(provider().listTree(repo, 'main')).rejects.toBeInstanceOf(ProviderError)
  })
})
