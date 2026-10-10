export class F451ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
    this.name = 'F451ApiError'
  }
}

export interface TreeNode { id: string; title: string; path: string; archived: boolean; children: TreeNode[] }

type CallInit = RequestInit & { expectText?: boolean }

const RETRY = 3

export class F451Api {
  private readonly retryDelayMs: number
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    opts: { retryDelayMs?: number } = {},
  ) {
    this.retryDelayMs = opts.retryDelayMs ?? 500
  }

  private async call(path: string, init: CallInit = {}): Promise<{ status: number; body: unknown }> {
    const { expectText, ...fetchInit } = init
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string> | undefined) }
    if (init.body && !(init.body instanceof FormData)) headers['content-type'] = 'application/json'
    let last: { status: number; body: unknown } = { status: 0, body: null }
    for (let attempt = 0; attempt < RETRY; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...fetchInit, headers })
      const text = await res.text()
      let body: unknown = text
      if (!expectText) { try { body = JSON.parse(text) } catch { /* keep text */ } }
      last = { status: res.status, body }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < RETRY - 1) await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt))
        continue
      }
      return last
    }
    throw new F451ApiError(`${path} failed with ${last.status}`, last.status, last.body)
  }

  private async expect<T>(path: string, init: CallInit, ok: number[]): Promise<T> {
    const r = await this.call(path, init)
    if (!ok.includes(r.status)) throw new F451ApiError(`${path} failed with ${r.status}`, r.status, r.body)
    return r.body as T
  }

  /** `GET /api/spaces/:space/tree` returns the root nodes as a plain array
   *  (`apps/api/src/routes/pages.ts`, `rootIds.map(build)`). */
  tree(space: string): Promise<TreeNode[]> {
    return this.expect<TreeNode[]>(`/api/spaces/${space}/tree`, {}, [200])
  }

  raw(pageId: string): Promise<string> {
    return this.expect<string>(`/api/pages/${pageId}/raw`, { expectText: true }, [200])
  }

  createPage(p: { space: string; title: string; parentId?: string }): Promise<{ id: string; path: string; baseSha: string; content: string }> {
    return this.expect('/api/pages', { method: 'POST', body: JSON.stringify(p) }, [201])
  }

  async getDraft(pageId: string): Promise<{ baseSha: string; content: string } | null> {
    const r = await this.call(`/api/pages/${pageId}/draft`)
    if (r.status === 404) return null
    if (r.status !== 200) throw new F451ApiError(`draft ${r.status}`, r.status, r.body)
    return r.body as { baseSha: string; content: string }
  }

  openDraft(pageId: string): Promise<{ baseSha: string; content: string }> {
    return this.expect(`/api/pages/${pageId}/draft`, { method: 'POST' }, [200])
  }

  putDraft(pageId: string, content: string, baseSha: string, message: string): Promise<{ newSha: string }> {
    return this.expect(`/api/pages/${pageId}/draft`, { method: 'PUT', body: JSON.stringify({ content, baseSha, message }) }, [200])
  }

  uploadMedia(pageId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ path: string; markdown: string; kind: string }> {
    const form = new FormData()
    form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name, { type: mime }))
    return this.expect(`/api/pages/${pageId}/draft/media`, { method: 'POST', body: form }, [200, 201])
  }

  /** A file from the page's `_media/`, or null if it does not exist. */
  async media(pageId: string, name: string, ref: 'main' | 'draft'): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/media/${pageId}/${encodeURIComponent(name)}?ref=${ref}`, {
      headers: { authorization: `Bearer ${this.token}` },
    })
    if (res.status === 404) return null
    if (res.status !== 200) throw new F451ApiError(`media ${name} failed with ${res.status}`, res.status, null)
    return new Uint8Array(await res.arrayBuffer())
  }

  async discardDraft(pageId: string): Promise<void> {
    await this.expect(`/api/pages/${pageId}/draft`, { method: 'DELETE' }, [200, 204])
  }

  requestReview(pageId: string): Promise<{ number: number; url: string }> {
    return this.expect(`/api/pages/${pageId}/review`, { method: 'POST', body: '{}' }, [200])
  }

  release(pageId: string, p: { bump: 'major' | 'minor' | 'patch'; note: string }): Promise<{ mergeSha: string }> {
    return this.expect(`/api/pages/${pageId}/release`, { method: 'POST', body: JSON.stringify(p) }, [200])
  }

  async reorder(space: string, parentId: string | null, orderedIds: string[]): Promise<void> {
    await this.expect(`/api/spaces/${space}/order`, { method: 'PUT', body: JSON.stringify({ parentId, orderedIds }) }, [200])
  }
}
