import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { NotFoundError } from '@f451/git-provider'
import type { SpaceConfig } from '../spaces/config.js'
import { InvalidSvgError, sanitizeSvg } from '../drafts/svg-sanitize.js'
import {
  BRAND_CACHE_TTL_MS,
  brandCache,
  INSTANCE_BRAND_KEY,
  spaceBrandKey,
  type BrandFile,
} from './brand-cache.js'
import {
  instancePseudoSpace,
  loadInstanceTheme,
  type InstanceThemeDeps,
  type InstanceThemeLogger,
} from './instance-theme.js'
import { loadSpaceTheme } from './space-theme.js'

/**
 * The brand (addendum §5): `brand` in `_meta/theme.yaml` of the instance and of a
 * space. A space inherits `name` and `logo` from the instance and may override
 * both; `favicon` exists on the instance only. Files are SVG only, at most
 * 256 KB, and always pass the SVG sanitizer — also on the read path, because a
 * file can reach the repo without going through the upload route.
 */

export type { BrandFile } from './brand-cache.js'

export type BrandKind = 'logo' | 'favicon'

export type BrandScope = { kind: 'instance' } | { kind: 'space'; space: SpaceConfig }

/** Upper bound of a brand file (addendum §5). */
export const BRAND_MAX_BYTES = 256 * 1024

/** Where the upload route puts a file, relative to `_meta/` (the form of the `brand.*` pointer). */
export const BRAND_FILE_PATHS: Record<BrandKind, string> = {
  logo: 'brand/logo.svg',
  favicon: 'brand/favicon.svg',
}

/** Brand files are read from the published state, like the theme. */
const BRAND_REF = 'main'

export interface ResolvedBrand {
  name: string | null
  /** A logo file exists and passed the checks. */
  logo: boolean
  /** An instance favicon exists and passed the checks. */
  favicon: boolean
  /** Whose logo applies: the space's own, the inherited instance one, or none. */
  logoScope: 'instance' | 'space' | null
}

function cacheKey(scope: BrandScope, kind: BrandKind): string {
  const prefix = scope.kind === 'instance' ? INSTANCE_BRAND_KEY : spaceBrandKey(scope.space.id)
  return `${prefix}:${kind}`
}

async function themeOf(deps: InstanceThemeDeps, scope: BrandScope, log: InstanceThemeLogger) {
  if (scope.kind === 'instance') return loadInstanceTheme(deps, log)
  if (!deps.providerRegistry) return null
  return loadSpaceTheme({ providerRegistry: deps.providerRegistry, now: deps.now }, scope.space, log)
}

/** The repo of a scope as the registry sees it; `null` without config/registry. */
function repoOf(deps: InstanceThemeDeps, scope: BrandScope): SpaceConfig | null {
  if (!deps.providerRegistry) return null
  if (scope.kind === 'space') return scope.space
  return deps.instanceConfig ? instancePseudoSpace(deps.instanceConfig) : null
}

/**
 * The brand file of one scope: `_meta/<brand.logo|favicon>` from `main`, sanitised.
 * `null` (fail-soft) when the theme names none, the file is missing, larger than
 * 256 KB, no SVG or unreadable — each with a warning except "names none". A space
 * never has a favicon. Cached per scope and kind for 5 minutes; the theme
 * invalidations (`invalidateInstanceTheme`, `invalidateSpaceTheme`) empty it.
 */
export async function loadBrandFile(
  deps: InstanceThemeDeps,
  scope: BrandScope,
  kind: BrandKind,
  log: InstanceThemeLogger,
): Promise<BrandFile | null> {
  if (scope.kind === 'space' && kind === 'favicon') return null

  const now = deps.now ?? Date.now
  const key = cacheKey(scope, kind)
  const cached = brandCache.get(key)
  if (cached && cached.expiresAt > now()) return cached.file

  const theme = await themeOf(deps, scope, log)
  const pointer = theme?.file.brand?.[kind]
  const repo = repoOf(deps, scope)
  let file: BrandFile | null = null
  if (pointer && repo && deps.providerRegistry) {
    const path = `_meta/${pointer}`
    const where = { scope: scope.kind === 'space' ? scope.space.id : 'instance', path }
    try {
      const raw = await deps.providerRegistry(repo).readFile(repo.repoRef, path, BRAND_REF)
      if (Buffer.byteLength(raw.content, 'utf8') > BRAND_MAX_BYTES) {
        log.warn(where, `brand: ${kind} larger than 256 KB — ignored`)
      } else {
        file = { svg: sanitizeSvg(raw.content), sha: raw.sha }
      }
    } catch (err) {
      if (err instanceof InvalidSvgError) {
        log.warn({ ...where, reason: err.message }, `brand: ${kind} is no usable SVG — ignored`)
      } else if (err instanceof NotFoundError) {
        log.warn(where, `brand: ${kind} named in theme.yaml but missing — ignored`)
      } else {
        log.warn({ ...where, err }, `brand: ${kind} unreadable — ignored (fail-soft)`)
      }
    }
  }

  brandCache.set(key, { file, expiresAt: now() + BRAND_CACHE_TTL_MS })
  return file
}

/**
 * The effective brand for the instance or a space: the space file's `name` and
 * `logo` override the instance's; the favicon comes from the instance only. A
 * logo counts only if its file loads — a space whose own logo is broken shows the
 * instance logo, like `GET /api/spaces/:space/brand/logo`.
 */
export async function resolveBrand(
  deps: InstanceThemeDeps,
  space: SpaceConfig | undefined,
  log: InstanceThemeLogger,
): Promise<ResolvedBrand> {
  const instanceTheme = await loadInstanceTheme(deps, log)
  const spaceTheme = space ? await themeOf(deps, { kind: 'space', space }, log) : null
  const name = spaceTheme?.file.brand?.name ?? instanceTheme?.file.brand?.name ?? null

  let logoScope: ResolvedBrand['logoScope'] = null
  if (space && (await loadBrandFile(deps, { kind: 'space', space }, 'logo', log))) logoScope = 'space'
  else if (await loadBrandFile(deps, { kind: 'instance' }, 'logo', log)) logoScope = 'instance'

  const favicon = (await loadBrandFile(deps, { kind: 'instance' }, 'favicon', log)) !== null
  return { name, logo: logoScope !== null, favicon, logoScope }
}

/** Parse and serialise without the sanitizer — the baseline `sanitized` is measured against. */
function serializeUnsanitized(raw: string): string | null {
  const tree = fromHtml(raw, { fragment: true, space: 'svg' })
  const root = tree.children.find((node) => node.type === 'element' && node.tagName === 'svg')
  return root ? toHtml(root, { space: 'svg' }) : null
}

/**
 * Sanitises an uploaded brand file. Throws `InvalidSvgError` when there is no SVG
 * left (no `<svg>` root, nothing visible). `sanitized` says whether the sanitizer
 * removed or changed anything — compared with the same parse/serialise round trip
 * without it, so mere reformatting (quotes, self-closing tags, the XML prolog)
 * does not count as a change.
 */
export function sanitizeBrandSvg(raw: string): { svg: string; sanitized: boolean } {
  const svg = sanitizeSvg(raw)
  return { svg, sanitized: svg !== serializeUnsanitized(raw) }
}
