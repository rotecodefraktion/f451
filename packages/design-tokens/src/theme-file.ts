/**
 * Parser and validator for theme files (`_meta/theme.yaml`,
 * `_meta/themes/<slug>.yaml`, the user row) — July spec §file format and
 * addendum §3 (library, `use`) and §5 (brand).
 *
 * The API parses YAML to an object first; this module takes `unknown` and
 * turns it into a `ThemeLayer` the resolver can mix. The file side uses
 * token names WITHOUT leading dashes (`color-accent`), the catalog uses them
 * WITH (`--color-accent`); this is the one place that converts.
 *
 * Validation is fail-closed: a token that is unknown, locked, in the wrong
 * section or fails its grammar is listed in `errors` and never reaches
 * `layer`. Readers keep going with what is left (and log the errors); writers
 * refuse the whole file when `errors` is non-empty (422). `warnings` are kept
 * values worth a note — unknown top-level keys, trimmed whitespace.
 *
 * Which section a token belongs to follows its catalog level: `structure`
 * tokens go in `base`, `theme` and `derived` tokens in `light` / `dark`.
 */
import { catalog, type TokenLevel, type TokenMeta, type TokenName } from './catalog.js'
import { checkValue } from './grammar.js'
import type { LayerSource, ThemeLayer } from './theme.js'

export interface ThemeFile {
  name?: string
  use?: string // '<slug>' | 'instance/<slug>'
  base?: Record<string, string>
  light?: Record<string, string>
  dark?: Record<string, string>
  brand?: { name?: string; logo?: string; favicon?: string }
}

/**
 * Error codes: `token_unknown`, `token_locked`, `value_invalid`, `use_invalid`,
 * `template_no_nesting`, `brand_favicon_instance_only`, `brand_path_invalid`.
 * Warning codes: `key_unknown`, `value_trimmed`, `value_migrated`.
 */
export interface ThemeProblem {
  code: string
  token?: string
  path: string
  message: string
}

export interface ParsedTheme {
  /** only valid, settable tokens, names with '--' */
  layer: ThemeLayer
  /** normalised echo — what survived validation, as a file */
  file: ThemeFile
  /** dropped from `layer`; writers reject when non-empty, readers log them */
  errors: ThemeProblem[]
  /** kept, but worth a note (unknown top-level key, trailing whitespace trimmed) */
  warnings: ThemeProblem[]
}

export interface ParseThemeOptions {
  /** `false` while parsing a template: a template must not `use` another one (one level deep). */
  allowUse?: boolean
  /** `favicon` is an instance-only brand field; defaults to `source === 'instance'`. */
  allowFavicon?: boolean
}

type Section = 'base' | 'light' | 'dark'
type Problems = { errors: ThemeProblem[]; warnings: ThemeProblem[] }

const SECTIONS: readonly Section[] = ['base', 'light', 'dark']
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['name', 'use', 'base', 'light', 'dark', 'brand'])
const BRAND_KEYS: ReadonlySet<string> = new Set(['name', 'logo', 'favicon'])

/**
 * Old spellings read as their 1.2.5 form (structure spec 1): `--heading-number`
 * was a CSS value and `--heading-number-sub` a separate token; both are choice
 * switches now. Readers get a `value_migrated` warning and the migrated echo —
 * the write path stores `parsed.file`, so one save rewrites the file.
 * A value the map does not know is left as it is and fails its grammar.
 */
const MIGRATIONS: Record<string, { token: string; values: Record<string, string> }> = {
  'heading-number': { token: 'heading-number', values: { "counter(sec) '.'": 'numeral', 'counter(sec) "."': 'numeral' } },
  'heading-number-sub': { token: 'heading-depth', values: { none: 'top', 'inline-block': 'all' } },
}

// `<slug>` or `instance/<slug>`; slug is [a-z0-9-]{1,40} (addendum §3).
const USE_REF = /^(?:instance\/)?[a-z0-9-]{1,40}$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** YAML scalars arrive as strings or numbers (`weight-text: 600`); anything else is not a value. */
function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function fitsSection(level: TokenLevel, section: Section): boolean {
  return section === 'base' ? level === 'structure' : level === 'theme' || level === 'derived'
}

/** Where a token of this level belongs, for the message of a misplaced one. */
function sectionFor(level: TokenLevel): string {
  return level === 'structure' ? 'base' : 'light or dark'
}

/**
 * One `base` / `light` / `dark` map. Returns the surviving entries keyed by
 * FILE name (no dashes) with normalised values, or `undefined` when nothing
 * survived — an empty section is left out of layer and echo alike.
 */
function parseSection(section: Section, raw: unknown, out: Problems): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    out.errors.push({ code: 'value_invalid', path: section, message: `"${section}" must be a map of token names to values` })
    return undefined
  }
  const values: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    let key = rawKey
    const path = `${section}.${rawKey}`
    if (key.startsWith('-')) {
      out.errors.push({
        code: 'token_unknown',
        token: rawKey,
        path,
        message: `"${rawKey}": write token names without the leading dashes (e.g. "color-accent")`,
      })
      continue
    }
    let migratedValue: string | null = null
    const migration = Object.prototype.hasOwnProperty.call(MIGRATIONS, key) ? MIGRATIONS[key] : undefined
    if (migration) {
      const original = scalar(rawValue)
      const mapped = original === null ? undefined : migration.values[original.trim()]
      if (mapped !== undefined) {
        out.warnings.push({
          code: 'value_migrated',
          token: `--${migration.token}`,
          path,
          message: `"${rawKey}: ${original}" is written as "${migration.token}: ${mapped}" since 1.2.5`,
        })
        key = migration.token
        migratedValue = mapped
      }
    }
    const name = `--${key}`
    if (!Object.prototype.hasOwnProperty.call(catalog, name)) {
      out.errors.push({ code: 'token_unknown', token: name, path, message: `"${rawKey}" is not a known token` })
      continue
    }
    const meta = catalog[name as TokenName] as TokenMeta
    if (!meta.settable) {
      out.errors.push({ code: 'token_locked', token: name, path, message: `"${key}" is locked: ${meta.lockReason}` })
      continue
    }
    if (!fitsSection(meta.level, section)) {
      out.errors.push({
        code: 'value_invalid',
        token: name,
        path,
        message: `"${key}" is a ${meta.level} token and belongs in ${sectionFor(meta.level)}, not ${section}`,
      })
      continue
    }
    const text = migratedValue ?? scalar(rawValue)
    if (text === null) {
      out.errors.push({ code: 'value_invalid', token: name, path, message: `"${key}" must be a string, got ${typeof rawValue}` })
      continue
    }
    if (!meta.range) {
      // Every settable token carries a range (catalog.test.ts); kept as a guard, not a path.
      out.errors.push({ code: 'value_invalid', token: name, path, message: `"${key}" has no value grammar in the catalog` })
      continue
    }
    const check = checkValue(meta.range, text)
    if (!check.ok) {
      out.errors.push({ code: 'value_invalid', token: name, path, message: `"${key}": ${check.reason}` })
      continue
    }
    if (text !== text.trim()) {
      out.warnings.push({ code: 'value_trimmed', token: name, path, message: `"${key}": surrounding whitespace was trimmed` })
    }
    values[key] = check.value
  }
  return Object.keys(values).length > 0 ? values : undefined
}

/** The same map with catalog names — what the resolver expects. */
function withDashes(values: Record<string, string>): Record<string, string> {
  const named: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) named[`--${key}`] = value
  return named
}

function parseName(raw: unknown, path: string, out: Problems): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    out.errors.push({ code: 'value_invalid', path, message: `"${path}" must be a string` })
    return undefined
  }
  const name = raw.trim()
  if (name !== raw) out.warnings.push({ code: 'value_trimmed', path, message: `"${path}": surrounding whitespace was trimmed` })
  return name.length > 0 ? name : undefined
}

function parseUse(raw: unknown, allowUse: boolean, out: Problems): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!allowUse) {
    out.errors.push({
      code: 'template_no_nesting',
      path: 'use',
      message: 'a template must not use another template — templates are one level deep',
    })
    return undefined
  }
  if (typeof raw !== 'string' || !USE_REF.test(raw)) {
    out.errors.push({
      code: 'use_invalid',
      path: 'use',
      message: `"${String(raw)}" is not a template reference — expected <slug> or instance/<slug> with slug [a-z0-9-]{1,40}`,
    })
    return undefined
  }
  return raw
}

/** Relative, under `brand/`, no empty, `.` or `..` segment, no backslash. */
function parseBrandPath(raw: unknown, path: string, out: Problems): string | undefined {
  const text = typeof raw === 'string' ? raw.trim() : null
  const segments = text?.split('/') ?? []
  const valid =
    text !== null
    && !text.includes('\\')
    && segments.length >= 2
    && segments[0] === 'brand'
    && segments.every((s) => s !== '' && s !== '.' && s !== '..')
  if (!valid) {
    out.errors.push({
      code: 'brand_path_invalid',
      path,
      message: `"${String(raw)}" must be a relative path under brand/ without ".." (e.g. brand/logo.svg)`,
    })
    return undefined
  }
  return text
}

function parseBrand(raw: unknown, allowFavicon: boolean, out: Problems): ThemeFile['brand'] {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    out.errors.push({ code: 'value_invalid', path: 'brand', message: '"brand" must be a map with name, logo and favicon' })
    return undefined
  }
  const brand: NonNullable<ThemeFile['brand']> = {}
  for (const key of Object.keys(raw)) {
    if (!BRAND_KEYS.has(key)) {
      out.warnings.push({ code: 'key_unknown', path: `brand.${key}`, message: `"brand.${key}" is not a brand field and is ignored` })
    }
  }
  const name = parseName(raw.name, 'brand.name', out)
  if (name !== undefined) brand.name = name
  if (raw.logo !== undefined && raw.logo !== null) {
    const logo = parseBrandPath(raw.logo, 'brand.logo', out)
    if (logo !== undefined) brand.logo = logo
  }
  if (raw.favicon !== undefined && raw.favicon !== null) {
    if (!allowFavicon) {
      out.errors.push({
        code: 'brand_favicon_instance_only',
        path: 'brand.favicon',
        message: 'a favicon can only be set on the instance theme — the browser caches it per origin',
      })
    } else {
      const favicon = parseBrandPath(raw.favicon, 'brand.favicon', out)
      if (favicon !== undefined) brand.favicon = favicon
    }
  }
  return Object.keys(brand).length > 0 ? brand : undefined
}

export function parseThemeFile(input: unknown, source: LayerSource, opts: ParseThemeOptions = {}): ParsedTheme {
  const allowUse = opts.allowUse ?? true
  const allowFavicon = opts.allowFavicon ?? source === 'instance'
  const out: Problems = { errors: [], warnings: [] }
  const layer: ThemeLayer = { source }
  const file: ThemeFile = {}

  // An empty YAML document parses to null — a valid, empty theme.
  if (input === undefined || input === null) return { layer, file, ...out }
  if (!isRecord(input)) {
    out.errors.push({ code: 'value_invalid', path: '', message: 'a theme file must be a map (name, use, base, light, dark, brand)' })
    return { layer, file, ...out }
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      out.warnings.push({ code: 'key_unknown', path: key, message: `"${key}" is not a theme file key and is ignored` })
    }
  }

  const name = parseName(input.name, 'name', out)
  if (name !== undefined) file.name = name

  const use = parseUse(input.use, allowUse, out)
  if (use !== undefined) file.use = use

  for (const section of SECTIONS) {
    const values = parseSection(section, input[section], out)
    if (!values) continue
    file[section] = values
    if (section === 'base') layer.base = withDashes(values) as ThemeLayer['base']
    else layer[section] = withDashes(values) as ThemeLayer['light']
  }

  const brand = parseBrand(input.brand, allowFavicon, out)
  if (brand !== undefined) file.brand = brand

  return { layer, file, ...out }
}
