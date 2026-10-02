import type { GitProvider } from '@f451/git-provider'
import { parseThemeFile, type ParsedTheme } from '@f451/design-tokens'
import { NotFoundError } from '@f451/git-provider'
import { parse as parseYaml } from 'yaml'
import type { SpaceConfig } from '../spaces/config.js'

/** Path of the theme file in a space repo (next to `_meta/schema.yaml`). */
export const SPACE_THEME_PATH = '_meta/theme.yaml'

/** The space theme is always read from the published state. */
const SPACE_THEME_REF = 'main'

export interface SpaceThemeDeps {
  /** Service-account registry (`spaces/config.ts#createProviderRegistry`). */
  providerRegistry: (space: SpaceConfig) => GitProvider
  /** Injectable clock (default: Date.now) for deterministic TTL tests. */
  now?: () => number
}

/** Minimal logger contract (Fastify's `app.log`/`req.log` satisfy it). */
export interface SpaceThemeLogger {
  warn: (obj: unknown, msg: string) => void
  debug?: (obj: unknown, msg: string) => void
}

interface CacheEntry {
  theme: ParsedTheme | null
  expiresAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000

// Module-global cache keyed by space id (pattern `spaces/metadata-schema.ts`). Only
// `main` is ever read, so the ref is not part of the key.
const cache = new Map<string, CacheEntry>()

/**
 * Reads and parses `_meta/theme.yaml` from a space repo. Fail-soft in every
 * failure case — reading the theme must never break a page:
 *
 *  - file missing → `null` plus a debug log (a space without a theme is normal)
 *  - provider error, broken YAML → `null` plus a warn log
 *  - file present → `parseThemeFile(…, 'space')`; invalid/unknown/locked tokens and
 *    a `brand.favicon` (instance only) are dropped from the layer and logged, the
 *    rest is returned
 *
 * The result (including `null`) is cached per space for 5 minutes;
 * `invalidateSpaceTheme` / `invalidateAllSpaceThemes` force the next call to read again.
 */
export async function loadSpaceTheme(
  deps: SpaceThemeDeps,
  space: SpaceConfig,
  log: SpaceThemeLogger,
): Promise<ParsedTheme | null> {
  const now = deps.now ?? Date.now
  const cached = cache.get(space.id)
  if (cached && cached.expiresAt > now()) return cached.theme

  let theme: ParsedTheme | null = null
  try {
    const provider = deps.providerRegistry(space)
    const file = await provider.readFile(space.repoRef, SPACE_THEME_PATH, SPACE_THEME_REF)
    const parsed = parseThemeFile(parseYaml(file.content), 'space', { allowUse: true, allowFavicon: false })
    if (parsed.errors.length > 0) {
      log.warn(
        { space: space.id, path: SPACE_THEME_PATH, errors: parsed.errors },
        'space theme: invalid entries dropped (fail-soft)',
      )
    }
    theme = parsed
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.debug?.({ space: space.id, path: SPACE_THEME_PATH }, 'space theme: no file — inherits')
    } else {
      log.warn(
        { err, space: space.id, path: SPACE_THEME_PATH },
        'space theme: unreadable — no space theme (fail-soft)',
      )
    }
    theme = null
  }

  cache.set(space.id, { theme, expiresAt: now() + CACHE_TTL_MS })
  return theme
}

/** Drops the cached theme of one space; the next `loadSpaceTheme` for it reads the file again. */
export function invalidateSpaceTheme(spaceId: string): void {
  cache.delete(spaceId)
}

/** Drops every cached space theme (e.g. after a contrast threshold change, Stage 4). */
export function invalidateAllSpaceThemes(): void {
  cache.clear()
}
