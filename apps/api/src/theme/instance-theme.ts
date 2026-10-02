import type { GitProvider } from '@f451/git-provider'
import { parseThemeFile, type ParsedTheme } from '@f451/design-tokens'
import { NotFoundError } from '@f451/git-provider'
import { parse as parseYaml } from 'yaml'
import type { InstanceConfig, SpaceConfig } from '../spaces/config.js'

/** Path of the theme file in the instance repo (same place as `_meta/schema.yaml` in a space repo). */
export const INSTANCE_THEME_PATH = '_meta/theme.yaml'

/** The instance theme is always read from the published state. */
const INSTANCE_THEME_REF = 'main'

export interface InstanceThemeDeps {
  /** Service-account registry (`spaces/config.ts#createProviderRegistry`). Optional because
   *  `buildApp` has none without `F451_SPACES`; then there is no instance theme either. */
  providerRegistry?: (space: SpaceConfig) => GitProvider
  /** `F451_INSTANCE_CONFIG` (`spaces/config.ts#loadInstanceConfig`); unset → no instance theme. */
  instanceConfig?: InstanceConfig
  /** Injectable clock (default: Date.now) for deterministic TTL tests. */
  now?: () => number
}

/** Minimal logger contract (Fastify's `app.log`/`req.log` satisfy it). */
export interface InstanceThemeLogger {
  warn: (obj: unknown, msg: string) => void
  debug?: (obj: unknown, msg: string) => void
}

interface CacheEntry {
  theme: ParsedTheme | null
  expiresAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000

// Module-global cache (pattern `spaces/metadata-schema.ts`): there is exactly one
// instance repo, so a single entry suffices — no key needed.
let cache: CacheEntry | undefined

/** The registry is keyed by space; the instance repo gets a pseudo space
 *  (pattern `templates/registry.ts#globalPseudoSpace`). */
function instancePseudoSpace(cfg: InstanceConfig): SpaceConfig {
  return {
    id: '__instance__',
    name: 'Instance',
    provider: cfg.provider,
    owner: cfg.owner,
    repo: cfg.repo,
    defaultLang: 'de',
    repoRef: cfg.repoRef,
  }
}

/**
 * Reads and parses `_meta/theme.yaml` from the instance repo. Fail-soft in every
 * failure case — reading the theme must never break a page:
 *
 *  - no `instanceConfig` → `null`, the provider is not touched (not cached)
 *  - file missing, provider error, broken YAML → `null` plus a warn log
 *  - file present → `parseThemeFile(…, 'instance')`; invalid/unknown/locked tokens
 *    are dropped from the layer and logged, the rest is returned
 *
 * The result (including `null`) is cached for 5 minutes; `invalidateInstanceTheme`
 * forces the next call to read again.
 */
export async function loadInstanceTheme(
  deps: InstanceThemeDeps,
  log: InstanceThemeLogger,
): Promise<ParsedTheme | null> {
  const cfg = deps.instanceConfig
  if (!cfg) return null

  const now = deps.now ?? Date.now
  if (cache && cache.expiresAt > now()) return cache.theme

  let theme: ParsedTheme | null = null
  try {
    if (!deps.providerRegistry) {
      throw new Error('no provider registry configured (F451_SPACES unset)')
    }
    const provider = deps.providerRegistry(instancePseudoSpace(cfg))
    const file = await provider.readFile(cfg.repoRef, INSTANCE_THEME_PATH, INSTANCE_THEME_REF)
    const parsed = parseThemeFile(parseYaml(file.content), 'instance', { allowUse: true, allowFavicon: true })
    if (parsed.errors.length > 0) {
      log.warn(
        { repo: cfg.repoRef, path: INSTANCE_THEME_PATH, errors: parsed.errors },
        'instance theme: invalid entries dropped (fail-soft)',
      )
    }
    theme = parsed
  } catch (err) {
    // A repo without a theme file is a normal setup — no noise for that;
    // everything else (broken YAML, provider down) is worth a warning.
    if (err instanceof NotFoundError) {
      log.debug?.({ repo: cfg.repoRef, path: INSTANCE_THEME_PATH }, 'instance theme: no file — default theme')
    } else {
      log.warn(
        { err, repo: cfg.repoRef, path: INSTANCE_THEME_PATH },
        'instance theme: unreadable — no instance theme (fail-soft)',
      )
    }
    theme = null
  }

  cache = { theme, expiresAt: now() + CACHE_TTL_MS }
  return theme
}

/** Drops the cached instance theme; the next `loadInstanceTheme` reads the file again. */
export function invalidateInstanceTheme(): void {
  cache = undefined
}
