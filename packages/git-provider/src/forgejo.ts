import type {
  CommitInfo, FileChange, GitFile, GitProvider, PullRequestInfo, RepoRef, TreeEntry,
} from './types.js'
import { ConflictError, NotFoundError, ProviderError, toProviderError } from './errors.js'

/** Backoff-Rahmen für Mergebarkeits-Polling und 405-Retry: 200 ms Start,
 *  Verdopplung, insgesamt max. ~15 s. */
const MERGE_BACKOFF_START_MS = 200
const MERGE_BACKOFF_BUDGET_MS = 15_000

/** Seitengröße für `listTree`. 1000 ist Forgejos übliche Obergrenze
 *  (`MAX_RESPONSE_ITEMS`); größere Werte werden serverseitig gekappt. */
const TREE_PAGE_SIZE = 1000
/** Notbremse gegen endloses Blättern, falls `total_count` nie erreicht wird:
 *  100 Seiten × 1000 = 100.000 Einträge, weit jenseits jedes Doku-Repos. */
const TREE_PAGE_LIMIT = 100

/** Dateien je Sammel-Commit (`commitFiles`). Sie reisen base64-kodiert im
 *  JSON-Körper — 50 hält die Anfrage im einstelligen Megabyte-Bereich, selbst
 *  wenn jede Datei ein Bildschirmabzug ist. */
const CHANGE_FILES_CHUNK = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface ForgejoProviderOptions {
  /** z. B. https://git.firma.de (ohne /api/v1). */
  baseUrl: string
  token: string
}

/** GitProvider-Implementierung über die Forgejo-REST-API (v1). */
export class ForgejoProvider implements GitProvider {
  readonly #base: string
  readonly #token: string

  constructor(opts: ForgejoProviderOptions) {
    this.#base = opts.baseUrl.replace(/\/$/, '')
    this.#token = opts.token
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.#base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${this.#token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw toProviderError(res.status, await res.text())
    if (res.status === 204) return undefined
    // Forgejo liefert für einige Endpunkte (z. B. PR-Merge) 200 mit leerem Body statt 204.
    const text = await res.text()
    if (text.length === 0) return undefined
    return JSON.parse(text)
  }

  async readFile(repo: RepoRef, path: string, ref: string): Promise<GitFile> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    )) as { type: string; content: string; sha: string; path: string }
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
    )) as { type: string; content: string; sha: string }
    if (data.type !== 'file') throw new NotFoundError(`${path} ist keine Datei`)
    return { content: Buffer.from(data.content, 'base64'), sha: data.sha }
  }

  async writeFile(
    repo: RepoRef,
    path: string,
    content: string,
    opts: { branch: string; message: string; sha?: string },
  ): Promise<{ commitSha: string }> {
    const payload = {
      branch: opts.branch,
      message: opts.message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(opts.sha ? { sha: opts.sha } : {}),
    }
    // Forgejo: POST = anlegen, PUT = aktualisieren (mit sha)
    const data = (await this.#request(
      opts.sha ? 'PUT' : 'POST',
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
      branch: opts.branch,
      message: opts.message,
      content: content.toString('base64'),
      ...(opts.sha ? { sha: opts.sha } : {}),
    }
    const data = (await this.#request(
      opts.sha ? 'PUT' : 'POST',
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
    try {
      const data = (await this.#request(
        'DELETE',
        `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}`,
        { branch: opts.branch, message: opts.message, sha: opts.sha },
      )) as { commit: { sha: string } }
      return { commitSha: data.commit.sha }
    } catch (err) {
      // Forgejo meldet einen SHA-Mismatch auf DIESEM Endpunkt (anders als bei
      // `writeFile`s PUT, das 409/422 liefert — von `toProviderError` bereits
      // generisch als Konflikt gemappt) mit 400 ("sha does not match …",
      // empirisch gegen Forgejo 11 geprüft) — ohne diese Sonderbehandlung
      // würde ein Delete-Konflikt fälschlich als generischer `ProviderError`
      // statt `ConflictError` durchgereicht, der Aufrufer könnte ihn nicht
      // vom "Datei gibt's nicht"-Fall unterscheiden.
      if (err instanceof ProviderError && !(err instanceof NotFoundError) && err.status === 400) {
        throw new ConflictError(`Konflikt (400): ${err.message}`, err.body)
      }
      throw err
    }
  }

  /**
   * Sammel-Commit über den ChangeFiles-Endpunkt (`POST .../contents` mit
   * `files[]`) — anders als der Einzeldatei-Endpunkt, der Pfad UND Operation
   * aus URL und HTTP-Methode ableitet, nimmt dieser eine Liste von Operationen
   * entgegen und schreibt sie in einen Commit.
   *
   * Aufgeteilt wird in Blöcke: Die Dateien reisen base64-kodiert im
   * JSON-Körper, und ein Move über hundert Bildschirmabzüge käme sonst auf
   * zweistellige Megabyte in einer einzigen Anfrage. `CHANGE_FILES_CHUNK`
   * hält die Anfragen handhabbar, ohne den Gewinn aufzugeben — aus 400
   * Commits werden acht, nicht wieder 400.
   */
  async commitFiles(
    repo: RepoRef,
    changes: FileChange[],
    opts: { branch: string; message: string },
  ): Promise<{ commitSha: string | null }> {
    let commitSha: string | null = null
    for (let i = 0; i < changes.length; i += CHANGE_FILES_CHUNK) {
      const chunk = changes.slice(i, i + CHANGE_FILES_CHUNK)
      const files = chunk.map((change) =>
        change.op === 'delete'
          ? { operation: 'delete' as const, path: change.path, sha: change.sha }
          : {
              // Forgejo unterscheidet `create` und `update` — mit bekanntem
              // Blob-SHA ist es ein Update, ohne ein Anlegen. Dieselbe
              // Unterscheidung wie beim Einzelweg (POST vs. PUT).
              operation: change.sha ? ('update' as const) : ('create' as const),
              path: change.path,
              content: change.content.toString('base64'),
              ...(change.sha ? { sha: change.sha } : {}),
            },
      )
      const data = (await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/contents`, {
        branch: opts.branch,
        message: opts.message,
        files,
      })) as { commit?: { sha?: string } }
      commitSha = data.commit?.sha ?? commitSha
    }
    return { commitSha }
  }

  async listTree(repo: RepoRef, ref: string): Promise<TreeEntry[]> {
    // Forgejo paginiert diesen Endpunkt und deckelt `per_page` auf 1000 (Instanz-
    // Limit `MAX_RESPONSE_ITEMS`). `truncated: true` heißt hier NUR "passt nicht in
    // EINE Seite" — nicht "unvollständig abrufbar" wie bei GitHub, wo derselbe
    // Endpunkt kein Paging kennt (s. `github.ts`, dort bleibt truncated ein Fehler).
    // Den Wert als Fehler zu werten, machte jedes Repo ab 1001 Einträgen komplett
    // unindexierbar (echter Fall: Space "handbuch" mit 1309 Einträgen — Reindex UND
    // Drift-Erkennung schlugen dauerhaft fehl). Deshalb: über `total_count` blättern.
    const entries: TreeEntry[] = []
    let page = 1

    for (;;) {
      const data = (await this.#request(
        'GET',
        `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}` +
          `?recursive=true&page=${page}&per_page=${TREE_PAGE_SIZE}`,
      )) as {
        tree: Array<{ path: string; type: string; sha: string }> | null
        truncated: boolean
        total_count?: number
      }

      const chunk = data.tree ?? []
      for (const entry of chunk) {
        entries.push({
          path: entry.path,
          type: entry.type === 'blob' ? 'file' : 'dir',
          sha: entry.sha,
        })
      }

      const total = typeof data.total_count === 'number' ? data.total_count : entries.length
      if (entries.length >= total) return entries

      // Fail-Loud statt still unvollständiger Baum: eine leere Seite trotz
      // ausstehender Einträge (oder ein absurd tiefes Blättern) bedeutet, dass
      // die Antwort nicht zu `total_count` passt — ein unvollständiger Baum
      // würde beim Indexieren als "Seiten gelöscht" durchschlagen.
      if (chunk.length === 0 || page >= TREE_PAGE_LIMIT) {
        throw new ProviderError(
          `Repo-Baum unvollständig: ${entries.length} von ${total} Einträgen nach ${page} Seite(n) geladen`,
        )
      }
      page += 1
    }
  }

  async getHeadSha(repo: RepoRef, branch: string): Promise<string> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`,
    )) as { commit: { id: string } }
    return data.commit.id
  }

  async createBranch(repo: RepoRef, name: string, fromBranch: string): Promise<void> {
    await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/branches`, {
      new_branch_name: name,
      old_branch_name: fromBranch,
    })
  }

  async deleteBranch(repo: RepoRef, name: string): Promise<void> {
    await this.#request('DELETE', `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(name)}`)
  }

  async listCommits(
    repo: RepoRef,
    opts: { ref: string; path?: string; limit?: number },
  ): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ sha: opts.ref })
    if (opts.path) params.set('path', opts.path)
    if (opts.limit) params.set('limit', String(opts.limit))
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
      head: opts.head,
      base: opts.base,
      title: opts.title,
      body: opts.body,
    })) as ForgejoPullResponse
    return mapPullRequest(data)
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo> {
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    )) as ForgejoPullResponse
    return mapPullRequest(data)
  }

  async listPullRequests(
    repo: RepoRef,
    opts: { head?: string; base?: string; state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<PullRequestInfo[]> {
    const params = new URLSearchParams()
    if (opts.state) params.set('state', opts.state)
    const qs = params.toString()
    const data = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls${qs ? `?${qs}` : ''}`,
    )) as ForgejoPullResponse[]
    // Forgejo filtert `head` serverseitig nicht zuverlässig (undokumentiertes
    // Verhalten, beobachtet gegen Forgejo 11) — deshalb clientseitig nachfiltern.
    // `base` filtert Forgejo korrekt mit, wir filtern trotzdem defensiv mit.
    return data
      .map(mapPullRequest)
      .filter((pr) => !opts.head || pr.headBranch === opts.head)
      .filter((pr) => !opts.base || pr.baseBranch === opts.base)
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

  /** Merge per Merge-Commit. Wirft ConflictError, wenn nicht mergebar.
   *
   *  Forgejo berechnet die Mergebarkeit frischer PRs asynchron: `POST .../merge`
   *  liefert transient 405, bis der Check abgeschlossen ist. Wir pollen daher
   *  zuerst `GET .../pulls/{number}`, bis `mergeable === true`, und retryen den
   *  Merge-POST bei 405 begrenzt, da zwischen Poll und POST erneut ein Race
   *  möglich ist. Anders als bei GitHub ist 405 bei Forgejo NICHT gleichbedeutend
   *  mit einem echten Konflikt — der äußert sich hier über `mergeable === false`. */
  async mergePullRequest(repo: RepoRef, number: number): Promise<{ mergeSha: string }> {
    await this.#waitUntilMergeable(repo, number)
    await this.#mergeWithRetry(repo, number)
    const pr = (await this.#request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    )) as ForgejoPullResponse
    const mergeSha = pr.merge_commit_sha ?? pr.merged_commit_sha
    if (!mergeSha) throw new ProviderError('merge_commit_sha fehlt in der Antwort nach dem Merge')
    return { mergeSha }
  }

  /** Pollt GET .../pulls/{number}, bis `mergeable === true` oder das Backoff-Budget
   *  ausgeschöpft ist. Bleibt `mergeable` dabei zuletzt `false`, liegt ein echter
   *  Merge-Konflikt vor (ConflictError); bleibt es unklar (z. B. weiterhin `null`,
   *  weil Forgejo den Check noch nicht abgeschlossen hat), wird ein aussagekräftiger
   *  ProviderError geworfen. */
  async #waitUntilMergeable(repo: RepoRef, number: number): Promise<void> {
    const deadline = Date.now() + MERGE_BACKOFF_BUDGET_MS
    let delay = MERGE_BACKOFF_START_MS
    let lastMergeable: boolean | null | undefined

    for (;;) {
      const pr = (await this.#request(
        'GET',
        `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
      )) as ForgejoPullResponse
      lastMergeable = pr.mergeable
      if (lastMergeable === true) return

      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(delay, remaining))
      delay *= 2
    }

    if (lastMergeable === false) {
      throw new ConflictError(
        `PR #${number} ist nicht mergebar (mergeable=false nach ${MERGE_BACKOFF_BUDGET_MS}ms Warten)`,
      )
    }
    throw new ProviderError(
      `Timeout beim Warten auf Mergebarkeit von PR #${number}: mergeable wurde nach `
        + `${MERGE_BACKOFF_BUDGET_MS}ms nicht true (letzter Wert: ${String(lastMergeable)})`,
    )
  }

  /** Führt den Merge-POST aus und retryt bei transienten 405-Antworten (gleicher
   *  Backoff-Rahmen wie #waitUntilMergeable) — zwischen Poll und POST kann Forgejo
   *  erneut kurz "nicht mergebar" melden, obwohl der PR es tatsächlich ist. */
  async #mergeWithRetry(repo: RepoRef, number: number): Promise<void> {
    const deadline = Date.now() + MERGE_BACKOFF_BUDGET_MS
    let delay = MERGE_BACKOFF_START_MS

    for (;;) {
      try {
        await this.#request('POST', `/repos/${repo.owner}/${repo.repo}/pulls/${number}/merge`, {
          Do: 'merge',
        })
        return
      } catch (err) {
        if (!(err instanceof ProviderError) || err.status !== 405) throw err
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new ProviderError(
            `Merge von PR #${number} weiterhin 405 (transient) nach `
              + `${MERGE_BACKOFF_BUDGET_MS}ms Retry-Budget`,
            err.status,
            err.body,
          )
        }
        await sleep(Math.min(delay, remaining))
        delay *= 2
      }
    }
  }
}

interface ForgejoPullResponse {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  title: string
  head: { ref: string }
  base: { ref: string }
  html_url: string
  merge_commit_sha?: string
  /** Ältere Forgejo-Versionen liefern dieses Feld statt merge_commit_sha. */
  merged_commit_sha?: string
  /** `null`/`undefined`, solange Forgejo die Mergebarkeit noch berechnet. */
  mergeable?: boolean | null
}

function mapPullRequest(data: ForgejoPullResponse): PullRequestInfo {
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

/** Pfadsegmente einzeln encoden, Slashes erhalten. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}
