// Adapted from BookBridge (github.com/rotecodefraktion/bookbridge)

/** BookStack API response types */

export interface BookStackListResponse<T> {
  data: T[]
  total: number
}

export interface BookStackTag {
  name: string
  value: string
  order?: number
}

/** One hit of `GET search`, reduced to what the export needs. */
export interface BookStackSearchHit {
  id: number
  type: 'book' | 'chapter' | 'page'
  name: string
}

export interface BookStackBook {
  id: number
  name: string
  slug: string
  description: string
  description_html?: string
  created_at: string
  updated_at: string
  created_by: number
  updated_by: number
  owned_by: number
}

export interface BookStackShelf {
  id: number
  name: string
  slug: string
  description: string
  description_html?: string
  books: BookStackBook[]
  tags?: BookStackTag[]
}

export interface BookStackBookContents {
  id: number
  name: string
  slug: string
  description: string
  description_html?: string
  created_at: string
  updated_at: string
  contents: BookStackBookContentItem[]
  tags?: BookStackTag[]
}

export interface BookStackBookContentItem {
  id: number
  name: string
  slug: string
  type: 'chapter' | 'page'
  updated_at: string
  priority: number
  /** Only present when type === 'page' */
  draft?: boolean
  /** Only present when type === 'chapter' */
  pages?: BookStackBookContentPage[]
}

export interface BookStackBookContentPage {
  id: number
  name: string
  slug: string
  draft: boolean
  updated_at: string
  priority: number
}

export interface BookStackChapter {
  id: number
  book_id: number
  name: string
  slug: string
  description: string
  description_html?: string
  priority: number
  created_at: string
  updated_at: string
  pages: BookStackPage[]
  tags?: BookStackTag[]
}

export interface BookStackPage {
  id: number
  book_id: number
  chapter_id: number
  name: string
  slug: string
  html: string
  markdown: string
  priority: number
  draft: boolean
  created_at: string
  updated_at: string
  created_by: number
  updated_by: number
  owned_by: number
  tags?: BookStackTag[]
}

export interface BookStackImage {
  id: number
  name: string
  url: string
  path: string
  type: string
  uploaded_to: number
  created_at: string
  updated_at: string
}

export interface BookStackAttachment {
  id: number
  name: string
  extension: string
  uploaded_to: number
  external: boolean
  order: number
  created_at: string
  updated_at: string
}

export interface BookStackAttachmentDetail extends BookStackAttachment {
  /** base64 encoded content for non-external attachments */
  content: string
}
