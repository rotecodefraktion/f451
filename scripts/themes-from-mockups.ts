/**
 * Builds the built-in theme templates from the 2026 mockups and the demo theme
 * (theming addendum 2026-10-02 §3, "Mitgelieferte Vorlagen").
 *
 *   pnpm --filter @f451/design-tokens themes:from-mockups
 *
 * For every source it reads the custom properties declared on the root
 * element — `:root` / `html` blocks for light, `[data-theme="dark"]` blocks and
 * `@media (prefers-color-scheme: dark)` for dark — keeps the names the catalog
 * knows and lets a theme set, checks every value against its grammar and
 * writes two files with the same content:
 *
 * - `packages/design-tokens/themes/<slug>.yaml` — the template as a theme file,
 *   readable and diffable;
 * - `packages/design-tokens/src/builtin-themes.data.ts` — the same data as a TS
 *   constant, because the package has no YAML parser (the API has one).
 *
 * What does not survive is printed: unknown names (the mockups use their own
 * schema in places), locked tokens, and values that still fail the grammar
 * after the rewrites below. Whatever makes the mockups differ in LAYOUT is
 * lost on purpose — layout is fixed.
 *
 * Before a value is checked, it is rewritten into what the mockup meant,
 * in this order:
 * 1. A value that is exactly `var(--x)` is resolved against the root
 *    declarations (Werkbank keeps its raw values in `--l-*` / `--d-*` and only
 *    aliases them).
 * 2. Simple `calc()`: a product of two operands, of which at most one carries
 *    a unit (`calc(var(--unit) * 4)`, `calc(0.75rem * var(--text-scale))`),
 *    or a sum of two operands in the same unit. An operand is a plain number
 *    or a `var()` that resolves to one within three steps. Anything else stays
 *    as it is and fails the grammar.
 * 3. `rgb()` / `rgba()` become `#rrggbb` / `#rrggbbaa`, also inside shadows.
 * 4. When the range allows exactly one unit, px and rem are converted into it
 *    at 16 px per rem (radii, `focus-offset`, `control-h`).
 * A `radius-pill` above its maximum is clamped to it — "fully round" is what
 * 999px means. Other out-of-range values stay dropped.
 *
 * Dark starts from the light root values: the light blocks select `:root`,
 * which also matches in dark mode, so a theme value the dark block does not
 * override is the one a reader sees in dark (System / Raster: `shadow-sm: none`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  catalog,
  checkValue,
  tokenNames,
  type ThemeFile,
  type TokenMeta,
  type TokenName,
  type TokenRange,
  type ValueCheck,
} from '../packages/design-tokens/src/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG = `${ROOT}packages/design-tokens/`

interface Source {
  slug: string
  name: string
  path: string // relative to the repo root
}

const SOURCES: readonly Source[] = [
  { slug: 'fokus', name: 'Fokus', path: 'docs/design/mockups-2026/fokus.html' },
  { slug: 'klar-warm', name: 'Klar & Warm', path: 'docs/design/mockups-2026/klar-warm.html' },
  { slug: 'system-raster', name: 'System / Raster', path: 'docs/design/mockups-2026/system-raster.html' },
  { slug: 'werkbank', name: 'Werkbank', path: 'docs/design/mockups-2026/werkbank.html' },
  { slug: 'rotecodefraktion', name: 'Rotecodefraktion', path: 'deploy/demo/theme/theme.css' },
]

/**
 * Building-block switches per template (structure spec 1, 2026-10-04). The
 * script reads VALUES from a mockup, not construction — these come from the
 * comparison of the mockups against Editorial and are written into `base`
 * explicitly, the default values included, so a copy of a template shows every
 * switch. Rotecodefraktion is the construction the application had before
 * 1.2.5 (framed table, no card rule, bar TOC, no tree guides, plain rail,
 * disc markers) and the frame of 1.2.5 (top bar, toolbar page head, edge
 * controls, rail scrolling on its own, no status bar) with the demo theme's
 * colours and typefaces. The five frame switches (structure spec 2) differ
 * between templates, so none of them is in SHARED.
 */
const SHARED = { 'table-style': 'framed', 'card-top-rule': 'off', 'heading-depth': 'top', 'toc-style': 'bar', 'tree-guides': 'off' }
const SWITCHES: Record<string, Record<string, string>> = {
  fokus:            { ...SHARED, 'callout-style': 'box', 'button-primary': 'accent', 'chip-style': 'filled',       'heading-number': 'none',    'code-header': 'on',  'rail-blocks': 'plain', 'list-marker': 'disc',
                      topbar: 'off', 'page-head': 'title',   'pane-controls': 'edges',  'rail-scroll': 'sticky', 'status-bar': 'off' },
  'klar-warm':      { ...SHARED, 'callout-style': 'box', 'button-primary': 'accent', 'chip-style': 'filled',       'heading-number': 'none',    'code-header': 'on',  'rail-blocks': 'cards', 'list-marker': 'disc',
                      topbar: 'on',  'page-head': 'title',   'pane-controls': 'topbar', 'rail-scroll': 'sticky', 'status-bar': 'off' },
  'system-raster':  { ...SHARED, 'callout-style': 'bar', 'button-primary': 'accent', 'chip-style': 'marker',       'heading-number': 'none',    'code-header': 'on',  'rail-blocks': 'plain', 'list-marker': 'dash',
                      topbar: 'off', 'page-head': 'title',   'pane-controls': 'edges',  'rail-scroll': 'sticky', 'status-bar': 'off' },
  werkbank:         { ...SHARED, 'callout-style': 'box', 'button-primary': 'accent', 'chip-style': 'outline-caps', 'heading-number': 'none',    'code-header': 'on',  'rail-blocks': 'cards', 'list-marker': 'dash',
                      topbar: 'on',  'page-head': 'toolbar', 'pane-controls': 'topbar', 'rail-scroll': 'own',    'status-bar': 'bottom' },
  rotecodefraktion: { ...SHARED, 'callout-style': 'bar', 'button-primary': 'ink',    'chip-style': 'outline-caps', 'heading-number': 'numeral', 'code-header': 'off', 'rail-blocks': 'plain', 'list-marker': 'disc',
                      topbar: 'on',  'page-head': 'toolbar', 'pane-controls': 'edges',  'rail-scroll': 'own',    'status-bar': 'off' },
}

type Mode = 'light' | 'dark'
type Section = 'base' | 'light' | 'dark'

// ---- CSS reading -----------------------------------------------------------

/** The stylesheet text: all `<style>` blocks of an HTML file, or the CSS file itself. */
function stylesheetOf(text: string, path: string): string {
  const css = path.endsWith('.html')
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '').join('\n')
    : text
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Index just past the closing quote of the string starting at `i`. */
function skipString(css: string, i: number): number {
  const quote = css[i]
  let j = i + 1
  while (j < css.length && css[j] !== quote) j += css[j] === '\\' ? 2 : 1
  return j + 1
}

/** Index of the `}` that closes the `{` at `open`. */
function matchBrace(css: string, open: number): number {
  let depth = 0
  let i = open
  while (i < css.length) {
    const c = css[i]
    if (c === '"' || c === "'") {
      i = skipString(css, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
    i++
  }
  return css.length
}

interface Rule {
  prelude: string
  body: string
}

/** The top-level rules of a stylesheet (or of an @media body). */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = []
  let start = 0
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '"' || c === "'") {
      i = skipString(css, i)
      continue
    }
    if (c === '{') {
      const end = matchBrace(css, i)
      rules.push({ prelude: css.slice(start, i).trim(), body: css.slice(i + 1, end) })
      i = end + 1
      start = i
      continue
    }
    // Statements without a block (`@import …;`) and stray braces end a prelude.
    if (c === ';' || c === '}') start = i + 1
    i++
  }
  return rules
}

/** Custom property declarations of one rule body, in order. */
function customProperties(body: string): [string, string][] {
  const out: [string, string][] = []
  for (const decl of body.split(';')) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]*?)\s*$/.exec(decl)
    if (m) out.push([m[1]!, m[2]!])
  }
  return out
}

// `:root`, `html`, `html:root`, `[data-theme]`, `[data-theme="light"]`, `:root[data-theme='light']`.
const ROOT_SELECTOR = /^(?=.)(?:html)?(?::root)?(?:\[data-theme(?:=["']?light["']?)?\])?$/
const DARK_SELECTOR = /data-theme=["']?dark["']?/

/** Which mode a rule feeds, or `null` when it is not a root-level token block. */
function modeOf(selector: string, inDarkMedia: boolean): Mode | null {
  const parts = selector.split(',').map((s) => s.trim())
  if (inDarkMedia) return parts.some((p) => p.startsWith(':root') || p.startsWith('html')) ? 'dark' : null
  if (parts.some((p) => DARK_SELECTOR.test(p))) return 'dark'
  if (parts.some((p) => ROOT_SELECTOR.test(p))) return 'light'
  return null
}

/** Root declarations per mode, later ones winning as in the cascade. */
function collect(css: string, inDarkMedia = false, into = { light: new Map<string, string>(), dark: new Map<string, string>() }) {
  for (const rule of rulesOf(css)) {
    if (rule.prelude.startsWith('@media')) {
      if (/prefers-color-scheme\s*:\s*dark/.test(rule.prelude)) collect(rule.body, true, into)
      continue // other media queries (widths, motion, print) are layout, not theme
    }
    if (rule.prelude.startsWith('@')) continue // @font-face, @keyframes, @supports …
    const mode = modeOf(rule.prelude, inDarkMedia)
    if (!mode) continue
    for (const [name, value] of customProperties(rule.body)) into[mode].set(name, value)
  }
  return into
}

/** Follows a value that is exactly `var(--x)` through `own`, then `fallback`. */
function resolveVar(value: string, own: Map<string, string>, fallback: Map<string, string>, depth = 0): string {
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(value)
  if (!m || depth > 8) return value
  const next = own.get(m[1]!) ?? fallback.get(m[1]!)
  return next === undefined ? value : resolveVar(next, own, fallback, depth + 1)
}

// ---- Value rewrites ----------------------------------------------------------

// A plain number with an optional unit: `0.25rem`, `.45`, `12`, `999px`.
const QUANTITY = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/
const VAR_ONLY = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/

/** Rounded to 4 decimals, trailing zeros stripped: 62.4375, 0.125, 3. */
function fmt(n: number): string {
  return String(Number(n.toFixed(4)))
}

/** A calc operand as number and unit, following up to three `var()` steps. */
function quantity(text: string, lookup: (name: string) => string | undefined): { n: number; unit: string } | null {
  let t = text.trim()
  for (let step = 0; step < 3; step++) {
    const v = VAR_ONLY.exec(t)
    if (!v) break
    const next = lookup(v[1]!)
    if (next === undefined) return null
    t = next.trim()
  }
  const m = QUANTITY.exec(t)
  return m ? { n: Number(m[1]), unit: m[2]! } : null
}

/** `calc(a * b)` with at most one unit, or `calc(a + b)` in one unit; anything else unchanged. */
function simplifyCalc(value: string, lookup: (name: string) => string | undefined): string {
  const m = /^calc\(\s*([^*+]+?)\s*([*+])\s*([^*+]+?)\s*\)$/.exec(value)
  if (!m) return value
  const a = quantity(m[1]!, lookup)
  const b = quantity(m[3]!, lookup)
  if (!a || !b) return value
  if (m[2] === '*') {
    if (a.unit !== '' && b.unit !== '') return value
    return `${fmt(a.n * b.n)}${a.unit || b.unit}`
  }
  return a.unit === b.unit ? `${fmt(a.n + b.n)}${a.unit}` : value
}

const RGB = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)/g

/** Every `rgb(r, g, b)` / `rgba(r, g, b, a)` in the value as `#rrggbb` / `#rrggbbaa`. */
function rgbToHex(value: string): string {
  const hex = (c: number) => c.toString(16).padStart(2, '0')
  return value.replace(RGB, (whole: string, r: string, g: string, b: string, a: string | undefined) => {
    const channels = [r, g, b].map(Number)
    const alpha = a === undefined ? 1 : Number(a)
    if (channels.some((c) => c > 255) || !(alpha >= 0 && alpha <= 1)) return whole
    return `#${channels.map(hex).join('')}${alpha === 1 ? '' : hex(Math.round(alpha * 255))}`
  })
}

/** px ↔ rem at 16 px per rem, when the range allows exactly the other unit. */
function convertUnit(range: TokenRange, value: string): string {
  if (range.kind !== 'length' || range.units.length !== 1) return value
  const m = QUANTITY.exec(value)
  if (!m) return value
  const n = Number(m[1])
  const target = range.units[0]
  if (m[2] === 'px' && target === 'rem') return `${fmt(n / 16)}rem`
  if (m[2] === 'rem' && target === 'px') return `${fmt(n * 16)}px`
  return value
}

/** A `radius-pill` above the range maximum, clamped to it; `null` for anything else. */
function clampPill(name: string, range: TokenRange, value: string): string | null {
  if (name !== '--radius-pill' || range.kind !== 'length') return null
  const m = QUANTITY.exec(value)
  if (!m || !(range.units as readonly string[]).includes(m[2]!) || Number(m[1]) <= range.max) return null
  return `${range.max}${m[2]}`
}

// ---- Catalog filter --------------------------------------------------------

interface Extracted {
  file: ThemeFile
  dropped: string[]
  adjusted: string[]
  unknown: string[]
}

function sectionOf(meta: TokenMeta, mode: Mode): Section | null {
  if (meta.level === 'structure') return mode === 'light' ? 'base' : null // structure is read once, from light
  if (meta.level === 'theme' || meta.level === 'derived') return mode
  return null
}

function extract(source: Source): Extracted {
  const text = readFileSync(`${ROOT}${source.path}`, 'utf8')
  const raw = collect(stylesheetOf(text, source.path))
  const modes: Record<Mode, Map<string, string>> = {
    light: raw.light,
    dark: new Map([...raw.light, ...raw.dark]),
  }

  const kept: Record<Section, Map<string, string>> = { base: new Map(), light: new Map(), dark: new Map() }
  const dropped = new Set<string>()
  const adjusted = new Set<string>()
  const unknown = new Set<string>()

  for (const mode of ['light', 'dark'] as const) {
    const lookup = (n: string) => modes[mode].get(n) ?? raw.light.get(n)
    for (const [name, value] of modes[mode]) {
      if (!Object.prototype.hasOwnProperty.call(catalog, name)) {
        unknown.add(name)
        continue
      }
      const meta = catalog[name as TokenName] as TokenMeta
      if (!meta.settable) {
        dropped.add(`${name}: locked`)
        continue
      }
      const section = sectionOf(meta, mode)
      if (!section || !meta.range) continue
      const key = `${section}.${name.slice(2)}`
      let candidate = resolveVar(value, modes[mode], raw.light)
      candidate = simplifyCalc(candidate, lookup)
      candidate = rgbToHex(candidate)
      candidate = convertUnit(meta.range, candidate)
      let check: ValueCheck = checkValue(meta.range, candidate)
      if (!check.ok) {
        const clamped = clampPill(name, meta.range, candidate)
        if (clamped !== null) {
          adjusted.add(`${key}: ${candidate} clamped to ${clamped}`)
          check = checkValue(meta.range, clamped)
        }
      }
      if (!check.ok) {
        dropped.add(`${key}: ${check.reason}`)
        continue
      }
      kept[section].set(name, check.value)
    }
  }

  // Switches after the extracted values; `kept` is keyed by the full token name.
  const switches = SWITCHES[source.slug] ?? {}
  for (const [key, value] of Object.entries(switches)) {
    const name = `--${key}`
    const meta = catalog[name as TokenName] as TokenMeta | undefined
    if (!meta?.range || !checkValue(meta.range, value).ok) throw new Error(`${source.slug}: switch ${key}=${value} is not a catalog value`)
    kept.base.set(name, value)
  }

  const file: ThemeFile = { name: source.name }
  for (const section of ['base', 'light', 'dark'] as const) {
    // Catalog order, so the files read like the settings page.
    const names = tokenNames.filter((n) => kept[section].has(n))
    if (names.length === 0) continue
    file[section] = Object.fromEntries(names.map((n) => [n.slice(2), kept[section].get(n)!]))
  }
  return { file, dropped: [...dropped], adjusted: [...adjusted], unknown: [...unknown].sort() }
}

// ---- Output ----------------------------------------------------------------

/** Every value quoted: `#…` would start a comment, font stacks carry commas and quotes. */
function yamlScalar(value: string): string {
  return value.includes("'") ? JSON.stringify(value) : `'${value}'`
}

function toYaml(file: ThemeFile, source: Source): string {
  const lines = [
    `# Built-in theme template, generated from ${source.path}`,
    '# by scripts/themes-from-mockups.ts — do not edit by hand.',
    `name: ${yamlScalar(file.name!)}`,
  ]
  for (const section of ['base', 'light', 'dark'] as const) {
    const values = file[section]
    if (!values) continue
    lines.push(`${section}:`)
    for (const [key, value] of Object.entries(values)) lines.push(`  ${key}: ${yamlScalar(value)}`)
  }
  return `${lines.join('\n')}\n`
}

function toDataModule(entries: { slug: string; file: ThemeFile }[]): string {
  return [
    '// Generated by scripts/themes-from-mockups.ts — do not edit by hand.',
    '// Same content as themes/<slug>.yaml; embedded because this package has no YAML parser.',
    "import type { ThemeFile } from './theme-file.js'",
    '',
    `export const builtinThemeData: readonly { slug: string; file: ThemeFile }[] = ${JSON.stringify(entries, null, 2)}`,
    '',
  ].join('\n')
}

const entries: { slug: string; file: ThemeFile }[] = []
mkdirSync(`${PKG}themes`, { recursive: true })
for (const source of SOURCES) {
  const { file, dropped, adjusted, unknown } = extract(source)
  entries.push({ slug: source.slug, file })
  writeFileSync(`${PKG}themes/${source.slug}.yaml`, toYaml(file, source))

  const count = (s: Section) => Object.keys(file[s] ?? {}).length
  console.log(`${source.slug}: base ${count('base')}, light ${count('light')}, dark ${count('dark')}`)
  for (const line of adjusted) console.log(`  adjusted ${line}`)
  for (const line of dropped) console.log(`  dropped ${line}`)
  if (unknown.length > 0) console.log(`  not in the catalog (${unknown.length}): ${unknown.join(' ')}`)
}
writeFileSync(`${PKG}src/builtin-themes.data.ts`, toDataModule(entries))
