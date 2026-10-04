/**
 * Pure helpers behind the two previews of the theme editor (July spec
 * `2026-07-26-themefaehigkeit-design.md`, chapter "Bedienung", section
 * "Vorschau"):
 *
 * - the component preview carries the draft as inline custom properties on
 *   its own root element (`previewStyle`);
 * - "try it in the whole program" stores the draft in
 *   `localStorage['erscheinungsbild']`, which the no-flash script of the root
 *   layout applies before paint (`programOverrides`).
 *
 * Nothing here touches the DOM or the storage; the components do.
 */
import {
  attributeValues,
  catalog,
  toCssDeclarations,
  type Mode,
  type ResolvedTheme,
  type TokenName,
} from '@f451/design-tokens'
import type { Ueberschreibungen } from './erscheinungsbild.js'
import type { DataAttributes } from './theme-style.js'

/** Same shape as `lib/erscheinungsbild.ts` reads and writes: names with dashes per mode, plus the switches. */
export type PreviewOverrides = Ueberschreibungen

/** The localStorage key the no-flash script of `app/layout.tsx` reads (`NO_FLASH_TOKENS`). */
export const PREVIEW_STORAGE_KEY = 'erscheinungsbild'

/** Fired on `window` whenever the program preview starts or ends, so banner and button agree. */
export const PREVIEW_EVENT = 'f451:theme-preview'

/**
 * The panel/page flip of `app/styles/10-ableitungen.css`: in dark mode
 * `--color-bg` is set to `var(--color-bg-raised)` on `:root[data-theme='dark']`
 * (specificity 0-2-0), which beats the saved theme's `[data-theme="dark"]`
 * block. An inline `--color-bg` would beat the flip instead, so a preview that
 * carried it would show something the saved theme never shows. Left out in dark
 * mode; the flip supplies it.
 */
const FLIPPED_IN_DARK = '--color-bg'

/** `--name: value;` strings (as `toCssDeclarations` yields them) -> name/value map. */
export function declarationsToMap(declarations: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const d of declarations) {
    const colon = d.indexOf(':')
    if (colon < 0) continue
    const name = d.slice(0, colon).trim()
    const value = d.slice(colon + 1).trim().replace(/;$/, '').trim()
    if (!name.startsWith('--') || value === '') continue
    map[name] = value
  }
  return map
}

function withoutFlip(mode: Mode, map: Record<string, string>): Record<string, string> {
  if (mode !== 'dark') return map
  return Object.fromEntries(Object.entries(map).filter(([name]) => name !== FLIPPED_IN_DARK))
}

/**
 * What the program preview writes to localStorage: only what differs from the
 * built-in tokens (`tokens.css` already carries the defaults). The no-flash
 * script applies one mode's map only, so the structure tokens (`root`, the
 * same in both modes) go into each mode's map.
 */
export function programOverrides(resolved: ResolvedTheme): PreviewOverrides {
  const css = toCssDeclarations(resolved)
  const root = declarationsToMap(css.root)
  return {
    light: withoutFlip('light', { ...root, ...declarationsToMap(css.light) }),
    dark: withoutFlip('dark', { ...root, ...declarationsToMap(css.dark) }),
    // the FULL set: the no-flash script and applyStoredPreview set every switch, so
    // a deviation the server rendered cannot show through (Review Focus 3)
    attributes: attributeValues(resolved),
  }
}

/** `data-<name>` for every switch — the component preview's stage root, so the nearest carrier is the stage. */
export function previewAttributes(resolved: ResolvedTheme): DataAttributes {
  const out: DataAttributes = {}
  for (const [name, value] of Object.entries(attributeValues(resolved))) out[`data-${name}`] = value
  return out
}

/**
 * Inline custom properties for the component preview in one mode.
 *
 * Unlike the program preview this carries EVERY theme value of the mode, not
 * only the changed ones: the preview may show dark while the document is light
 * (or the other way round), and a token left out would be inherited from the
 * document — from the other mode. Derived colours are recomputed on the
 * preview root by the `[data-theme=…]` block of `tokens.css` (the root carries
 * `data-theme`); only those a layer set explicitly are listed here.
 *
 * Structure tokens stay at "changed only": they are the same in both modes,
 * and the font roles are rewired to the self-hosted faces on `:root`
 * (`10-ableitungen.css`) — writing their default stacks here would undo that.
 */
export function previewStyle(resolved: ResolvedTheme, mode: Mode): Record<string, string> {
  const style = declarationsToMap(toCssDeclarations(resolved).root)
  const values = resolved[mode] as Partial<Record<TokenName, string>>
  for (const name of Object.keys(values) as TokenName[]) {
    const value = values[name]
    if (value === undefined || catalog[name].emit !== 'css') continue
    style[name] = value
  }
  return withoutFlip(mode, style)
}

/** Every property name the overrides may have put on `<html>`, both modes. */
export function overrideNames(overrides: PreviewOverrides): string[] {
  return [...new Set([...Object.keys(overrides.light), ...Object.keys(overrides.dark)])]
}

/** The mode in effect — the same rule as the no-flash script and `tokens.css`. */
export function currentMode(dataTheme: string | null, prefersDark: boolean): Mode {
  if (dataTheme === 'light' || dataTheme === 'dark') return dataTheme
  return prefersDark ? 'dark' : 'light'
}
