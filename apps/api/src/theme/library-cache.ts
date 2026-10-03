import type { LibraryEntry } from './library.js'

/**
 * Cache of the theme library (addendum §3), one entry per repo: the instance
 * repo under `instance`, each space repo under `space:<id>`. Built-ins are not
 * cached — they come from the package.
 *
 * Kept apart from `library.ts` so the theme loaders can invalidate it without an
 * import cycle (`library.ts` imports `instance-theme.ts`).
 */

interface CacheEntry {
  entries: LibraryEntry[]
  expiresAt: number
}

export const LIBRARY_CACHE_TTL_MS = 5 * 60 * 1000

export const INSTANCE_LIBRARY_KEY = 'instance'

export function spaceLibraryKey(spaceId: string): string {
  return `space:${spaceId}`
}

export const libraryCache = new Map<string, CacheEntry>()

/** Drops one repo's cached templates; without a key, every cached library. */
export function invalidateLibrary(scopeKey?: string): void {
  if (scopeKey === undefined) libraryCache.clear()
  else libraryCache.delete(scopeKey)
}
