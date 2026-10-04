import {
  catalog,
  namesOfLevel,
  type DerivedTokenName,
  type StructureTokenName,
  type ThemeTokenName,
  type TokenName,
} from './catalog.js'
import { tokens } from './tokens.js'

/**
 * Layer resolver of the theming feature
 * (`docs/superpowers/specs/2026-10-02-theming-erweiterungen-design.md`, §1).
 *
 * The resolver takes a LIST of layers — default ← instance ← space ← user —
 * and mixes them per token and per mode. Array order is the precedence: a
 * later layer wins, a token the later layer leaves out inherits from the one
 * below. There is no loop and no lookup by name: a template (`use`) is turned
 * into its own layer by the caller BEFORE it gets here, which is why a
 * self-referencing or nested template can never cycle in this file.
 *
 * Values are assumed to have passed their grammar (`parseThemeFile`'s job);
 * the resolver never throws. It does drop names the catalog does not know,
 * because the records it returns promise exactly the catalog's names and a
 * stray name must not leak into CSS (validation is fail-closed).
 *
 * Derived colours have no default here: their default is a formula over the
 * theme colours (`tokens.derived`, emitted by `css.ts`). The July spec's
 * Positivliste makes them "settable, but formula-first": a layer MAY set one
 * explicitly, and only then does it appear in the resolved set — the inline
 * style comes after `tokens.css`, so the explicit declaration beats the
 * formula block at equal specificity. Unset ones stay absent, not undefined.
 */

export type Mode = 'light' | 'dark'
export type LayerSource = 'default' | 'instance' | 'space' | 'user'

export interface ThemeLayer {
  source: LayerSource
  /** slug of the template this layer's values come from, if any (see parseThemeFile) */
  template?: string
  base?: Partial<Record<StructureTokenName, string>>
  light?: Partial<Record<ThemeTokenName | DerivedTokenName, string>>
  dark?: Partial<Record<ThemeTokenName | DerivedTokenName, string>>
}

/** Where a resolved value comes from — the origin mark shown next to each token. */
export interface Origin {
  source: LayerSource
  template?: string
}

/** Every theme token, plus the derived ones some layer set explicitly. */
export type ModeValues = Record<ThemeTokenName, string> & Partial<Record<DerivedTokenName, string>>
export type ModeOrigins = Record<ThemeTokenName, Origin> & Partial<Record<DerivedTokenName, Origin>>

export interface ResolvedTheme {
  base: Record<StructureTokenName, string>
  light: ModeValues
  dark: ModeValues
  origin: {
    base: Record<StructureTokenName, Origin>
    light: ModeOrigins
    dark: ModeOrigins
  }
}

const DEFAULT_ORIGIN: Origin = { source: 'default' }
const DERIVED_NAMES: readonly DerivedTokenName[] = namesOfLevel('derived')

/** Without the `template` key when there is no template, so origins compare by value. */
function originOf(layer: ThemeLayer): Origin {
  return layer.template === undefined ? { source: layer.source } : { source: layer.source, template: layer.template }
}

/**
 * One section (`base`, `light` or `dark`) of the chain, defaults first.
 * `extra` names are accepted without a default — they only appear once a
 * layer sets them. Built on plain string records and narrowed by the caller;
 * the set of allowed names is what keeps the promised shape.
 */
function mixSection(
  defaults: Record<string, string>,
  extra: readonly string[],
  layers: readonly ThemeLayer[],
  pick: (layer: ThemeLayer) => Partial<Record<string, string>> | undefined,
): { values: Record<string, string>; origin: Record<string, Origin> } {
  const allowed = new Set([...Object.keys(defaults), ...extra])
  const values: Record<string, string> = { ...defaults }
  const origin: Record<string, Origin> = {}
  for (const name of Object.keys(defaults)) origin[name] = DEFAULT_ORIGIN

  for (const layer of layers) {
    const section = pick(layer)
    if (!section) continue
    const mark = originOf(layer)
    for (const [name, value] of Object.entries(section)) {
      if (value === undefined || !allowed.has(name)) continue
      values[name] = value
      origin[name] = mark
    }
  }
  return { values, origin }
}

export function resolveTheme(layers: readonly ThemeLayer[]): ResolvedTheme {
  const base = mixSection(tokens.structure, [], layers, (l) => l.base)
  const light = mixSection(tokens.light, DERIVED_NAMES, layers, (l) => l.light)
  const dark = mixSection(tokens.dark, DERIVED_NAMES, layers, (l) => l.dark)
  return {
    base: base.values as Record<StructureTokenName, string>,
    light: light.values as ModeValues,
    dark: dark.values as ModeValues,
    origin: {
      base: base.origin as Record<StructureTokenName, Origin>,
      light: light.origin as ModeOrigins,
      dark: dark.origin as ModeOrigins,
    },
  }
}

/**
 * Only what differs from the defaults, as `--name: value;` strings — the
 * "CSS difference" of the July spec. `tokens.css` already carries the
 * defaults; the inline `<style>` of the layout only has to add what a layer
 * changed. Tokens without a root value (`emit: 'component'`) and the
 * generator's diagram tokens (`emit: 'generator'`) stay out of the stylesheet
 * here for the same reason they stay out of `css.ts`.
 */
function declarations(values: Partial<Record<TokenName, string>>, origin: Partial<Record<TokenName, Origin>>): string[] {
  return (Object.keys(values) as TokenName[])
    .filter((n) => origin[n]?.source !== 'default' && catalog[n].emit === 'css')
    .map((n) => `${n}: ${values[n]};`)
}

export function toCssDeclarations(resolved: ResolvedTheme): { root: string[]; light: string[]; dark: string[] } {
  return {
    root: declarations(resolved.base, resolved.origin.base),
    light: declarations(resolved.light, resolved.origin.light),
    dark: declarations(resolved.dark, resolved.origin.dark),
  }
}

/**
 * Building-block switches (structure spec 1, 2026-10-04): tokens with
 * `emit: 'attribute'`. They never become custom properties; the layout puts
 * them on `<html>` as `data-<name>` and the blocks branch on the attribute.
 */
export const ATTRIBUTE_TOKENS: readonly StructureTokenName[] = namesOfLevel('structure').filter(
  (n) => catalog[n].emit === 'attribute',
)

/** `--chip-style` → `chip-style`: the attribute name the DOM gets (`data-chip-style`). */
export function attributeName(token: StructureTokenName): string {
  return token.slice(2)
}

/** Only the switches that differ from Editorial — what the server renders onto `<html>`. */
export function toAttributes(resolved: ResolvedTheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of ATTRIBUTE_TOKENS) {
    if (resolved.origin.base[n]?.source === 'default') continue
    if (resolved.base[n] === tokens.structure[n]) continue
    out[attributeName(n)] = resolved.base[n]
  }
  return out
}

/** Every switch with its value — the previews write the full set so a document deviation cannot leak in. */
export function attributeValues(resolved: ResolvedTheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of ATTRIBUTE_TOKENS) out[attributeName(n)] = resolved.base[n]
  return out
}

// Cross-token rules live next door; re-exported so the resolver stays the one entry point.
export { checkRules, type RuleViolation } from './rules.js'
