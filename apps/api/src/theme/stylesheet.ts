import { checkStylesheet } from '@f451/design-tokens'
import { NotFoundError } from '@f451/git-provider'
import type { SpaceConfig } from '../spaces/config.js'
import {
  fontCache,
  INSTANCE_STYLESHEET_KEY,
  spaceStylesheetKey,
  STYLESHEET_CACHE_TTL_MS,
  stylesheetCache,
  type FontEntry,
  type StylesheetState,
} from './stylesheet-cache.js'
import { instancePseudoSpace, type InstanceThemeDeps, type InstanceThemeLogger } from './instance-theme.js'

/**
 * The theme stylesheet (f451#61): `_meta/theme.css` and the WOFF2 fonts under
 * `_meta/fonts/` of the instance repo and of a space repo. No pointer in
 * `theme.yaml` — a file that is there applies. Both are checked on the read path
 * too, because a file can reach the repo without going through the upload route:
 * a rejected file is ignored with a warning, never served.
 */

export type { FontEntry, FontProblem, StylesheetState } from './stylesheet-cache.js'

export type StylesheetScope = { kind: 'instance' } | { kind: 'space'; space: SpaceConfig }

export const STYLESHEET_PATH = '_meta/theme.css'
export const FONTS_DIR = '_meta/fonts/'

/** Upper bound of `_meta/theme.css`. */
export const STYLESHEET_MAX_BYTES = 256 * 1024
/** Upper bound of one font file. */
export const FONT_MAX_BYTES = 1024 * 1024
/** Upper bound of all valid fonts of one repo together. */
export const FONTS_TOTAL_MAX_BYTES = 4 * 1024 * 1024

/** Font file names: `[a-z0-9-]{1,40}.woff2`. */
export const FONT_NAME = /^[a-z0-9-]{1,40}\.woff2$/

const WOFF2_MAGIC = Buffer.from('wOF2', 'latin1')

/** Stylesheet and fonts are read from the published state, like the theme. */
const STYLESHEET_REF = 'main'

function scopeKey(scope: StylesheetScope): string {
  return scope.kind === 'instance' ? INSTANCE_STYLESHEET_KEY : spaceStylesheetKey(scope.space.id)
}

/** The repo of a scope as the registry sees it; `null` without config/registry. */
function repoOf(deps: InstanceThemeDeps, scope: StylesheetScope): SpaceConfig | null {
  if (!deps.providerRegistry) return null
  if (scope.kind === 'space') return scope.space
  return deps.instanceConfig ? instancePseudoSpace(deps.instanceConfig) : null
}

const where = (scope: StylesheetScope, path: string) => ({
  scope: scope.kind === 'space' ? scope.space.id : 'instance',
  path,
})

/**
 * `_meta/theme.css` of one scope with the outcome of the checks. Fail-soft: a file
 * over 256 KB, one that violates a rule or one that cannot be read is reported in
 * the state (and logged), not thrown. Cached per scope for 5 minutes; the theme
 * invalidations (`invalidateInstanceTheme`, `invalidateSpaceTheme`) empty it.
 */
export async function loadStylesheetState(
  deps: InstanceThemeDeps,
  scope: StylesheetScope,
  log: InstanceThemeLogger,
): Promise<StylesheetState> {
  const now = deps.now ?? Date.now
  const key = scopeKey(scope)
  const cached = stylesheetCache.get(key)
  if (cached && cached.expiresAt > now()) return cached.value

  const repo = repoOf(deps, scope)
  let state: StylesheetState = { status: 'missing' }
  if (repo && deps.providerRegistry) {
    const at = where(scope, STYLESHEET_PATH)
    try {
      const raw = await deps.providerRegistry(repo).readFile(repo.repoRef, STYLESHEET_PATH, STYLESHEET_REF)
      const bytes = Buffer.byteLength(raw.content, 'utf8')
      if (bytes > STYLESHEET_MAX_BYTES) {
        log.warn({ ...at, bytes }, 'stylesheet: larger than 256 KB — ignored')
        state = { status: 'too_large', sha: raw.sha, bytes }
      } else {
        const check = checkStylesheet(raw.content)
        if (check.ok) {
          state = { status: 'ok', css: raw.content, sha: raw.sha, bytes }
        } else {
          log.warn(
            { ...at, problems: check.problems.map((p) => ({ code: p.code, line: p.line })) },
            'stylesheet: violates the stylesheet rules — ignored',
          )
          state = { status: 'invalid', sha: raw.sha, bytes, problems: check.problems }
        }
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        log.debug?.(at, 'stylesheet: no file')
      } else {
        log.warn({ ...at, err }, 'stylesheet: unreadable — ignored (fail-soft)')
        state = { status: 'unreadable' }
      }
    }
  }

  stylesheetCache.set(key, { value: state, expiresAt: now() + STYLESHEET_CACHE_TTL_MS })
  return state
}

/** The servable stylesheet of one scope (`ok` only), else `null`. */
export async function loadStylesheet(
  deps: InstanceThemeDeps,
  scope: StylesheetScope,
  log: InstanceThemeLogger,
): Promise<{ css: string; sha: string } | null> {
  const state = await loadStylesheetState(deps, scope, log)
  return state.status === 'ok' ? { css: state.css, sha: state.sha } : null
}

/**
 * Every file under `_meta/fonts/` of one scope, each with its verdict: name grammar,
 * ≤ 1 MB, content starts with `wOF2`, and the valid ones together ≤ 4 MB (counted
 * in name order — a font that would cross the cap is rejected, the ones before it
 * stay). The listing has no sizes, so the fonts are read here; the set (with the
 * bytes of the valid fonts) is cached per scope for 5 minutes like the stylesheet.
 * Fail-soft: an unreadable listing yields an empty set with a warning.
 */
export async function loadFontSet(
  deps: InstanceThemeDeps,
  scope: StylesheetScope,
  log: InstanceThemeLogger,
): Promise<FontEntry[]> {
  const now = deps.now ?? Date.now
  const key = scopeKey(scope)
  const cached = fontCache.get(key)
  if (cached && cached.expiresAt > now()) return cached.value

  const repo = repoOf(deps, scope)
  const fonts: FontEntry[] = []
  if (repo && deps.providerRegistry) {
    const provider = deps.providerRegistry(repo)
    try {
      const tree = await provider.listTree(repo.repoRef, STYLESHEET_REF)
      const files = tree
        .filter((e) => e.type === 'file' && e.path.startsWith(FONTS_DIR))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      let total = 0
      for (const file of files) {
        const name = file.path.slice(FONTS_DIR.length)
        const at = where(scope, file.path)
        if (!FONT_NAME.test(name)) {
          log.warn(at, 'stylesheet: font name outside [a-z0-9-]{1,40}.woff2 — ignored')
          fonts.push({ name, sha: file.sha, size: null, problem: 'font_name', content: null })
          continue
        }
        let content: Buffer
        let sha: string
        try {
          const raw = await provider.readFileBinary(repo.repoRef, file.path, STYLESHEET_REF)
          content = raw.content
          sha = raw.sha
        } catch (err) {
          log.warn({ ...at, err }, 'stylesheet: font unreadable — ignored (fail-soft)')
          fonts.push({ name, sha: file.sha, size: null, problem: 'font_unreadable', content: null })
          continue
        }
        const size = content.length
        let problem: FontEntry['problem'] = null
        if (size > FONT_MAX_BYTES) problem = 'font_too_large'
        else if (size < WOFF2_MAGIC.length || !content.subarray(0, WOFF2_MAGIC.length).equals(WOFF2_MAGIC)) {
          problem = 'font_not_woff2'
        } else if (total + size > FONTS_TOTAL_MAX_BYTES) problem = 'font_total_exceeded'
        if (problem) {
          log.warn({ ...at, size, problem }, 'stylesheet: font rejected — ignored')
          fonts.push({ name, sha, size, problem, content: null })
        } else {
          total += size
          fonts.push({ name, sha, size, problem: null, content })
        }
      }
    } catch (err) {
      log.warn({ ...where(scope, FONTS_DIR), err }, 'stylesheet: font listing unreadable — no fonts (fail-soft)')
    }
  }

  fontCache.set(key, { value: fonts, expiresAt: now() + STYLESHEET_CACHE_TTL_MS })
  return fonts
}

/** One servable font of a scope by file name (`<name>.woff2`), else `null`. */
export async function loadFont(
  deps: InstanceThemeDeps,
  scope: StylesheetScope,
  name: string,
  log: InstanceThemeLogger,
): Promise<{ content: Buffer; sha: string } | null> {
  if (!FONT_NAME.test(name)) return null
  const entry = (await loadFontSet(deps, scope, log)).find((f) => f.name === name)
  return entry?.content ? { content: entry.content, sha: entry.sha } : null
}
