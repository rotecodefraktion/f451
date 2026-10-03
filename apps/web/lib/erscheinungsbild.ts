/**
 * Storage format of the program preview ("Im ganzen Programm ausprobieren"):
 * the token overrides per mode, as stored in `localStorage['erscheinungsbild']`
 * (`PREVIEW_STORAGE_KEY` in `lib/theme-preview.ts`). Written by
 * `components/theme-editor/program-preview.tsx`, applied before the first paint
 * by `NO_FLASH_TOKENS` in `app/layout.tsx`.
 */

export type Modus = 'light' | 'dark'

const MODI: Modus[] = ['light', 'dark']

const leer = (): Record<Modus, Record<string, string>> => ({ light: {}, dark: {} })

/**
 * Raw localStorage value -> overrides per mode.
 *
 * Never throws: localStorage holds whatever someone or some earlier version
 * once put there. A read error would break the page exactly for the people
 * with a broken entry. Anything not readable as a string is dropped; the rest
 * stays.
 */
export function leseUeberschreibungen(roh: string | null): Record<Modus, Record<string, string>> {
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
  return werte
}

/**
 * Overrides -> raw localStorage value. `preview` marks a value written by the
 * program preview (top-level `preview: true`); the no-flash script reads only
 * `light`/`dark` and ignores the marker. A value without it is an old override
 * set from before the personal theme — the appearance page offers to take it over.
 */
export function schreibeUeberschreibungen(
  werte: Record<Modus, Record<string, string>>,
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
