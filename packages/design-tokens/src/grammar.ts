/**
 * Value grammars for theme files, one small parser per `TokenRange` kind.
 *
 * Validation is fail-closed: a value that does not match its grammar exactly
 * never reaches CSS. The grammars are deliberately narrower than CSS — no
 * `var()`, `calc()`, `url()`, no named or functional colours.
 */
import type { TokenRange } from './catalog.js'

export type ValueCheck =
  | { ok: true; value: string } // normalised (hex lower-case, trimmed)
  | { ok: false; reason: string } // e.g. 'length: 90ch above max 80ch'

type Kind<K extends TokenRange['kind']> = Extract<TokenRange, { kind: K }>

const ok = (value: string): ValueCheck => ({ ok: true, value })
const fail = (reason: string): ValueCheck => ({ ok: false, reason })

// Optional sign, digits, optional fraction: `-0.05`, `12`, `0.5`.
const NUMBER = /^-?\d+(?:\.\d+)?$/
// A number directly followed by a lowercase unit: `1.5rem`, `-0.02em`.
const DIMENSION = /^(-?\d+(?:\.\d+)?)([a-z]+)$/

/** Splits `1.5rem` into number and unit; `null` if it is not a plain dimension. */
function dimension(s: string): { n: number; unit: string } | null {
  const m = DIMENSION.exec(s)
  return m ? { n: Number(m[1]), unit: m[2]! } : null
}

function checkHex(raw: string): ValueCheck {
  // 3, 4, 6 or 8 hex digits (the 4/8 forms carry alpha).
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) {
    return fail(`hex: "${raw}" is not a #rgb, #rgba, #rrggbb or #rrggbbaa colour`)
  }
  return ok(raw.toLowerCase())
}

function checkLength(range: Kind<'length'>, raw: string): ValueCheck {
  // A bare zero is valid CSS and needs no unit.
  if (raw === '0' && range.min <= 0 && range.max >= 0) return ok('0')
  const d = dimension(raw)
  if (!d) return fail(`length: "${raw}" is not a number with a unit`)
  if (!(range.units as readonly string[]).includes(d.unit)) {
    return fail(`length: unit "${d.unit}" not allowed, expected ${range.units.join(', ')}`)
  }
  if (d.n > range.max) return fail(`length: ${raw} above max ${range.max}${d.unit}`)
  if (d.n < range.min) return fail(`length: ${raw} below min ${range.min}${d.unit}`)
  return ok(raw)
}

function checkNumber(range: Kind<'number'>, raw: string): ValueCheck {
  if (!NUMBER.test(raw)) return fail(`number: "${raw}" is not a number`)
  const n = Number(raw)
  if (range.integer && !Number.isInteger(n)) return fail(`number: ${raw} is not an integer`)
  if (n > range.max) return fail(`number: ${raw} above max ${range.max}`)
  if (n < range.min) return fail(`number: ${raw} below min ${range.min}`)
  return ok(raw)
}

function checkDuration(range: Kind<'duration'>, raw: string): ValueCheck {
  if (raw === '0') return range.min <= 0 ? ok('0') : fail(`duration: 0 below min ${range.min}ms`)
  const d = dimension(raw)
  if (!d || d.unit !== 'ms') return fail(`duration: "${raw}" is not a value in ms`)
  if (d.n > range.max) return fail(`duration: ${raw} above max ${range.max}ms`)
  if (d.n < range.min) return fail(`duration: ${raw} below min ${range.min}ms`)
  return ok(raw)
}

function checkFontStack(raw: string): ValueCheck {
  if (raw.length > 400) return fail('font-stack: longer than 400 characters')
  // Family items: a quoted name without quotes or backslashes inside ...
  const quoted = /^(?:"[^"\\;{}]+"|'[^'\\;{}]+')$/
  // ... or bare identifiers (generic keywords such as `system-ui`, `-apple-system`).
  const bare = /^-?[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z][A-Za-z0-9-]*)*$/
  // Commas inside quotes are not separators; quoted names containing one are rejected below.
  for (const item of raw.split(',').map((s) => s.trim())) {
    if (!quoted.test(item) && !bare.test(item)) {
      return fail(`font-stack: "${item}" is not a quoted family or a keyword`)
    }
    // `url(` and `@import` cannot match either pattern; keep the explicit guard for the message.
    if (/url\(|@import/i.test(item)) return fail('font-stack: url( and @import are not allowed')
  }
  return ok(raw)
}

function checkEasing(raw: string): ValueCheck {
  if (/^(?:ease|ease-in|ease-out|ease-in-out|linear)$/.test(raw)) return ok(raw)
  // cubic-bezier(x1, y1, x2, y2) with x1 and x2 in 0..1.
  const m = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(raw)
  if (m) {
    const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number]
    if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return fail(`easing: "${raw}" has a malformed number`)
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return fail('easing: cubic-bezier x values must be within 0..1')
    return ok(raw)
  }
  return fail(`easing: "${raw}" is not a keyword or cubic-bezier(...)`)
}

function checkShadow(raw: string): ValueCheck {
  if (raw === 'none') return ok(raw)
  const layers: string[] = []
  // Colours are hex only, so every comma separates layers.
  for (const layer of raw.split(',').map((s) => s.trim())) {
    const parts = layer.split(/\s+/)
    if (parts[0] === 'inset') parts.shift()
    const colour = parts.pop() ?? ''
    const offsets = parts
    if (offsets.length < 2 || offsets.length > 4) {
      return fail(`shadow: "${layer}" needs 2 to 4 lengths before the colour`)
    }
    for (const o of offsets) {
      const d = dimension(o)
      const valid = o === '0' || (d !== null && ['px', 'rem', 'em'].includes(d.unit))
      if (!valid) return fail(`shadow: "${o}" is not a length`)
    }
    const c = checkHex(colour)
    if (!c.ok) return fail(`shadow: "${colour}" is not a hex colour`)
    layers.push(layer.replace(colour, c.value))
  }
  return ok(layers.join(', '))
}

function checkTextSize(raw: string): ValueCheck {
  const inRem = (s: string): number | null => {
    const d = dimension(s)
    return d && d.unit === 'rem' && d.n >= 0.5 && d.n <= 6 ? d.n : null
  }
  if (!raw.startsWith('clamp(')) {
    return inRem(raw) !== null ? ok(raw) : fail(`text-size: "${raw}" is not a rem value from 0.5 to 6`)
  }
  // clamp(<rem>, <rem> + <vw>, <rem>) — nothing else, in particular no calc().
  const m = /^clamp\(\s*([\d.]+rem)\s*,\s*([\d.]+rem)\s*\+\s*([\d.]+vw)\s*,\s*([\d.]+rem)\s*\)$/.exec(raw)
  if (!m) return fail('text-size: clamp() must have the form clamp(<rem>, <rem> + <vw>, <rem>)')
  const lo = inRem(m[1]!)
  const mid = inRem(m[2]!)
  const hi = inRem(m[4]!)
  const vw = dimension(m[3]!)
  if (lo === null || mid === null || hi === null || !vw || Number.isNaN(vw.n)) {
    return fail('text-size: clamp() values must be rem from 0.5 to 6 and a vw number')
  }
  if (vw.n > 10) return fail('text-size: clamp() vw part above 10vw')
  if (lo > hi) return fail('text-size: clamp() minimum above maximum')
  return ok(raw)
}

function checkChoice(range: Kind<'choice'>, raw: string): ValueCheck {
  return range.values.includes(raw) ? ok(raw) : fail(`choice: "${raw}" is not one of the allowed values`)
}

export function checkValue(range: TokenRange, raw: string): ValueCheck {
  const value = raw.trim()
  switch (range.kind) {
    case 'hex':
      return checkHex(value)
    case 'length':
      return checkLength(range, value)
    case 'number':
      return checkNumber(range, value)
    case 'duration':
      return checkDuration(range, value)
    case 'font-stack':
      return checkFontStack(value)
    case 'easing':
      return checkEasing(value)
    case 'shadow':
      return checkShadow(value)
    case 'text-size':
      return checkTextSize(value)
    case 'choice':
      return checkChoice(range, value)
  }
}
