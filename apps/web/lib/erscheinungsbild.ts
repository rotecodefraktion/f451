/**
 * Storage format of the program preview ("Im ganzen Programm ausprobieren"):
 * the token overrides per mode, as stored in `localStorage['erscheinungsbild']`
 * (`PREVIEW_STORAGE_KEY` in `lib/theme-preview.ts`). Written by
 * `components/theme-editor/program-preview.tsx`, applied before the first paint
 * by `NO_FLASH_TOKENS` in `app/layout.tsx`.
 */

export type Modus = 'light' | 'dark'
/** The stored shape: custom properties per mode, plus the full switch set as attribute names → values. */
export interface Ueberschreibungen {
  light: Record<string, string>
  dark: Record<string, string>
  attributes: Record<string, string>
}

const MODI: Modus[] = ['light', 'dark']

const ATTRIBUT_NAME = /^[a-z][a-z0-9-]{0,40}$/
const ATTRIBUT_WERT = /^[a-z0-9-]{1,40}$/
/** Attributes `<html>` carries for other purposes; a stored switch must never overwrite them. */
const RESERVIERT = new Set(['theme', 'nav', 'rail', 'altlasten'])

const leer = (): Ueberschreibungen => ({ light: {}, dark: {}, attributes: {} })

/**
 * Raw localStorage value -> overrides per mode.
 *
 * Never throws: localStorage holds whatever someone or some earlier version
 * once put there. A read error would break the page exactly for the people
 * with a broken entry. Anything not readable as a string is dropped; the rest
 * stays.
 */
export function leseUeberschreibungen(roh: string | null): Ueberschreibungen {
  if (!roh) return leer()
  let geparst: unknown
  try {
    geparst = JSON.parse(roh)
  } catch {
    return leer()
  }
  if (typeof geparst !== 'object' || geparst === null || Array.isArray(geparst)) return leer()

  const werte = leer()
  for (const modus of MODI) {
    const teil = (geparst as Record<string, unknown>)[modus]
    if (typeof teil !== 'object' || teil === null || Array.isArray(teil)) continue
    for (const [name, wert] of Object.entries(teil)) {
      if (typeof wert === 'string') werte[modus][name] = wert
    }
  }
  // Switch attributes go onto <html> as `data-<name>`: only names and values of the
  // switch grammar pass, so a tampered entry cannot set arbitrary attributes.
  const attribute = (geparst as Record<string, unknown>).attributes
  if (typeof attribute === 'object' && attribute !== null && !Array.isArray(attribute)) {
    for (const [name, wert] of Object.entries(attribute)) {
      if (typeof wert === 'string' && ATTRIBUT_NAME.test(name) && ATTRIBUT_WERT.test(wert) && !RESERVIERT.has(name)) {
        werte.attributes[name] = wert
      }
    }
  }
  return werte
}

/**
 * Overrides -> raw localStorage value. `preview` marks a value written by the
 * program preview (top-level `preview: true`); the no-flash script reads only
 * `light`/`dark` and ignores the marker. A value without it is an old override
 * set from before the personal theme — the appearance page offers to take it over.
 */
export function schreibeUeberschreibungen(
  werte: Ueberschreibungen,
  opts: { preview?: boolean } = {},
): string {
  return JSON.stringify(opts.preview ? { ...werte, preview: true } : werte)
}

/** True when the raw value was written by the program preview (`preview: true`). Never throws. */
export function istVorschau(roh: string | null): boolean {
  if (!roh) return false
  try {
    const geparst: unknown = JSON.parse(roh)
    return typeof geparst === 'object' && geparst !== null && (geparst as Record<string, unknown>).preview === true
  } catch {
    return false
  }
}
