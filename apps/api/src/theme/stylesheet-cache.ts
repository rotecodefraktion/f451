import type { StylesheetProblem } from '@f451/design-tokens'

/**
 * Cache of the theme stylesheet (`_meta/theme.css`) and the font set
 * (`_meta/fonts/`, f451#61), one entry per scope: `instance` or `space:<id>`.
 * A missing or rejected file is cached as well.
 *
 * Kept apart from `stylesheet.ts` so the theme loaders can empty it without an
 * import cycle (`stylesheet.ts` imports `instance-theme.ts`) — pattern `brand-cache.ts`.
 */

/** What the repo holds at `_meta/theme.css`; only `ok` is served. */
export type StylesheetState =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'ok'; css: string; sha: string; bytes: number }
  | { status: 'too_large'; sha: string; bytes: number }
  | { status: 'invalid'; sha: string; bytes: number; problems: StylesheetProblem[] }

export type FontProblem =
  | 'font_name'
  | 'font_too_large'
  | 'font_not_woff2'
  | 'font_total_exceeded'
  | 'font_unreadable'

/** One file under `_meta/fonts/`; `content` is set only when `problem` is `null`. */
export interface FontEntry {
  /** File name as in the directory, e.g. `haus-serif.woff2`. */
  name: string
  /** Git blob sha (the ETag). */
  sha: string
  /** Bytes; `null` when the file was not read (bad name, unreadable). */
  size: number | null
  problem: FontProblem | null
  content: Buffer | null
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export const STYLESHEET_CACHE_TTL_MS = 5 * 60 * 1000

export const INSTANCE_STYLESHEET_KEY = 'instance'

export function spaceStylesheetKey(spaceId: string): string {
  return `space:${spaceId}`
}

export const stylesheetCache = new Map<string, CacheEntry<StylesheetState>>()
export const fontCache = new Map<string, CacheEntry<FontEntry[]>>()

/** Drops the cached stylesheet and fonts of one scope (`instance` or `space:<id>`); without a key, all. */
export function invalidateStylesheet(scopeKey?: string): void {
  if (scopeKey === undefined) {
    stylesheetCache.clear()
    fontCache.clear()
    return
  }
  stylesheetCache.delete(scopeKey)
  fontCache.delete(scopeKey)
}
