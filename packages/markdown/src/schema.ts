import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { KNOWN_FRONTMATTER_KEYS } from './frontmatter.js'

/**
 * Metadaten-Schema-Format (`_meta/schema.yaml`, pro Space im Space-Repo neben
 * `_media/`/`_templates/` versioniert): definiert die strukturierten Zusatz-
 * felder, die eine Seite dieses Spaces im Frontmatter tragen darf (Beispiel:
 * SAP-Prozess-Doku mit Process ID, Business Unit, Status, Approved by …).
 * Die tatsächlichen Werte liegen im Frontmatter der einzelnen Seite (siehe
 * `PageFrontmatter.metadata` in types.ts) — dieses Modul beschreibt nur die
 * FORM, nicht die Werte. Erfass-UI, Rail-Anzeige und Auto-Feld-Ableitung aus
 * Git (M2/M3) bauen auf diesem Format auf, sind aber nicht Teil davon.
 */
export const METADATA_FIELD_TYPES = ['text', 'pattern', 'enum', 'date', 'multi', 'user', 'auto'] as const

export type MetadataFieldType = (typeof METADATA_FIELD_TYPES)[number]

/** Quellen für `type: auto` (Phase M3 leitet den Wert daraus ab; M1 definiert
 *  nur das Format). */
export const AUTO_FIELD_SOURCES = ['last_author', 'last_updated'] as const
export type AutoFieldSource = (typeof AUTO_FIELD_SOURCES)[number]

interface MetadataFieldBase {
  /** Frontmatter-Schlüssel, unter dem der Wert einer Seite steht (siehe
   *  `PageFrontmatter.metadata`). Eindeutig innerhalb eines Schemas. */
  key: string
  /** Anzeigename für die Erfass-UI/Rail (M2). */
  label: string
  /** Pflichtfeld beim Erfassen (M2) — hier nur transportiert, nicht erzwungen. */
  required?: boolean
  /** Anzeigereihenfolge (aufsteigend); Felder ohne `order` behalten ihre
   *  Position in der YAML-Datei relativ zu den sortierten. */
  order?: number
}

export interface TextField extends MetadataFieldBase {
  type: 'text'
}

export interface PatternField extends MetadataFieldBase {
  type: 'pattern'
  /** Regex, gegen die ein Wert geprüft wird (Prüfung selbst ist M2/UI-Sache). */
  pattern: string
  /** Hilfetext bei Nichteinhaltung des Patterns (z. B. "Format: SAP-P-NNNN"). */
  patternHint?: string
}

export interface EnumField extends MetadataFieldBase {
  type: 'enum'
  options: string[]
}

export interface DateField extends MetadataFieldBase {
  type: 'date'
  /**
   * Freigabe-Vorbelegung (Metadaten-Feature M3b Teil B, `POST /release`,
   * `routes/workflow.ts`): `'date'` markiert, dass dieses Feld beim Freigeben
   * MIT dem Freigabedatum vorbelegt wird, FALLS es zu diesem Zeitpunkt noch
   * leer ist — ein bereits vom Nutzer im Erfass-Formular gesetzter Wert wird
   * NIE überschrieben (s. {@link computeFillOnReleaseValues}). Anders als
   * `type: 'auto'` bleibt das Feld dabei ganz normal EDITIERBAR (Nutzer-
   * Entscheidung: nur vorbelegt, nicht automatisch/read-only) — Beispiel:
   * `approval_date: { type: date, fillOnRelease: date }`.
   */
  fillOnRelease?: 'date'
}

export interface MultiField extends MetadataFieldBase {
  type: 'multi'
  /** Optional — gesetzt: Mehrfachauswahl aus einer festen Liste (wie `enum`,
   *  aber mehrere Werte). Ungesetzt: freie Liste von Text-Werten (wie `tags`). */
  options?: string[]
}

export interface UserField extends MetadataFieldBase {
  type: 'user'
  /**
   * Wie `DateField.fillOnRelease`, hier mit dem freigebenden Nutzer:
   * `'actor'` markiert, dass dieses Feld beim Freigeben MIT dem freigebenden
   * Nutzer vorbelegt wird, falls es noch leer ist — Beispiel:
   * `approved_by: { type: user, fillOnRelease: actor }`.
   */
  fillOnRelease?: 'actor'
}

export interface AutoField extends MetadataFieldBase {
  type: 'auto'
  /** Woher der Wert automatisch abgeleitet wird — die Ableitung selbst ist
   *  M3 (Git-Historie); M1 transportiert nur, WELCHE Quelle gemeint ist. */
  source: AutoFieldSource
}

export type MetadataField =
  | TextField
  | PatternField
  | EnumField
  | DateField
  | MultiField
  | UserField
  | AutoField

export interface MetadataSchema {
  fields: MetadataField[]
  /** Seitenversionierung für diesen Space aktiv (Semver + Changelog bei der
   *  Freigabe). Default `false` — fehlt das Feld, verhält sich der Space
   *  exakt wie vor Einführung der Versionierung. */
  versioning: boolean
}

/** Leeres Schema — Rückgabewert bei fehlender/kaputter `_meta/schema.yaml`
 *  (Fail-Soft-Philosophie wie `parseFrontmatterBlock`, siehe frontmatter.ts). */
export const EMPTY_METADATA_SCHEMA: MetadataSchema = { fields: [], versioning: false }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validiert die typ-unabhängigen Basisfelder (`key`, `type`, optional
 *  `label`/`required`/`order`) eines einzelnen Eintrags. `null`, wenn der
 *  Eintrag strukturell unbrauchbar ist (kein Objekt, `key`/`type` fehlen oder
 *  falsch) — der Aufrufer überspringt den gesamten Eintrag dann. `label` fehlt
 *  oder hat falschen Typ → Fehler wird gemeldet, das Feld bleibt aber
 *  erhalten (fällt auf `key` zurück) statt komplett verworfen zu werden. */
function parseBase(
  entry: Record<string, unknown>,
  index: number,
  seenKeys: Set<string>,
  errors: string[],
): { key: string; label: string; required?: boolean; order?: number } | null {
  const prefix = `fields[${index}]`

  if (typeof entry.key !== 'string' || entry.key.trim().length === 0) {
    errors.push(`${prefix}: "key" muss ein nicht-leerer String sein`)
    return null
  }
  const key = entry.key
  if (seenKeys.has(key)) {
    errors.push(`${prefix}: "key" ("${key}") ist bereits vergeben`)
    return null
  }
  // Befund 2 (Final-Review): `key` darf keinem der reservierten Top-Level-
  // Frontmatter-Felder entsprechen (`id`, `title`, ..., seit diesem Feature
  // auch `version`/`changelog`, s. `frontmatter.ts#KNOWN_FRONTMATTER_KEYS`,
  // EINE gemeinsame Quelle statt einer zweiten, potenziell abweichenden Liste
  // hier). Würde ein Space z. B. `- key: version, type: text` deklarieren
  // (naheliegender Metadatenname für ein Wiki), landete der Wert NICHT mehr im
  // `metadata`-Passthrough (`parseFrontmatterBlock` reserviert den Schlüssel
  // für sich) — das Feld verlöre still seinen Wert, und das nächste Speichern
  // über das Metadaten-Formular entfernte den Schlüssel aus der Datei
  // (Datenverlust in Git). Fail-soft wie der Rest dieses Parsers: der Eintrag
  // wird verworfen, andere gültige Felder bleiben erhalten.
  if (KNOWN_FRONTMATTER_KEYS.has(key)) {
    errors.push(
      `${prefix}: "key" ("${key}") ist ein reservierter Frontmatter-Schlüssel und kann nicht als `
        + 'Metadatenfeld verwendet werden',
    )
    return null
  }

  let label = key
  if (entry.label === undefined) {
    errors.push(`${prefix} ("${key}"): "label" fehlt — nutze "key" als Fallback`)
  } else if (typeof entry.label === 'string' && entry.label.trim().length > 0) {
    label = entry.label
  } else {
    errors.push(`${prefix} ("${key}"): "label" muss ein nicht-leerer String sein — nutze "key" als Fallback`)
  }

  const result: { key: string; label: string; required?: boolean; order?: number } = { key, label }

  if (entry.required !== undefined) {
    if (typeof entry.required === 'boolean') {
      result.required = entry.required
    } else {
      errors.push(`${prefix} ("${key}"): "required" muss ein Boolean sein — ignoriert`)
    }
  }

  if (entry.order !== undefined) {
    if (typeof entry.order === 'number' && Number.isFinite(entry.order)) {
      result.order = entry.order
    } else {
      errors.push(`${prefix} ("${key}"): "order" muss eine Zahl sein — ignoriert`)
    }
  }

  return result
}

/** Validiert einen einzelnen `fields[i]`-Eintrag. Gibt `null` zurück, wenn der
 *  Eintrag verworfen werden muss (fehlende/falsche Pflichtangaben) — andere,
 *  gültige Einträge bleiben davon unberührt (granulares Fail-Soft, analog zu
 *  `parseFrontmatterBlock`s Behandlung unbekannter Relations-Typen). */
function parseField(
  raw: unknown,
  index: number,
  seenKeys: Set<string>,
  errors: string[],
): MetadataField | null {
  const prefix = `fields[${index}]`
  if (!isPlainObject(raw)) {
    errors.push(`${prefix}: muss ein Objekt sein`)
    return null
  }

  if (typeof raw.type !== 'string' || !(METADATA_FIELD_TYPES as readonly string[]).includes(raw.type)) {
    errors.push(
      `${prefix}: "type" muss eine der folgenden sein: ${METADATA_FIELD_TYPES.join(', ')} `
        + `(erhalten: ${JSON.stringify(raw.type)})`,
    )
    return null
  }
  const type = raw.type as MetadataFieldType

  const base = parseBase(raw, index, seenKeys, errors)
  if (!base) return null

  if (type === 'pattern') {
    if (typeof raw.pattern !== 'string' || raw.pattern.trim().length === 0) {
      errors.push(`${prefix} ("${base.key}"): type "pattern" erfordert "pattern" (nicht-leerer String)`)
      return null
    }
    try {
      // eslint-disable-next-line no-new -- nur ein Gültigkeits-Check, wirft bei kaputtem Regex.
      new RegExp(raw.pattern)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${prefix} ("${base.key}"): "pattern" ist kein gültiger regulärer Ausdruck: ${message}`)
      return null
    }
    let patternHint: string | undefined
    if (raw.patternHint !== undefined) {
      if (typeof raw.patternHint === 'string') {
        patternHint = raw.patternHint
      } else {
        errors.push(`${prefix} ("${base.key}"): "patternHint" muss ein String sein — ignoriert`)
      }
    }
    return { ...base, type, pattern: raw.pattern, patternHint }
  }

  if (type === 'enum') {
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      errors.push(`${prefix} ("${base.key}"): type "enum" erfordert "options" (nicht-leere Liste von Strings)`)
      return null
    }
    const options = raw.options.filter((o): o is string => typeof o === 'string')
    if (options.length !== raw.options.length) {
      errors.push(`${prefix} ("${base.key}"): "options" muss eine Liste von Strings sein`)
      return null
    }
    return { ...base, type, options }
  }

  if (type === 'multi') {
    let options: string[] | undefined
    if (raw.options !== undefined) {
      if (!Array.isArray(raw.options)) {
        errors.push(`${prefix} ("${base.key}"): "options" muss eine Liste von Strings sein — ignoriert`)
      } else {
        const strings = raw.options.filter((o): o is string => typeof o === 'string')
        if (strings.length !== raw.options.length) {
          errors.push(`${prefix} ("${base.key}"): "options" muss eine Liste von Strings sein — ignoriert`)
        } else {
          options = strings
        }
      }
    }
    return { ...base, type, options }
  }

  if (type === 'auto') {
    if (typeof raw.source !== 'string' || !(AUTO_FIELD_SOURCES as readonly string[]).includes(raw.source)) {
      errors.push(
        `${prefix} ("${base.key}"): type "auto" erfordert "source" `
          + `(${AUTO_FIELD_SOURCES.join(' | ')}), erhalten: ${JSON.stringify(raw.source)}`,
      )
      return null
    }
    return { ...base, type, source: raw.source as AutoFieldSource }
  }

  if (type === 'user') {
    let fillOnRelease: 'actor' | undefined
    if (raw.fillOnRelease !== undefined) {
      if (raw.fillOnRelease === 'actor') {
        fillOnRelease = 'actor'
      } else {
        errors.push(
          `${prefix} ("${base.key}"): "fillOnRelease" muss bei type "user" "actor" sein `
            + `(erhalten: ${JSON.stringify(raw.fillOnRelease)}) — ignoriert`,
        )
      }
    }
    return { ...base, type, ...(fillOnRelease ? { fillOnRelease } : {}) }
  }

  if (type === 'date') {
    let fillOnRelease: 'date' | undefined
    if (raw.fillOnRelease !== undefined) {
      if (raw.fillOnRelease === 'date') {
        fillOnRelease = 'date'
      } else {
        errors.push(
          `${prefix} ("${base.key}"): "fillOnRelease" muss bei type "date" "date" sein `
            + `(erhalten: ${JSON.stringify(raw.fillOnRelease)}) — ignoriert`,
        )
      }
    }
    return { ...base, type, ...(fillOnRelease ? { fillOnRelease } : {}) }
  }

  // 'text' — keine typspezifischen Zusatzfelder.
  return { ...base, type }
}

/**
 * Parst und validiert `_meta/schema.yaml`. Wirft nie — analog zu
 * `parseFrontmatterBlock`: Fehler werden gesammelt und separat zurückgegeben,
 * ungültige Einträge werden übersprungen (der Rest des Schemas bleibt
 * nutzbar), eine komplett kaputte/leere Datei ergibt ein leeres Schema statt
 * eines Absturzes. Gültige Felder werden nach `order` sortiert (aufsteigend,
 * Felder ohne `order` behalten ihre Position in der Datei relativ
 * zueinander — stabile Sortierung nach `order ?? ursprünglicher Index`).
 */
export function parseMetadataSchema(yamlText: string): { schema: MetadataSchema; errors: string[] } {
  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { schema: EMPTY_METADATA_SCHEMA, errors: [`YAML-Syntaxfehler: ${message}`] }
  }

  return parseMetadataSchemaFromValue(raw)
}

/**
 * Kern von {@link parseMetadataSchema} OHNE den YAML-Text-Schritt davor —
 * validiert einen bereits geparsten JS-Wert (Objekt mit optionalem
 * `fields`-Array) gegen dieselben Regeln. Extrahiert für Metadaten-Feature M4
 * (Schema-Editor-UI, `PUT /api/spaces/:space/metadata-schema`): die
 * Schreib-Route bekommt das Schema als JSON-Body (kein YAML-Text) und soll
 * trotzdem exakt dieselbe granulare Validierung durchlaufen wie der
 * YAML-Loader — EINE Validierungslogik statt einer zweiten, potenziell
 * abweichenden Kopie im API-Modul. `parseMetadataSchema` bleibt der
 * öffentliche Einstieg für den YAML-Fall (Loader/Tests), diese Funktion ist
 * der öffentliche Einstieg für den bereits-geparst-Fall (Schreib-Route).
 */
export function parseMetadataSchemaFromValue(raw: unknown): { schema: MetadataSchema; errors: string[] } {
  // Leere/fehlende Datei (kein Schema konfiguriert) ist kein Fehler — dieselbe
  // Konvention wie `parseFrontmatterBlock` für leeres Frontmatter.
  if (raw === null || raw === '' || raw === undefined) {
    return { schema: EMPTY_METADATA_SCHEMA, errors: [] }
  }

  if (!isPlainObject(raw)) {
    return { schema: EMPTY_METADATA_SCHEMA, errors: ['Schema: muss ein Objekt sein'] }
  }

  const earlyErrors: string[] = []

  // VOR den fields-Prüfungen lesen: ein Space darf versioniert sein, ohne
  // eigene Metadatenfelder zu deklarieren — beide frühen Rückgaben unten
  // müssen den Schalter deshalb bereits kennen.
  let versioning = false
  if (raw.versioning !== undefined) {
    if (typeof raw.versioning === 'boolean') {
      versioning = raw.versioning
    } else {
      earlyErrors.push('versioning: muss true oder false sein')
    }
  }

  if (raw.fields === undefined) {
    // Kein "fields"-Schlüssel: gültiges, bewusst leeres Schema (kein Fehler).
    return { schema: { fields: [], versioning }, errors: earlyErrors }
  }

  if (!Array.isArray(raw.fields)) {
    return { schema: { fields: [], versioning }, errors: [...earlyErrors, 'fields: muss eine Liste sein'] }
  }

  const errors: string[] = [...earlyErrors]
  const seenKeys = new Set<string>()
  const indexed: Array<{ field: MetadataField; index: number }> = []

  raw.fields.forEach((entry, index) => {
    const field = parseField(entry, index, seenKeys, errors)
    if (field) {
      seenKeys.add(field.key)
      indexed.push({ field, index })
    }
  })

  indexed.sort((a, b) => {
    const orderA = a.field.order ?? a.index
    const orderB = b.field.order ?? b.index
    if (orderA !== orderB) return orderA - orderB
    return a.index - b.index
  })

  return { schema: { fields: indexed.map((i) => i.field), versioning }, errors }
}

/** `undefined`/`null`/leerer (getrimmter) String/leeres Array gelten als „kein
 *  Wert" — dieselbe Konvention wie `frontmatter-metadata.ts#isEmptyMetadataValue`
 *  bzw. `apps/web/lib/metadata-view.ts#isEmptyValue`, hier lokal dupliziert
 *  (kleine, reine Prüfung ohne gemeinsamen Import-Nenner zwischen den drei
 *  Modulen, analog zur bewussten Duplikation in `metadata-form.ts`). */
function isEmptyMetadataValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** Werte für die Freigabe-Vorbelegung (Metadaten-Feature M3b Teil B, s.
 *  {@link computeFillOnReleaseValues}). */
export interface FillOnReleaseValues {
  /** Anzeigename/Login des freigebenden Nutzers — für `fillOnRelease: 'actor'`-Felder. */
  actor: string
  /** Freigabedatum, roh als String übernommen (z. B. ISO `"2026-07-16"`) —
   *  für `fillOnRelease: 'date'`-Felder. */
  date: string
}

/**
 * Berechnet, welche `fillOnRelease`-Felder eines Schemas beim Freigeben
 * (`POST /api/pages/:id/release`, Metadaten-Feature M3b Teil B,
 * `routes/workflow.ts`) vorbelegt werden müssen: NUR Felder, deren aktueller
 * Metadaten-Wert LEER ist ({@link isEmptyMetadataValue}) — hat der Nutzer im
 * Erfass-Formular (M3) bereits selbst einen Wert eingetragen, bleibt er
 * UNVERÄNDERT (Nutzer-Entscheidung: Vorschlag, kein Zwang). Liefert
 * ausschließlich die zu setzenden Schlüssel (nicht das volle Metadaten-
 * Objekt) — der Aufrufer mergt das Ergebnis über
 * `setFrontmatterMetadata` (`frontmatter-metadata.ts`) in den Frontmatter-
 * Block; ein leeres Ergebnisobjekt bedeutet „nichts zu tun".
 */
export function computeFillOnReleaseValues(
  schema: MetadataSchema,
  currentMetadata: Record<string, unknown>,
  values: FillOnReleaseValues,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of schema.fields) {
    if (field.type === 'user' && field.fillOnRelease === 'actor') {
      if (isEmptyMetadataValue(currentMetadata[field.key])) result[field.key] = values.actor
    }
    if (field.type === 'date' && field.fillOnRelease === 'date') {
      if (isEmptyMetadataValue(currentMetadata[field.key])) result[field.key] = values.date
    }
  }
  return result
}

/** Baut aus einem einzelnen `MetadataField` das Klartext-Objekt, das die
 *  YAML-Serialisierung ({@link stringifyMetadataSchema}) erwartet — Gegenstück
 *  zu {@link parseField}. Nur Schlüssel, die auf dem Feld tatsächlich GESETZT
 *  sind, landen im Ergebnis (kein `patternHint: undefined`/`options: undefined`
 *  in der Datei) — sonst würde `yaml`s Serialisierer sie als `null` schreiben,
 *  und ein erneutes Parsen läse `patternHint: null` statt "Schlüssel fehlt",
 *  was die Roundtrip-Gleichheit mit `toEqual` zwar nicht verletzt (beide
 *  Seiten wären `undefined`), aber unnötig kryptische YAML-Dateien erzeugt. */
function fieldToPlainObject(field: MetadataField): Record<string, unknown> {
  const result: Record<string, unknown> = { key: field.key, label: field.label, type: field.type }

  if (field.type === 'pattern') {
    result.pattern = field.pattern
    if (field.patternHint !== undefined) result.patternHint = field.patternHint
  } else if (field.type === 'enum') {
    result.options = field.options
  } else if (field.type === 'multi') {
    if (field.options !== undefined) result.options = field.options
  } else if (field.type === 'auto') {
    result.source = field.source
  } else if (field.type === 'user' || field.type === 'date') {
    if (field.fillOnRelease !== undefined) result.fillOnRelease = field.fillOnRelease
  }

  // `required`/`order` sind bei JEDEM Feldtyp möglich (MetadataFieldBase) —
  // nur schreiben, wenn tatsächlich gesetzt (kein `required: undefined` als
  // YAML-`null`, s. Funktionskommentar oben).
  if (field.required !== undefined) result.required = field.required
  if (field.order !== undefined) result.order = field.order

  return result
}

/**
 * Serialisiert ein {@link MetadataSchema} zurück in YAML-Text für
 * `_meta/schema.yaml` — Gegenstück zu {@link parseMetadataSchema} (Metadaten-
 * Feature M4, Schema-Editor-UI: `PUT /api/spaces/:space/metadata-schema`
 * schreibt das Ergebnis dieser Funktion über den Repo-Provider, Muster
 * `routes/templates.ts`s Direkt-Commit auf `main`). Reine, nie werfende
 * Funktion — jede Validierung passiert VOR dem Aufruf (Aufrufer: die
 * Schreib-Route über {@link parseMetadataSchemaFromValue}).
 *
 * Roundtrip-Garantie: für jedes Schema, das {@link parseMetadataSchema} selbst
 * zurückgegeben hat (Felder bereits in finaler `order`-Reihenfolge, s. dortiger
 * Kommentar), gilt `parseMetadataSchema(stringifyMetadataSchema(schema)).schema`
 * `.toEqual(schema)` (s. `schema.test.ts`) — Felder werden in
 * Array-Reihenfolge geschrieben, jeder Feld-Schlüssel nur, wenn er im
 * Original gesetzt war ({@link fieldToPlainObject}).
 */
export function stringifyMetadataSchema(schema: MetadataSchema): string {
  const plain: Record<string, unknown> = { fields: schema.fields.map(fieldToPlainObject) }
  // `versioning` nur schreiben, wenn true — `false` ist der (impliziete)
  // Default sowohl beim Parsen als auch für bestehende Schema-Dateien ohne
  // dieses Feld: würde man `false` immer ausschreiben, würde JEDES Speichern
  // über den Schema-Editor unveränderte Dateien mit einer bedeutungslosen
  // Zeile verrauschen (Byte-Gleichheit ginge verloren).
  if (schema.versioning) plain.versioning = schema.versioning
  return stringifyYaml(plain)
}
