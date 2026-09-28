/**
 * Winzige Wörterbuch-Auflösung: verschachtelte Dot-Keys
 * (`'sidebar.tools.graph.label'`)
 * + `{platzhalter}`-Interpolation + Plural.
 *
 * PLURAL-KONVENTION: ein Plural-Key existiert NUR als Paar `<key>_one` /
 * `<key>_other` (nie als eigener `<key>`-Basis-Schlüssel, s.
 * `messages/de/sidebar.ts#pageCount_one/_other`). Beim Aufruf mit einem
 * numerischen `count`-Param wählt `t()` automatisch die passende Variante:
 * `count === 1` → `_one`, sonst `_other`. DE und EN unterscheiden beide nur
 * zwischen diesen zwei Kategorien (kardinale Pluralregel, identisch für
 * beide Sprachen) — eine `Intl.PluralRules`-Kategorisierung wäre hier nur
 * zusätzliche, laufzeit-locale-abhängige Komplexität ohne Mehrwert. Kommt in
 * einer Folgephase eine Sprache mit reicheren Kategorien (z. B. `few`/`many`)
 * hinzu, ist das eine lokale Erweiterung von `pluralCategory()` — die
 * Aufrufer-API (`t(messages, key, { count, … })`) bleibt unverändert.
 */

export type Params = Record<string, string | number>

/** Löst Plural-Keys aus, die als `_one`/`_other`-Suffix-Paar modelliert sind. */
function pluralCategory(count: number): 'one' | 'other' {
  return count === 1 ? 'one' : 'other'
}

/** Ersetzt `{name}`-Platzhalter durch `params.name`; unbekannte Platzhalter
 *  bleiben unverändert stehen (sichtbarer Hinweis auf einen Tippfehler,
 *  statt sie stillschweigend zu verschlucken). */
function interpolate(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Marker für einen fehlenden Key — im UI leicht als kaputte Übersetzung
 *  erkennbar, wirft aber NIE (Übersetzungslücken sollen die Seite nicht
 *  crashen lassen). */
function missingKeyMarker(key: string): string {
  return `⟦${key}⟧`
}

function resolveRaw(messages: unknown, key: string, count: number | undefined): string {
  const segments = key.split('.')
  const lastKey = segments[segments.length - 1]
  if (lastKey === undefined) return missingKeyMarker(key)

  let node: unknown = messages
  for (let i = 0; i < segments.length - 1; i++) {
    if (node === null || typeof node !== 'object') return missingKeyMarker(key)
    node = (node as Record<string, unknown>)[segments[i]!]
  }
  if (node === null || typeof node !== 'object') return missingKeyMarker(key)
  const record = node as Record<string, unknown>

  if (typeof count === 'number') {
    const pluralValue = record[`${lastKey}_${pluralCategory(count)}`]
    if (typeof pluralValue === 'string') return pluralValue
  }

  const value = record[lastKey]
  return typeof value === 'string' ? value : missingKeyMarker(key)
}

/**
 * Typsichere Dot-Key-Pfade eines Wörterbuch-Objekts. Plural-Paare
 * (`foo_one`/`foo_other`) werden auf ihren gemeinsamen Basis-Namen (`foo`)
 * reduziert — genau der Key, den Aufrufer bei `t()` tatsächlich angeben.
 */
type StripPluralSuffix<K extends string> = K extends `${infer Base}_one`
  ? Base
  : K extends `${infer Base}_other`
    ? Base
    : K

export type DotPaths<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string
        ? StripPluralSuffix<K>
        : DotPaths<T[K]> extends infer Rest
          ? Rest extends string
            ? `${K}.${Rest}`
            : never
          : never
    }[keyof T & string]

/**
 * Löst `key` (Dot-Pfad, z. B. `'sidebar.tools.graph.label'`) im aktiven `messages`-
 * Wörterbuch auf und interpoliert `{platzhalter}` aus `params`. Ein
 * `params.count` wählt zusätzlich zwischen `_one`/`_other` (s. o.). Fehlt der
 * Key (z. B. eine Tippfehler-Konstante, die den Typ mit `as` umgeht), wird
 * NIE geworfen — stattdessen ein sichtbarer `⟦key⟧`-Marker geliefert.
 */
export function t<M extends object>(messages: M, key: DotPaths<M>, params?: Params): string {
  const count = typeof params?.count === 'number' ? params.count : undefined
  const raw = resolveRaw(messages, key, count)
  return interpolate(raw, params)
}
