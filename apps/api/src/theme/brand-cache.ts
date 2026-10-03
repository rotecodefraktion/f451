/**
 * Cache of the brand files (addendum §5), one entry per scope and kind:
 * `instance:logo`, `instance:favicon`, `space:<id>:logo`. A `null` entry (no
 * pointer, missing or rejected file) is cached as well.
 *
 * Kept apart from `brand.ts` so the theme loaders can empty it without an import
 * cycle (`brand.ts` imports `instance-theme.ts` and `space-theme.ts`) — pattern
 * `library-cache.ts`.
 */

export interface BrandFile {
  /** The sanitised SVG as served. */
  svg: string
  /** Git blob sha of the file in the repo (the ETag). */
  sha: string
}

interface CacheEntry {
  file: BrandFile | null
  expiresAt: number
}

export const BRAND_CACHE_TTL_MS = 5 * 60 * 1000

export const INSTANCE_BRAND_KEY = 'instance'

export function spaceBrandKey(spaceId: string): string {
  return `space:${spaceId}`
}

export const brandCache = new Map<string, CacheEntry>()

/** Drops the cached brand files of one scope (`instance` or `space:<id>`); without a key, all. */
export function invalidateBrand(scopeKey?: string): void {
  if (scopeKey === undefined) {
    brandCache.clear()
    return
  }
  for (const key of [...brandCache.keys()]) {
    if (key.startsWith(`${scopeKey}:`)) brandCache.delete(key)
  }
}
