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

  it('listPullRequests follows pages and filters head client-side across them (f451#141)', async () => {
    const pulls = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        number: from + i,
        state: 'open',
        merged: false,
        title: `PR ${from + i}`,
        head: { ref: `draft/${from + i}` },
        base: { ref: 'main' },
        html_url: `https://git.example.test/acme/docs/pulls/${from + i}`,
        mergeable: null,
      }))
    const page1 = pulls(1, 50)
    const page2 = pulls(51, 3)
    for (const [page, body] of [[1, page1], [2, page2]] as const) {
      api()
        .intercept({ path: `/api/v1/repos/acme/docs/pulls?state=open&limit=50&page=${page}`, method: 'GET' })
        .reply(200, body)
    }

    // The PR sought by head branch sits on page 2 — before the fix it was missed.
    const found = await provider().listPullRequests(repo, { head: 'draft/52', state: 'open' })
    expect(found.map((pr) => pr.number)).toEqual([52])
  })

  it('listPullRequests without filters returns all pages merged', async () => {
    const pulls = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        number: from + i,
        state: 'open',
        merged: false,
        title: `PR ${from + i}`,
        head: { ref: `draft/${from + i}` },
        base: { ref: 'main' },
        html_url: `https://git.example.test/acme/docs/pulls/${from + i}`,
      }))
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/pulls?limit=50&page=1', method: 'GET' })
      .reply(200, pulls(1, 50))
    api()
      .intercept({ path: '/api/v1/repos/acme/docs/pulls?limit=50&page=2', method: 'GET' })
      .reply(200, [])

    expect(await provider().listPullRequests(repo)).toHaveLength(50)
  })
})
