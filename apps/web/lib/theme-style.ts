/**
 * Turns the resolved theme declarations (`GET /api/theme/resolved` → `css`)
 * into the text of the root layout's `<style id="f451-theme">`.
 *
 * The selectors mirror the built-in token stylesheet
 * (`packages/design-tokens/src/css.ts#buildCss`): light is the default mode, so
 * `light` declarations share the `:root` block with `root`; `dark` applies to an
 * explicit `[data-theme="dark"]` and, without an explicit choice, to
 * `prefers-color-scheme: dark`. Equal specificity, later in the document — so
 * the theme overrides the built-in values. Empty blocks are omitted.
 */

export interface ThemeCssDeclarations {
  root: string[]
  light: string[]
  dark: string[]
}

/**
 * Declarations are validated fail-closed by the API, so `<` cannot occur in
 * them. Dropping any that contains it anyway keeps a broken response from ever
 * closing the inline `<style>` element.
 */
function safe(decls: readonly string[] | undefined): string[] {
  return (decls ?? []).filter((d) => typeof d === 'string' && !d.includes('<'))
}

export function themeStyleText(css: ThemeCssDeclarations | null | undefined): string {
  if (!css) return ''
  const base = [...safe(css.root), ...safe(css.light)].join('')
  const dark = safe(css.dark).join('')
  let out = ''
  if (base) out += `:root{${base}}`
  if (dark) {
    out += `[data-theme="dark"]{${dark}}`
    out += `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}`
  }
  return out
}

const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]{0,40}$/
const ATTRIBUTE_VALUE = /^[a-z0-9-]{1,40}$/
/** Attributes `<html>` already uses for other switches; a theme must not be able to touch them. */
const RESERVED = new Set(['theme', 'nav', 'rail', 'altlasten'])

/**
 * `GET /api/theme/resolved` → `attributes` as props for `<html>`: `data-<name>`
 * per building-block switch that differs from Editorial (structure spec 1).
 * Names and values are validated fail-closed by the API; the grammar here keeps
 * a broken response from ever writing an arbitrary attribute.
 */
export type DataAttributes = Record<`data-${string}`, string>

export function themeAttributes(attributes: Record<string, string> | null | undefined): DataAttributes {
  const out: DataAttributes = {}
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (!ATTRIBUTE_NAME.test(name) || RESERVED.has(name) || typeof value !== 'string' || !ATTRIBUTE_VALUE.test(value)) continue
    out[`data-${name}`] = value
  }
  return out
}

/** Request header the middleware sets for `?ohne-stylesheet` on the appearance page; the root layout reads it. */
export const SKIP_THEME_CSS_HEADER = 'x-f451-skip-theme-css'
/** The page and the query parameter that render it without the theme stylesheets (spec "Wirkung auf die Vorschauen"). */
export const SKIP_THEME_CSS_PATH = '/einstellungen/erscheinungsbild'
export const SKIP_THEME_CSS_PARAM = 'ohne-stylesheet'

const INSTANCE_STYLESHEET = /^\/api\/theme\/stylesheet\?v=[A-Za-z0-9]{1,64}$/
/** The space segment is `encodeURIComponent` output; a segment of dots only is refused (path traversal). */
const SPACE_STYLESHEET = /^\/api\/spaces\/([A-Za-z0-9\-_.!~*'()%]{1,200})\/theme\/stylesheet\?v=[A-Za-z0-9]{1,64}$/

/**
 * `GET /api/theme/resolved` → `stylesheets` as the hrefs of the root layout's
 * theme stylesheet links (f451#61), in the API's order (instance, then space).
 * Only the two stylesheet routes on the own host pass — anything else in a
 * broken response is dropped, never linked. `skip` (`?ohne-stylesheet` on the
 * appearance page) drops all of them.
 */
export function themeStylesheetLinks(list: readonly string[] | null | undefined, opts: { skip?: boolean } = {}): string[] {
  if (opts.skip || !Array.isArray(list)) return []
  return list.filter((href) => {
    if (typeof href !== 'string') return false
    if (INSTANCE_STYLESHEET.test(href)) return true
    const space = SPACE_STYLESHEET.exec(href)
    return space !== null && !/^\.+$/.test(space[1]!)
  })
}
