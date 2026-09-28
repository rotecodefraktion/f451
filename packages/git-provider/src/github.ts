import type {
  CommitInfo, FileChange, GitFile, GitProvider, PullRequestInfo, RepoRef, TreeEntry,
} from './types.js'
import { ConflictError, NotFoundError, ProviderError, toProviderError } from './errors.js'

export interface GitHubProviderOptions {
  token: string
  /** Default `https://api.github.com`; für GitHub Enterprise überschreiben. */
  baseUrl?: string
}

const API_VERSION = '2022-11-28'

/** Nebenläufige Blob-Uploads je Block in `commitFiles`. Blobs sind keine
 *  Commits — sie dürfen parallel laufen; 8 hält die Last gegenüber der API in
 *  Grenzen, ohne den Move wieder seriell zu machen. */
const BLOB_CONCURRENCY = 8

/** GitProvider-Implementierung über die GitHub-REST-API. */
export class GitHubProvider implements GitProvider {
  readonly #base: string
  readonly #token: string

  constructor(opts: GitHubProviderOptions) {
    this.#base = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '')
    this.#token = opts.token
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'f451',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw toProviderError(res.status, await res.text())
    if (res.status === 204) return undefined
    const text = await res.text()
    if (text.length === 0) return undefined
    return JSON.parse(text)
  }

  async readFile(repo: RepoRef, path: string, ref: string): Promise<GitFile> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    )) as { type: string; path: string; sha: string; content: string; encoding: string }
    if (data.type !== 'file') throw new NotFoundError(`${path} ist keine Datei`)
    return {
      path: data.path,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      sha: data.sha,
    }
  }

  async readFileBinary(repo: RepoRef, path: string, ref: string): Promise<{ content: Buffer; sha: string }> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    )) as { type: string; path: string; sha: string; content: string; encoding: string }
    if (data.type !== 'file') throw new NotFoundError(`${path} ist keine Datei`)
    return { content: Buffer.from(data.content, 'base64'), sha: data.sha }
  }

  /**
   * Sammel-Commit über die Git-Data-API.
   *
   * GitHub hat kein Gegenstück zu Forgejos ChangeFiles-Endpunkt — die
   * Contents-API kennt nur eine Datei je Aufruf und erzeugt je Aufruf einen
   * Commit. Der Weg über die Git-Data-API baut den Commit stattdessen aus
   * seinen Bestandteilen: Blobs (Inhalte) → Tree (Verzeichnisstand) → Commit →
   * Branch-Zeiger.
   *
   * Die Blobs entstehen einzeln, aber das sind Uploads, keine Commits — sie
   * laufen in Blöcken nebenläufig. Am Ende steht EIN Commit, egal wie viele
   * Dateien.
   *
   * Gelöscht wird über `sha: null` im Tree-Eintrag: Das ist die von GitHub
   * vorgesehene Schreibweise für „diesen Pfad im neuen Baum nicht mehr führen".
   */
  async commitFiles(
    repo: RepoRef,
    changes: FileChange[],
    opts: { branch: string; message: string },
  ): Promise<{ commitSha: string | null }> {
    if (changes.length === 0) return { commitSha: null }

    const ref = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(opts.branch)}`,
    )) as { object: { sha: string } }
    const baseCommitSha = ref.object.sha
    const baseCommit = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/git/commits/${baseCommitSha}`,
    )) as { tree: { sha: string } }

    const writes = changes.filter((c): c is Extract<FileChange, { op: 'write' }> => c.op === 'write')
    const blobShas = new Map<string, string>()
    for (let i = 0; i < writes.length; i += BLOB_CONCURRENCY) {
      const block = writes.slice(i, i + BLOB_CONCURRENCY)
      const created = await Promise.all(
        block.map(async (change) => {
          const blob = (await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/git/blobs`, {
            content: change.content.toString('base64'),
            encoding: 'base64',
          })) as { sha: string }
          return [change.path, blob.sha] as const
        }),
      )
      for (const [path, sha] of created) blobShas.set(path, sha)
    }

    const tree = (await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: changes.map((change) =>
        change.op === 'delete'
          ? { path: change.path, mode: '100644', type: 'blob', sha: null }
          : { path: change.path, mode: '100644', type: 'blob', sha: blobShas.get(change.path) },
      ),
    })) as { sha: string }

    const commit = (await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/git/commits`, {
      message: opts.message,
      tree: tree.sha,
      parents: [baseCommitSha],
    })) as { sha: string }

    await this.#request(
      'PATCH',
      `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${encodeURIComponent(opts.branch)}`,
      { sha: commit.sha },
    )
    return { commitSha: commit.sha }
  }

  async writeFile(
    repo: RepoRef,
    path: string,
    content: string,
    opts: { branch: string; message: string; sha?: string },
  ): Promise<{ commitSha: string }> {
    const payload = {
      message: opts.message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: opts.branch,
      ...(opts.sha ? { sha: opts.sha } : {}),
    }
    // GitHub: PUT dient sowohl der Anlage als auch der Aktualisierung einer Datei.
    const data = (await this.#request(
      'PUT',
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}`,
      payload,
    )) as { commit: { sha: string } }
    return { commitSha: data.commit.sha }
  }

  async writeFileBinary(
    repo: RepoRef,
    path: string,
    content: Buffer,
    opts: { branch: string; message: string; sha?: string },
  ): Promise<{ commitSha: string }> {
    const payload = {
      message: opts.message,
      content: content.toString('base64'),
      branch: opts.branch,
      ...(opts.sha ? { sha: opts.sha } : {}),
    }
    const data = (await this.#request(
      'PUT',
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}`,
      payload,
    )) as { commit: { sha: string } }
    return { commitSha: data.commit.sha }
  }

  async deleteFile(
    repo: RepoRef,
    path: string,
    opts: { branch: string; message: string; sha: string },
  ): Promise<{ commitSha: string }> {
    const data = (await this.#request(
      'DELETE',
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}`,
      { message: opts.message, sha: opts.sha, branch: opts.branch },
    )) as { commit: { sha: string } }
    return { commitSha: data.commit.sha }
  }

  async listTree(repo: RepoRef, ref: string): Promise<TreeEntry[]> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )) as { tree: Array<{ path: string; type: string; sha: string }>; truncated: boolean }
    if (data.truncated) {
      throw new ProviderError('Repo-Baum wurde abgeschnitten (truncated) — zu groß für eine einzelne Anfrage')
    }
    return data.tree.map((entry) => ({
      path: entry.path,
      type: entry.type === 'blob' ? 'file' : 'dir',
      sha: entry.sha,
    }))
  }

  async getHeadSha(repo: RepoRef, branch: string): Promise<string> {
    // GET .../branches/{branch} erwartet den Branch-Namen als EIN Pfadsegment
    // (kein hierarchischer Ref-Pfad wie bei git/refs). Slashes in Branch-Namen
    // (z. B. unser Kern-Workflow "draft/8f3ka2") müssen daher voll-encodiert
    // werden (draft%2F8f3ka2), sonst interpretiert GitHubs Routing sie als
    // zusätzliche Pfadsegmente → 404. Siehe Kommentar an encodePath() für die
    // vollständige Konvention.
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`,
    )) as { commit: { sha: string } }
    return data.commit.sha
  }

  async createBranch(repo: RepoRef, name: string, fromBranch: string): Promise<void> {
    const sha = await this.getHeadSha(repo, fromBranch)
    await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha,
    })
  }

  async deleteBranch(repo: RepoRef, name: string): Promise<void> {
    // git/refs/heads/{name} ist — anders als branches/{branch} — ein
    // hierarchischer Ref-Pfad: Git-Refs selbst enthalten Slashes als
    // Segmenttrenner (refs/heads/draft/8f3ka2 ist ein gültiger, vierteiliger
    // Ref). Der Slash muss hier daher literal bleiben; encodePath() encodet
    // nur die einzelnen Segmente, nicht den trennenden Slash.
    await this.#request(
      'DELETE',
      `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${encodePath(name)}`,
    )
  }

  async listCommits(
    repo: RepoRef,
    opts: { ref: string; path?: string; limit?: number },
  ): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ sha: opts.ref })
    if (opts.path) params.set('path', opts.path)
    if (opts.limit) params.set('per_page', String(opts.limit))
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/commits?${params.toString()}`,
    )) as Array<{ sha: string; commit: { message: string; author: { name: string; email: string; date: string } } }>
    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author.name,
      authorEmail: c.commit.author.email,
      date: c.commit.author.date,
    }))
  }

  async createPullRequest(
    repo: RepoRef,
    opts: { head: string; base: string; title: string; body?: string },
  ): Promise<PullRequestInfo> {
    const data = (await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/pulls`, {
      title: opts.title,
      head: opts.head,
      base: opts.base,
      body: opts.body,
    })) as GitHubPullResponse
    return mapPullRequest(data)
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    )) as GitHubPullResponse
    return mapPullRequest(data)
  }

  async listPullRequests(
    repo: RepoRef,
    opts: { head?: string; base?: string; state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<PullRequestInfo[]> {
    const params = new URLSearchParams()
    // GitHub erwartet `head` qualifiziert als "owner:branch", nicht den reinen
    // Branch-Namen (sonst würde es auch Forks anderer Owner mit demselben
    // Branch-Namen matchen).
    if (opts.head) params.set('head', `${repo.owner}:${opts.head}`)
    if (opts.base) params.set('base', opts.base)
    if (opts.state) params.set('state', opts.state)
    const qs = params.toString()
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls${qs ? `?${qs}` : ''}`,
    )) as GitHubPullResponse[]
    return data.map(mapPullRequest)
  }

  async requestReviewers(repo: RepoRef, number: number, reviewers: string[]): Promise<void> {
    await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/pulls/${number}/requested_reviewers`, {
      reviewers,
    })
  }

  async submitPullRequestReview(
    repo: RepoRef,
    number: number,
    opts: { event: 'approve' | 'request_changes'; body?: string },
  ): Promise<void> {
    await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`, {
      event: opts.event === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
      body: opts.body,
    })
  }

  /** Merge per Merge-Commit. Wirft ConflictError, wenn nicht mergebar (409) oder
   *  Branch-Protection den Merge verhindert (405 — von toProviderError NICHT als
   *  Konflikt gemappt, daher hier explizit behandelt). */
  async mergePullRequest(repo: RepoRef, number: number): Promise<{ mergeSha: string }> {
    try {
      const data = (await this.#request(
        'PUT',
        `/repos/${repo.owner}/${repo.repo}/pulls/${number}/merge`,
        { merge_method: 'merge' },
      )) as { sha: string }
      return { mergeSha: data.sha }
    } catch (err) {
      if (err instanceof ProviderError && err.status === 405) {
        throw new ConflictError('PR nicht mergebar (405)', err.body)
      }
      throw err
    }
  }
}

interface GitHubPullResponse {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  title: string
  head: { ref: string }
  base: { ref: string }
  html_url: string
  /** `null`/`undefined`, solange GitHub die Mergebarkeit noch berechnet;
   *  `createPullRequest`/`listPullRequests`-Antworten enthalten das Feld oft
   *  gar nicht erst. */
  mergeable?: boolean | null
}

function mapPullRequest(data: GitHubPullResponse): PullRequestInfo {
  return {
    number: data.number,
    state: data.merged ? 'merged' : data.state,
    title: data.title,
    headBranch: data.head.ref,
    baseBranch: data.base.ref,
    url: data.html_url,
    mergeable: data.mergeable ?? null,
  }
}

/**
 * Encoding-Konvention für GitHub-API-Pfade:
 *
 * - contents/{path} und git/refs/heads/{name}: hierarchische Pfade, bei denen
 *   der Slash strukturelle Bedeutung hat (Verzeichnistrennung bzw. Git-Ref-
 *   Segmente). Hier `encodePath()` verwenden: encodet jedes Segment einzeln,
 *   der trennende Slash bleibt literal erhalten.
 * - branches/{branch}: erwartet den Branch-Namen als EIN Pfadsegment. Ein
 *   Slash im Branch-Namen (z. B. "draft/8f3ka2") ist hier KEIN Trenner,
 *   sondern Teil des Namens und muss voll-encodiert werden — dafür direkt
 *   `encodeURIComponent()` verwenden, nicht `encodePath()`.
 */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}
