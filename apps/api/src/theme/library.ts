import type { GitProvider, RepoRef } from '@f451/git-provider'
import {
  builtinTemplates,
  parseThemeFile,
  type LayerSource,
  type ParsedTheme,
  type ThemeFile,
  type ThemeLayer,
} from '@f451/design-tokens'
import { NotFoundError } from '@f451/git-provider'
import { parse as parseYaml } from 'yaml'
import type { SpaceConfig } from '../spaces/config.js'
import { instancePseudoSpace, type InstanceThemeDeps, type InstanceThemeLogger } from './instance-theme.js'
import {
  INSTANCE_LIBRARY_KEY,
  LIBRARY_CACHE_TTL_MS,
  libraryCache,
  spaceLibraryKey,
} from './library-cache.js'

export { invalidateLibrary, INSTANCE_LIBRARY_KEY, spaceLibraryKey } from './library-cache.js'

/**
 * Theme library (theming addendum §3): named templates a theme can pick with `use`.
 *
 *  - built-ins from `@f451/design-tokens` (origin `builtin`, neither writable nor deletable),
 *  - `_meta/themes/<slug>.yaml` in the instance repo (origin `instance`) — together with
 *    the built-ins this is the "instance library"; an instance file overrides a built-in
 *    of the same slug,
 *  - `_meta/themes/<slug>.yaml` in a space repo (origin `space`) — that space's own library.
 *
 * `use: <slug>` names the own library of the layer, `use: instance/<slug>` the instance
 * library (from a space or the user theme). The two are separate namespaces, so a space
 * listing carries a space template and an instance template of the same slug side by
 * side: `fokus` and `instance/fokus` are different references.
 *
 * Reading is fail-soft like the theme loaders: an unreadable repo contributes nothing,
 * a template with errors (or with a `use` of its own — one level deep) is skipped with
 * a warning. Each repo's templates are cached for 5 minutes (`library-cache.ts`).
 */

export type LibraryOrigin = 'builtin' | 'instance' | 'space'

export interface LibraryEntry {
  slug: string
  name: string
  origin: LibraryOrigin
  file: ThemeFile
}

export type LibraryScope = { kind: 'instance' } | { kind: 'space'; space: SpaceConfig }

export const LIBRARY_DIR = '_meta/themes'

/** Slug grammar (addendum §3). */
export const TEMPLATE_SLUG = /^[a-z0-9-]{1,40}$/

const TEMPLATE_FILE = /^_meta\/themes\/([a-z0-9-]{1,40})\.yaml$/

const INSTANCE_PREFIX = 'instance/'

/** Templates are read from the published state, like the themes. */
const LIBRARY_REF = 'main'

export function templatePath(slug: string): string {
  return `${LIBRARY_DIR}/${slug}.yaml`
}

/** Templates are parsed as a theme of their repo's level, never with `use`. */
export function parseTemplate(input: unknown, origin: LibraryOrigin): ParsedTheme {
  return parseThemeFile(input, origin === 'space' ? 'space' : 'instance', { allowUse: false })
}

async function readRepoTemplates(
  provider: GitProvider,
  repo: RepoRef,
  origin: 'instance' | 'space',
  log: InstanceThemeLogger,
): Promise<LibraryEntry[]> {
  let slugs: string[]
  try {
    // No directory listing in the provider contract; the recursive tree is filtered
    // instead (one request, cached with the result).
    const tree = await provider.listTree(repo, LIBRARY_REF)
    slugs = tree
      .filter((e) => e.type === 'file')
      .map((e) => TEMPLATE_FILE.exec(e.path)?.[1])
      .filter((s): s is string => s !== undefined)
      .sort()
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.debug?.({ repo, origin }, 'theme library: repo or branch not found — no templates')
    } else {
      log.warn({ err, repo, origin }, 'theme library: listing failed — no templates from this repo (fail-soft)')
    }
    return []
  }

  const entries = await Promise.all(
    slugs.map(async (slug): Promise<LibraryEntry | null> => {
      const path = templatePath(slug)
      try {
        const file = await provider.readFile(repo, path, LIBRARY_REF)
        const parsed = parseTemplate(parseYaml(file.content), origin)
        if (parsed.errors.length > 0) {
          log.warn({ repo, path, errors: parsed.errors }, 'theme library: invalid template skipped')
          return null
        }
        return { slug, name: parsed.file.name ?? slug, origin, file: parsed.file }
      } catch (err) {
        log.warn({ err, repo, path }, 'theme library: unreadable template skipped (fail-soft)')
        return null
      }
    }),
  )
  return entries.filter((e): e is LibraryEntry => e !== null)
}

async function cachedRepoTemplates(
  deps: InstanceThemeDeps,
  key: string,
  read: () => Promise<LibraryEntry[]>,
): Promise<LibraryEntry[]> {
  const now = deps.now ?? Date.now
  const hit = libraryCache.get(key)
  if (hit && hit.expiresAt > now()) return hit.entries
  const entries = await read()
  libraryCache.set(key, { entries, expiresAt: now() + LIBRARY_CACHE_TTL_MS })
  return entries
}

/**
 * The library of a scope: built-ins first, then the instance repo's templates (same
 * slug replaces the built-in in place), then — for a space scope — the space repo's
 * templates. Without a provider registry or instance config the respective repo
 * contributes nothing.
 */
export async function loadLibrary(
  deps: InstanceThemeDeps,
  scope: LibraryScope,
  log: InstanceThemeLogger,
): Promise<LibraryEntry[]> {
  const instanceLibrary = new Map<string, LibraryEntry>()
  for (const t of builtinTemplates()) {
    instanceLibrary.set(t.slug, { slug: t.slug, name: t.name, origin: 'builtin', file: t.file })
  }

  const { instanceConfig: cfg, providerRegistry: registry } = deps
  if (cfg && registry) {
    const fromRepo = await cachedRepoTemplates(deps, INSTANCE_LIBRARY_KEY, () =>
      readRepoTemplates(registry(instancePseudoSpace(cfg)), cfg.repoRef, 'instance', log),
    )
    for (const entry of fromRepo) instanceLibrary.set(entry.slug, entry)
  }

  const library = [...instanceLibrary.values()]
  if (scope.kind === 'space' && registry) {
    const { space } = scope
    const fromSpace = await cachedRepoTemplates(deps, spaceLibraryKey(space.id), () =>
      readRepoTemplates(registry(space), space.repoRef, 'space', log),
    )
    library.push(...fromSpace)
  }
  return library
}

/**
 * The template a `use` reference names, seen from a layer of `source`:
 * `instance/<slug>` → instance library (built-in or instance repo);
 * `<slug>` → the layer's own library (instance layer: instance library, space layer:
 * space templates; a user layer has no own library).
 */
export function findTemplate(
  use: string,
  source: LayerSource,
  library: readonly LibraryEntry[],
): LibraryEntry | undefined {
  const instanceRef = use.startsWith(INSTANCE_PREFIX)
  const slug = instanceRef ? use.slice(INSTANCE_PREFIX.length) : use
  const namespace = instanceRef || source === 'instance' ? 'instance' : source === 'space' ? 'space' : null
  if (namespace === null) return undefined
  return library.find(
    (e) => e.slug === slug && (namespace === 'space' ? e.origin === 'space' : e.origin !== 'space'),
  )
}

/** A template as a layer below the one that uses it: same source, origin mark `template: <slug>`. */
export function templateLayer(entry: LibraryEntry, source: LayerSource): ThemeLayer {
  const { layer } = parseThemeFile(entry.file, source, { allowUse: false, allowFavicon: true })
  return { ...layer, template: entry.slug }
}

/**
 * `use` resolved before mixing: a layer with a known template becomes
 * `[template, own]`; an unknown one logs a warning and the layer applies without it
 * (addendum §3/§8 — a deleted template is not an error on read).
 */
export function expandLayer(
  parsed: ParsedTheme,
  library: readonly LibraryEntry[],
  log: InstanceThemeLogger,
): ThemeLayer[] {
  const use = parsed.file.use
  if (!use) return [parsed.layer]
  const entry = findTemplate(use, parsed.layer.source, library)
  if (!entry) {
    log.warn({ use, source: parsed.layer.source }, 'theme: template not found — layer applies without it')
    return [parsed.layer]
  }
  return [templateLayer(entry, parsed.layer.source), parsed.layer]
}

/**
 * The layers of one parsed theme, `use` expanded with the library of `scope` — which
 * is only loaded when the theme names a template. `null` → no layers.
 */
export async function layersOf(
  deps: InstanceThemeDeps,
  parsed: ParsedTheme | null,
  scope: LibraryScope,
  log: InstanceThemeLogger,
): Promise<ThemeLayer[]> {
  if (!parsed) return []
  if (!parsed.file.use) return [parsed.layer]
  return expandLayer(parsed, await loadLibrary(deps, scope, log), log)
}
