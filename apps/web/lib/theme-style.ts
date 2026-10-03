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
