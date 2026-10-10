// Adapted from BookBridge (github.com/rotecodefraktion/bookbridge)

import type {
  BookStackListResponse,
  BookStackBook,
  BookStackBookContents,
  BookStackPage,
  BookStackChapter,
  BookStackImage,
  BookStackAttachment,
  BookStackAttachmentDetail,
  BookStackShelf,
  BookStackTag,
  BookStackSearchHit,
} from './types.js'

/** BookStack's default API limit is 180 requests per minute. */
const MAX_REQUESTS_PER_SECOND = 3
const DEFAULT_TIMEOUT = 30000
const MAX_RETRIES = 3
const BASE_RETRY_DELAY = 100

interface RequestOptions {
  method?: string
  body?: unknown
  expectText?: boolean
}

export class BookStackClient {
  private requestTimestamps: number[] = []
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly tokenId: string,
    private readonly tokenSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now()
    // Remove timestamps older than 1 second
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 1000)

    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
      const oldest = this.requestTimestamps[0]!
      const waitMs = 1000 - (now - oldest)
      if (waitMs > 0) await this.sleep(waitMs)
    }

    this.requestTimestamps.push(Date.now())
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private authHeader(): string {
    return `Token ${this.tokenId}:${this.tokenSecret}`
  }

  private async request<T>(endpoint: string, opts: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, expectText = false } = opts
    const headers: Record<string, string> = { Authorization: this.authHeader() }
    let payload: BodyInit | undefined
    if (body instanceof FormData) {
      // fetch sets the multipart boundary itself
      payload = body
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.rateLimit()
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/${endpoint}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
        })

        if (res.status === 429 && attempt < MAX_RETRIES) {
          await this.sleep(BASE_RETRY_DELAY * Math.pow(2, attempt))
          continue
        }

        if (res.status === 401) {
          throw new BookStackAuthError('Authentication failed. Check your API token.')
        }

        if (res.status === 404) {
          throw new BookStackNotFoundError(`Resource not found: ${endpoint}`)
        }

        if (res.status >= 400) {
          let message = `HTTP ${res.status}`
          try {
            const json = (await res.json()) as { error?: { message?: string } }
            message = json?.error?.message ?? message
          } catch {
            /* keep the status message */
          }
          throw new BookStackApiError(message, res.status)
        }

        if (expectText) return (await res.text()) as T
        if (res.status === 204) return undefined as T
        return (await res.json()) as T
      } catch (error) {
        if (error instanceof BookStackApiError) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < MAX_RETRIES) {
          await this.sleep(BASE_RETRY_DELAY * Math.pow(2, attempt))
          continue
        }
      }
    }

    throw lastError ?? new Error('Request failed after retries')
  }

  /** Test the connection by fetching the books list */
  async testConnection(): Promise<boolean> {
    await this.getBooks(1)
    return true
  }

  async getBooks(count = 500, offset = 0): Promise<BookStackListResponse<BookStackBook>> {
    return this.request<BookStackListResponse<BookStackBook>>(`books?count=${count}&offset=${offset}`)
  }

  async getAllBooks(): Promise<BookStackBook[]> {
    const books: BookStackBook[] = []
    let offset = 0
    const count = 500

    while (true) {
      const response = await this.getBooks(count, offset)
      books.push(...response.data)
      if (books.length >= response.total || response.data.length === 0) break
      offset += count
    }

    return books
  }

  async getBookContents(id: number): Promise<BookStackBookContents> {
    return this.request<BookStackBookContents>(`books/${id}`)
  }

  async getShelf(id: number): Promise<BookStackShelf> {
    return this.request<BookStackShelf>(`shelves/${id}`)
  }

  async getShelves(): Promise<BookStackListResponse<BookStackShelf>> {
    return this.request<BookStackListResponse<BookStackShelf>>('shelves?count=500')
  }

  async findBySlug(kind: 'books' | 'shelves', slug: string): Promise<number | null> {
    const r = await this.request<BookStackListResponse<{ id: number; slug: string }>>(
      `${kind}?filter[slug]=${encodeURIComponent(slug)}`,
    )
    return r.data[0]?.id ?? null
  }

  async getChapter(id: number): Promise<BookStackChapter> {
    return this.request<BookStackChapter>(`chapters/${id}`)
  }

  async getPage(id: number): Promise<BookStackPage> {
    return this.request<BookStackPage>(`pages/${id}`)
  }

  /** Tags come with `GET pages/:id`; this only reads them off the page. */
  getPageTags(page: BookStackPage): BookStackTag[] {
    return page.tags ?? []
  }

  async getPageExportHtml(id: number): Promise<string> {
    return this.request<string>(`pages/${id}/export/html`, { expectText: true })
  }

  async createPage(data: {
    book_id?: number
    chapter_id?: number
    name: string
    html: string
    priority?: number
    tags?: BookStackTag[]
  }): Promise<BookStackPage> {
    return this.request<BookStackPage>('pages', { method: 'POST', body: data })
  }

  async updatePage(
    id: number,
    data: {
      name?: string
      html?: string
      priority?: number
      tags?: BookStackTag[]
      chapter_id?: number
      book_id?: number
    },
  ): Promise<BookStackPage> {
    return this.request<BookStackPage>(`pages/${id}`, { method: 'PUT', body: data })
  }

  async createBook(data: { name: string; description_html?: string; tags?: BookStackTag[] }): Promise<BookStackBook> {
    return this.request<BookStackBook>('books', { method: 'POST', body: data })
  }

  async updateBook(
    id: number,
    data: { name?: string; description_html?: string; tags?: BookStackTag[] },
  ): Promise<BookStackBook> {
    return this.request<BookStackBook>(`books/${id}`, { method: 'PUT', body: data })
  }

  async createChapter(data: {
    book_id: number
    name: string
    description_html?: string
    priority?: number
    tags?: BookStackTag[]
  }): Promise<BookStackChapter> {
    return this.request<BookStackChapter>('chapters', { method: 'POST', body: data })
  }

  async updateChapter(
    id: number,
    data: { name?: string; description_html?: string; priority?: number; tags?: BookStackTag[] },
  ): Promise<BookStackChapter> {
    return this.request<BookStackChapter>(`chapters/${id}`, { method: 'PUT', body: data })
  }

  /** Find books, chapters and pages carrying the tag `name=value`. */
  async searchByTag(name: string, value: string): Promise<BookStackSearchHit[]> {
    const r = await this.request<BookStackListResponse<BookStackSearchHit>>(
      `search?query=${encodeURIComponent(`[${name}=${value}]`)}&count=100`,
    )
    return r.data.map((h) => ({ id: h.id, type: h.type, name: h.name }))
  }

  /** Gallery images whose name starts with `name`. */
  async listGalleryImages(name: string): Promise<BookStackImage[]> {
    const r = await this.request<BookStackListResponse<BookStackImage>>(
      // `%25` is a literal `%`, the SQL LIKE wildcard BookStack expects
      `image-gallery?filter[name:like]=${encodeURIComponent(name)}%25`,
    )
    return r.data
  }

  async uploadAttachment(
    pageId: number,
    name: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<BookStackAttachment> {
    const form = new FormData()
    form.append('uploaded_to', String(pageId))
    form.append('name', name)
    form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], name, { type: mime }))
    return this.request<BookStackAttachment>('attachments', { method: 'POST', body: form })
  }

  async deletePage(id: number): Promise<void> {
    await this.request<void>(`pages/${id}`, { method: 'DELETE', expectText: true })
  }

  async getImage(id: number): Promise<BookStackImage> {
    return this.request<BookStackImage>(`image-gallery/${id}`)
  }

  async getImagesForPage(pageId: number): Promise<BookStackListResponse<BookStackImage>> {
    return this.request<BookStackListResponse<BookStackImage>>(`image-gallery?filter[uploaded_to]=${pageId}&count=500`)
  }

  /** Upload an image to the BookStack image gallery (multipart/form-data). */
  async uploadImage(pageId: number, name: string, imageData: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<BookStackImage> {
    // Keep the filename safe for the multipart header
    const safeName = name.replace(/["\r\n]/g, '').replace(/[^\x20-\x7E]/g, '_')
    const form = new FormData()
    form.append('uploaded_to', String(pageId))
    form.append('type', 'gallery')
    form.append('name', safeName)
    form.append('image', new File([imageData], safeName, { type: guessMimeType(safeName) }))
    return this.request<BookStackImage>('image-gallery', { method: 'POST', body: form })
  }

  async getAttachmentsForPage(pageId: number): Promise<BookStackListResponse<BookStackAttachment>> {
    return this.request<BookStackListResponse<BookStackAttachment>>(`attachments?filter[uploaded_to]=${pageId}`)
  }

  async getAttachment(id: number): Promise<BookStackAttachmentDetail> {
    return this.request<BookStackAttachmentDetail>(`attachments/${id}`)
  }

  async getAttachmentContent(id: number): Promise<Uint8Array> {
    const a = await this.getAttachment(id)
    return Uint8Array.from(Buffer.from(a.content, 'base64'))
  }

  /** GET an arbitrary URL (e.g. an image under `/uploads`) and return its bytes.
   *  Relative URLs resolve against the BookStack base URL. The API token is only
   *  sent to the BookStack origin, never to a foreign host. */
  async downloadUrl(url: string): Promise<Uint8Array> {
    await this.rateLimit()
    const target = new URL(url, `${this.baseUrl}/`)
    const headers: Record<string, string> = {}
    if (target.origin === new URL(this.baseUrl).origin) headers.Authorization = this.authHeader()
    const res = await this.fetchImpl(target.href, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT) })
    if (res.status >= 400) throw new BookStackApiError(`download ${target.href} → ${res.status}`, res.status)
    return new Uint8Array(await res.arrayBuffer())
  }
}

export class BookStackApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'BookStackApiError'
  }
}

export class BookStackAuthError extends BookStackApiError {
  constructor(message: string) {
    super(message, 401)
    this.name = 'BookStackAuthError'
  }
}

export class BookStackNotFoundError extends BookStackApiError {
  constructor(message: string) {
    super(message, 404)
    this.name = 'BookStackNotFoundError'
  }
}

/** Guess MIME type from filename extension for image uploads. */
function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
  }
  return mimeTypes[ext] ?? 'application/octet-stream'
}
