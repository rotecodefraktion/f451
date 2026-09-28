import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici'
import { GitHubProvider } from '../src/github.js'
import { ConflictError, NotFoundError, ProviderError } from '../src/errors.js'
import type { RepoRef } from '../src/types.js'

const repo: RepoRef = { provider: 'github', owner: 'acme', repo: 'docs' }

describe('GitHubProvider (Fixtures)', () => {
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
    return agent.get('https://api.github.com')
  }

  it('readFile dekodiert Base64-Inhalt und liefert Blob-SHA', async () => {
    api()
      .intercept({
        path: '/repos/acme/docs/contents/betrieb/index.md?ref=main',
        method: 'GET',
        headers: {
          authorization: 'Bearer t',
          'user-agent': 'f451',
          'x-github-api-version': '2022-11-28',
        },
      })
      .reply(200, {
        type: 'file',
        path: 'betrieb/index.md',
        sha: 'abc1234567890abc1234567890abc1234567890a',
        content: Buffer.from('# Betrieb\n').toString('base64'),
        encoding: 'base64',
      })
    const p = new GitHubProvider({ token: 't' })
    const f = await p.readFile(repo, 'betrieb/index.md', 'main')
    expect(f.content).toBe('# Betrieb\n')
    expect(f.sha).toBe('abc1234567890abc1234567890abc1234567890a')
  })

  it('readFileBinary liefert den Base64-Inhalt als Buffer, ohne UTF-8-Dekodierung', async () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    api()
      .intercept({
        path: '/repos/acme/docs/contents/betrieb/_media/logo.png?ref=main',
        method: 'GET',
      })
      .reply(200, {
        type: 'file',
        path: 'betrieb/_media/logo.png',
        sha: 'fed1234567890fed1234567890fed1234567890f',
        content: raw.toString('base64'),
        encoding: 'base64',
      })
    const p = new GitHubProvider({ token: 't' })
    const f = await p.readFileBinary(repo, 'betrieb/_media/logo.png', 'main')
    expect(f.content).toEqual(raw)
    expect(f.sha).toBe('fed1234567890fed1234567890fed1234567890f')
  })

  it('readFileBinary 404 → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/contents/fehlt.png?ref=main', method: 'GET' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.readFileBinary(repo, 'fehlt.png', 'main')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('readFile 404 → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/contents/fehlt.md?ref=main', method: 'GET' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.readFile(repo, 'fehlt.md', 'main')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('writeFile legt eine Datei an und liefert den Commit-SHA', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/contents/a.md', method: 'PUT' })
      .reply(201, { commit: { sha: 'cd1234567890cd1234567890cd1234567890cd12' } })
    const p = new GitHubProvider({ token: 't' })
    const res = await p.writeFile(repo, 'a.md', 'x', { branch: 'main', message: 'm' })
    expect(res.commitSha).toBe('cd1234567890cd1234567890cd1234567890cd12')
  })

  it('writeFile mit veraltetem SHA (422) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/contents/a.md', method: 'PUT' })
      .reply(422, { message: 'sha does not match' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.writeFile(repo, 'a.md', 'x', { branch: 'main', message: 'm', sha: 'deadbeef' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('deleteFile löscht eine Datei und liefert den Commit-SHA', async () => {
    api()
      .intercept({
        path: '/repos/acme/docs/contents/a.md',
        method: 'DELETE',
        body: JSON.stringify({ message: 'docs: löschen', sha: 'deadbeef', branch: 'main' }),
      })
      .reply(200, { commit: { sha: 'ab1234567890ab1234567890ab1234567890ab12' } })
    const p = new GitHubProvider({ token: 't' })
    const res = await p.deleteFile(repo, 'a.md', { branch: 'main', message: 'docs: löschen', sha: 'deadbeef' })
    expect(res.commitSha).toBe('ab1234567890ab1234567890ab1234567890ab12')
  })

  it('deleteFile 404 (Datei existiert nicht) → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/contents/fehlt.md', method: 'DELETE' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.deleteFile(repo, 'fehlt.md', { branch: 'main', message: 'x', sha: 'deadbeef' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('deleteFile mit veraltetem SHA (422) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/contents/a.md', method: 'DELETE' })
      .reply(422, { message: 'sha does not match' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.deleteFile(repo, 'a.md', { branch: 'main', message: 'x', sha: 'stale' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('listTree mappt blob/tree auf file/dir', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/git/trees/main?recursive=1', method: 'GET' })
      .reply(200, {
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob', sha: 'aaa1234567890aaa1234567890aaa1234567890a' },
          { path: 'betrieb', type: 'tree', sha: 'bbb1234567890bbb1234567890bbb1234567890b' },
        ],
      })
    const p = new GitHubProvider({ token: 't' })
    const tree = await p.listTree(repo, 'main')
    expect(tree).toEqual([
      { path: 'README.md', type: 'file', sha: 'aaa1234567890aaa1234567890aaa1234567890a' },
      { path: 'betrieb', type: 'dir', sha: 'bbb1234567890bbb1234567890bbb1234567890b' },
    ])
  })

  it('listTree mit truncated:true → ProviderError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/git/trees/main?recursive=1', method: 'GET' })
      .reply(200, { truncated: true, tree: [] })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.listTree(repo, 'main')).rejects.toBeInstanceOf(ProviderError)
  })

  it('getHeadSha liefert den Commit-SHA des Branches', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/branches/main', method: 'GET' })
      .reply(200, { name: 'main', commit: { sha: 'eee1234567890eee1234567890eee1234567890e' } })
    const p = new GitHubProvider({ token: 't' })
    const sha = await p.getHeadSha(repo, 'main')
    expect(sha).toBe('eee1234567890eee1234567890eee1234567890e')
  })

  it('getHeadSha encodet Slash-Branches voll (draft/8f3ka2 → draft%2F8f3ka2)', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/branches/draft%2F8f3ka2', method: 'GET' })
      .reply(200, { name: 'draft/8f3ka2', commit: { sha: 'bbb1234567890bbb1234567890bbb1234567890b' } })
    const p = new GitHubProvider({ token: 't' })
    const sha = await p.getHeadSha(repo, 'draft/8f3ka2')
    expect(sha).toBe('bbb1234567890bbb1234567890bbb1234567890b')
  })

  it('getHeadSha 404 → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/branches/gibt-es-nicht', method: 'GET' })
      .reply(404, { message: 'Branch not found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.getHeadSha(repo, 'gibt-es-nicht')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('createBranch liest zuerst den HEAD-SHA von fromBranch und legt dann den Ref an', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/branches/main', method: 'GET' })
      .reply(200, { name: 'main', commit: { sha: 'fff1234567890fff1234567890fff1234567890f' } })
    api()
      .intercept({
        path: '/repos/acme/docs/git/refs',
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/draft/x', sha: 'fff1234567890fff1234567890fff1234567890f' }),
      })
      .reply(201, { ref: 'refs/heads/draft/x' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.createBranch(repo, 'draft/x', 'main')).resolves.toBeUndefined()
  })

  it('createBranch 422 (Branch existiert bereits) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/branches/main', method: 'GET' })
      .reply(200, { name: 'main', commit: { sha: 'fff1234567890fff1234567890fff1234567890f' } })
    api()
      .intercept({ path: '/repos/acme/docs/git/refs', method: 'POST' })
      .reply(422, { message: 'Reference already exists' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.createBranch(repo, 'draft/x', 'main')).rejects.toBeInstanceOf(ConflictError)
  })

  it('deleteBranch löscht den Ref (204)', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/git/refs/heads/draft/x', method: 'DELETE' })
      .reply(204, '')
    const p = new GitHubProvider({ token: 't' })
    await expect(p.deleteBranch(repo, 'draft/x')).resolves.toBeUndefined()
  })

  it('deleteBranch 404 → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/git/refs/heads/gibt-es-nicht', method: 'DELETE' })
      .reply(404, { message: 'Reference does not exist' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.deleteBranch(repo, 'gibt-es-nicht')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('listCommits mappt die Historie', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/commits?sha=main&path=betrieb%2Findex.md&per_page=10', method: 'GET' })
      .reply(200, [
        {
          sha: 'aaa1234567890aaa1234567890aaa1234567890a',
          commit: {
            message: 'docs: v2',
            author: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
          },
        },
      ])
    const p = new GitHubProvider({ token: 't' })
    const commits = await p.listCommits(repo, { ref: 'main', path: 'betrieb/index.md', limit: 10 })
    expect(commits).toEqual([
      {
        sha: 'aaa1234567890aaa1234567890aaa1234567890a',
        message: 'docs: v2',
        authorName: 'Ada',
        authorEmail: 'ada@example.com',
        date: '2026-01-01T00:00:00Z',
      },
    ])
  })

  it('listCommits 404 (unbekannter Ref) → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/commits?sha=gibt-es-nicht', method: 'GET' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.listCommits(repo, { ref: 'gibt-es-nicht' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('createPullRequest erzeugt einen offenen PR', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls', method: 'POST' })
      .reply(201, {
        number: 7,
        state: 'open',
        merged: false,
        title: 'Monitoring',
        head: { ref: 'draft/x' },
        base: { ref: 'main' },
        html_url: 'https://github.com/acme/docs/pull/7',
      })
    const p = new GitHubProvider({ token: 't' })
    const pr = await p.createPullRequest(repo, { head: 'draft/x', base: 'main', title: 'Monitoring', body: 'x' })
    expect(pr).toEqual({
      number: 7,
      state: 'open',
      title: 'Monitoring',
      headBranch: 'draft/x',
      baseBranch: 'main',
      url: 'https://github.com/acme/docs/pull/7',
      // Frisch erzeugte PRs: GitHub liefert kein mergeable-Feld, solange die
      // Berechnung noch läuft — muss auf null gemappt werden, nicht undefined.
      mergeable: null,
    })
  })

  it('createPullRequest 422 (kein Diff) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls', method: 'POST' })
      .reply(422, { message: 'No commits between main and main' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.createPullRequest(repo, { head: 'main', base: 'main', title: 'Leer' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('getPullRequest mappt merged:true auf state "merged"', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/7', method: 'GET' })
      .reply(200, {
        number: 7,
        state: 'closed',
        merged: true,
        title: 'Monitoring',
        head: { ref: 'draft/x' },
        base: { ref: 'main' },
        html_url: 'https://github.com/acme/docs/pull/7',
      })
    const p = new GitHubProvider({ token: 't' })
    const pr = await p.getPullRequest(repo, 7)
    expect(pr.state).toBe('merged')
  })

  it('getPullRequest mappt mergeable:true/false/null durch', async () => {
    const p = new GitHubProvider({ token: 't' })
    for (const mergeable of [true, false, null]) {
      api()
        .intercept({ path: '/repos/acme/docs/pulls/7', method: 'GET' })
        .reply(200, {
          number: 7,
          state: 'open',
          merged: false,
          title: 'Monitoring',
          head: { ref: 'draft/x' },
          base: { ref: 'main' },
          html_url: 'https://github.com/acme/docs/pull/7',
          mergeable,
        })
      const pr = await p.getPullRequest(repo, 7)
      expect(pr.mergeable).toBe(mergeable)
    }
  })

  it('getPullRequest 404 (unbekannte Nummer) → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/999999', method: 'GET' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.getPullRequest(repo, 999999)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('listPullRequests baut head als "owner:branch", base und state als Query-Parameter', async () => {
    api()
      .intercept({
        path: '/repos/acme/docs/pulls?head=acme%3Adraft%2Fx&base=main&state=open',
        method: 'GET',
      })
      .reply(200, [
        {
          number: 7,
          state: 'open',
          merged: false,
          title: 'Monitoring',
          head: { ref: 'draft/x' },
          base: { ref: 'main' },
          html_url: 'https://github.com/acme/docs/pull/7',
          mergeable: null,
        },
      ])
    const p = new GitHubProvider({ token: 't' })
    const prs = await p.listPullRequests(repo, { head: 'draft/x', base: 'main', state: 'open' })
    expect(prs).toEqual([
      {
        number: 7,
        state: 'open',
        title: 'Monitoring',
        headBranch: 'draft/x',
        baseBranch: 'main',
        url: 'https://github.com/acme/docs/pull/7',
        mergeable: null,
      },
    ])
  })

  it('listPullRequests ohne Filter ruft /pulls ohne Query-String auf', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls', method: 'GET' })
      .reply(200, [])
    const p = new GitHubProvider({ token: 't' })
    await expect(p.listPullRequests(repo)).resolves.toEqual([])
  })

  it('listPullRequests 404 (unbekanntes Repo) → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls', method: 'GET' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.listPullRequests(repo)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requestReviewers postet die Reviewer-Liste an .../requested_reviewers', async () => {
    api()
      .intercept({
        path: '/repos/acme/docs/pulls/7/requested_reviewers',
        method: 'POST',
        body: JSON.stringify({ reviewers: ['octocat'] }),
      })
      .reply(201, { number: 7 })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.requestReviewers(repo, 7, ['octocat'])).resolves.toBeUndefined()
  })

  it('requestReviewers 404 (unbekannte PR-Nummer) → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/999999/requested_reviewers', method: 'POST' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.requestReviewers(repo, 999999, ['octocat'])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('submitPullRequestReview mappt "approve" auf APPROVE und schickt den Body mit', async () => {
    api()
      .intercept({
        path: '/repos/acme/docs/pulls/7/reviews',
        method: 'POST',
        body: JSON.stringify({ event: 'APPROVE', body: 'lgtm' }),
      })
      .reply(200, { id: 1, state: 'APPROVED' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.submitPullRequestReview(repo, 7, { event: 'approve', body: 'lgtm' }),
    ).resolves.toBeUndefined()
  })

  it('submitPullRequestReview mappt "request_changes" auf REQUEST_CHANGES', async () => {
    api()
      .intercept({
        path: '/repos/acme/docs/pulls/7/reviews',
        method: 'POST',
        body: JSON.stringify({ event: 'REQUEST_CHANGES', body: undefined }),
      })
      .reply(200, { id: 2, state: 'CHANGES_REQUESTED' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.submitPullRequestReview(repo, 7, { event: 'request_changes' }),
    ).resolves.toBeUndefined()
  })

  it('submitPullRequestReview 404 (unbekannte PR-Nummer) → NotFoundError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/999999/reviews', method: 'POST' })
      .reply(404, { message: 'Not Found' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.submitPullRequestReview(repo, 999999, { event: 'approve' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('submitPullRequestReview 422 (Self-Approve durch den PR-Autor) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/7/reviews', method: 'POST' })
      .reply(422, { message: 'Unprocessable Entity' })
    const p = new GitHubProvider({ token: 't' })
    await expect(
      p.submitPullRequestReview(repo, 7, { event: 'approve' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('mergePullRequest liefert den Merge-Commit-SHA', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/7/merge', method: 'PUT' })
      .reply(200, { sha: 'ccc1234567890ccc1234567890ccc1234567890c', merged: true, message: 'Merged' })
    const p = new GitHubProvider({ token: 't' })
    const res = await p.mergePullRequest(repo, 7)
    expect(res.mergeSha).toBe('ccc1234567890ccc1234567890ccc1234567890c')
  })

  it('mergePullRequest 405 (nicht mergebar) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/7/merge', method: 'PUT' })
      .reply(405, { message: 'Pull Request is not mergeable' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.mergePullRequest(repo, 7)).rejects.toBeInstanceOf(ConflictError)
  })

  it('mergePullRequest 409 (Head geändert) → ConflictError', async () => {
    api()
      .intercept({ path: '/repos/acme/docs/pulls/7/merge', method: 'PUT' })
      .reply(409, { message: 'Head branch was modified' })
    const p = new GitHubProvider({ token: 't' })
    await expect(p.mergePullRequest(repo, 7)).rejects.toBeInstanceOf(ConflictError)
  })
})
