/**
 * Reine (DOM-freie) Logik für den Metadaten-Schema-Editor (Metadaten-Feature
 * M4, `app/wiki/[space]/(shell)/schema/page.tsx`). Analog zu
 * `lib/metadata-form.ts` (M3, das ERFASS-Formular einer einzelnen Seite):
 * dieses Modul ist die SCHEMA-Bearbeitungsseite — ein `MetadataSchema` in
 * eine editierbare Feld-Liste umwandeln, Feld-CRUD/Umsortierung, und zurück
 * in das JSON-Payload, das `PUT /api/spaces/:space/metadata-schema`
 * erwartet. Bewusst ohne React (`lib/**`-Standardmuster, s.
 * `vitest.config.ts`: nur `lib/**` läuft unter Vitest).
 *
 * Validierung wird hier bewusst NICHT dupliziert — die Komponente ruft dafür
 * direkt `parseMetadataSchemaFromValue` aus `@f451/markdown` auf
 * {@link draftFieldsToPayload}s Ergebnis (dieselbe Validierung, die auch die
 * Schreib-Route serverseitig durchläuft, s. `apps/api/src/routes/metadata-schema.ts`)
 * statt einer dritten, potenziell abweichenden Kopie der Regeln hier.
 *
 * `order` wird von diesem Modul bewusst NIE gesetzt — die Array-Reihenfolge
 * der Draft-Felder (durch {@link moveFieldUp}/{@link moveFieldDown} bestimmt)
 * IST die Reihenfolge; `parseMetadataSchemaFromValue`/`stringifyMetadataSchema`
 * sortieren ohne `order` stabil nach Datei-/Array-Position (s.
 * `packages/markdown/src/schema.ts`).
 */

import type { AutoFieldSource, ClassificationSettings, MetadataField, MetadataFieldType, MetadataSchema } from '@f451/markdown'

/**
 * Editierbarer Zustand EINES Feldes im Schema-Editor-Formular — ein
 * einziger, typ-unabhängiger Shape (anders als die diskriminierte
 * `MetadataField`-Union aus `@f451/markdown`) mit einem kontrollierten
 * `<input>`/`<select>` pro Eigenschaft, damit die Formular-Komponente nicht
 * bei jedem Typwechsel den State-Shape wechseln muss. Typ-spezifische
 * Eigenschaften, die für den aktuell gewählten `type` nicht gelten (z. B.
 * `pattern` bei `type: 'enum'`), bleiben im State erhalten, aber
 * {@link draftFieldToRawField} ignoriert sie beim Bau des Payloads.
 */
export interface DraftMetadataField {
  key: string
  label: string
  type: MetadataFieldType
  required: boolean
  /** Nur bei `type: 'pattern'` relevant. */
  pattern: string
  /** Nur bei `type: 'pattern'` relevant (optional, leer = kein Hinweistext). */
  patternHint: string
  /** Nur bei `type: 'enum'` (Pflicht, mind. eine Option) und `type: 'multi'`
   *  (optional — leer = freie Tag-Eingabe) relevant. Eine Option pro Zeile
   *  (s. {@link optionsTextToList}/{@link optionsListToText}). */
  optionsText: string
  /** Nur bei `type: 'user'` (`'actor'` oder `''`) bzw. `type: 'date'`
   *  (`'date'` oder `''`) relevant — s. `schema.ts#UserField`/`DateField`. */
  fillOnRelease: 'actor' | 'date' | ''
  /** Nur bei `type: 'auto'` relevant. `''` = noch keine Quelle gewählt (die
   *  Validierung markiert das dann als Fehler, s. `parseMetadataSchemaFromValue`). */
  source: AutoFieldSource | ''
}

/** Ein leeres `text`-Feld — Startpunkt für „Feld hinzufügen" ({@link addField}). */
export function createDraftField(): DraftMetadataField {
  return {
    key: '',
    label: '',
    type: 'text',
    required: false,
    pattern: '',
    patternHint: '',
    optionsText: '',
    fillOnRelease: '',
    source: '',
  }
}

/** Ein Options-Textfeld → Liste (eine Option pro Zeile, getrimmt, leere
 *  Zeilen verworfen) — Gegenstück zu {@link optionsListToText}. Eine Zeile
 *  pro Option statt Komma-Trennung: Optionswerte können selbst Kommata
 *  enthalten (z. B. "Einkauf, DACH"). */
export function optionsTextToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Eine Options-Liste → Textfeld-Inhalt (eine Zeile pro Option) — Gegenstück
 *  zu {@link optionsTextToList}. `undefined` (Feld hat keine `options`, z. B.
 *  ein `multi`-Feld mit freier Eingabe) → leerer Text. */
export function optionsListToText(options: string[] | undefined): string {
  return options ? options.join('\n') : ''
}

/** Hängt ein neues leeres Feld ({@link createDraftField}) ans Ende an. */
export function addField(fields: DraftMetadataField[]): DraftMetadataField[] {
  return [...fields, createDraftField()]
}

/** Entfernt das Feld am gegebenen Index. Index außerhalb des Bereichs → No-Op
 *  (defensiv, z. B. wenn zwei schnelle Klicks denselben Index doppelt treffen). */
export function removeFieldAt<T>(fields: T[], index: number): T[] {
  if (index < 0 || index >= fields.length) return fields
  return fields.filter((_, i) => i !== index)
}

/** Vertauscht das Feld am Index mit seinem Vorgänger („Hoch"-Button). Index 0
 *  oder außerhalb des Bereichs → No-Op (kein Vorgänger zum Tauschen). */
export function moveFieldUp<T>(fields: T[], index: number): T[] {
  if (index <= 0 || index >= fields.length) return fields
  const copy = [...fields]
  const above = copy[index - 1]!
  const current = copy[index]!
  copy[index - 1] = current
  copy[index] = above
  return copy
}

/** Vertauscht das Feld am Index mit seinem Nachfolger („Runter"-Button) —
 *  über {@link moveFieldUp} auf `index + 1` implementiert (symmetrischer
 *  Swap, kein separater Code-Pfad). Letzter Index oder außerhalb des
 *  Bereichs → No-Op. */
export function moveFieldDown<T>(fields: T[], index: number): T[] {
  if (index < 0 || index >= fields.length - 1) return fields
  return moveFieldUp(fields, index + 1)
}

/** Wechselt den Typ eines Feldes — `key`/`label`/`required` bleiben erhalten
 *  (typ-unabhängig), alle typ-spezifischen Eigenschaften werden
 *  zurückgesetzt (sonst bliebe z. B. ein `pattern`-Wert unsichtbar im State
 *  hängen, nachdem der Nutzer auf `enum` umgeschaltet hat, und tauchte bei
 *  einem erneuten Wechsel zurück zu `pattern` unerwartet wieder auf). */
export function changeFieldType(field: DraftMetadataField, newType: MetadataFieldType): DraftMetadataField {
  return {
    ...field,
    type: newType,
    pattern: '',
    patternHint: '',
    optionsText: '',
    fillOnRelease: '',
    source: '',
  }
}

/** Ein einzelnes {@link MetadataField} (aus `GET .../metadata-schema`) → sein
 *  editierbarer Formular-Zustand — Gegenstück zu {@link draftFieldToRawField}. */
function rawFieldToDraft(field: MetadataField): DraftMetadataField {
  const draft = createDraftField()
  draft.key = field.key
  draft.label = field.label
  draft.type = field.type
  draft.required = field.required ?? false

  if (field.type === 'pattern') {
    draft.pattern = field.pattern
    draft.patternHint = field.patternHint ?? ''
  } else if (field.type === 'enum' || field.type === 'multi') {
    draft.optionsText = optionsListToText(field.options)
  } else if (field.type === 'auto') {
    draft.source = field.source
  } else if (field.type === 'user' || field.type === 'date') {
    draft.fillOnRelease = field.fillOnRelease ?? ''
  }

  return draft
}

/** Ein vollständiges {@link MetadataSchema} → die editierbare Feld-Liste, mit
 *  der der Editor startet (Ausgangsstand beim Öffnen der Seite, Muster
 *  `lib/metadata-form.ts#buildInitialFormValues`). */
export function schemaToDraftFields(schema: MetadataSchema): DraftMetadataField[] {
  return schema.fields.map(rawFieldToDraft)
}

/** Ein einzelnes Draft-Feld → das lose typisierte Objekt, das
 *  `parseMetadataSchemaFromValue`/die Schreib-Route erwarten (dieselbe Form
 *  wie ein `fields[i]`-Eintrag in `_meta/schema.yaml`). Nur Schlüssel, die für
 *  den aktuellen `type` tatsächlich gelten UND einen Wert haben, landen im
 *  Ergebnis — ein leerer `patternHint` bei `type: 'pattern'` erzeugt also
 *  KEIN `patternHint: ''` im Payload (Muster
 *  `packages/markdown/src/schema.ts#fieldToPlainObject`, dieselbe
 *  „nur gesetzte Schlüssel"-Konvention). `key`/`label` werden getrimmt — ein
 *  Nutzer, der versehentlich ein Leerzeichen tippt, soll keinen
 *  "label fehlt"-Fehler für einen NUR-AUS-Leerzeichen-Wert bekommen (die
 *  Server-Validierung prüft ohnehin `trim().length === 0`). */
function draftFieldToRawField(field: DraftMetadataField): Record<string, unknown> {
  const raw: Record<string, unknown> = { key: field.key.trim(), label: field.label.trim(), type: field.type }

  if (field.required) raw.required = true

  if (field.type === 'pattern') {
    raw.pattern = field.pattern
    if (field.patternHint.trim().length > 0) raw.patternHint = field.patternHint.trim()
  } else if (field.type === 'enum') {
    raw.options = optionsTextToList(field.optionsText)
  } else if (field.type === 'multi') {
    const options = optionsTextToList(field.optionsText)
    if (options.length > 0) raw.options = options
  } else if (field.type === 'auto') {
    if (field.source) raw.source = field.source
  } else if (field.type === 'user') {
    if (field.fillOnRelease === 'actor') raw.fillOnRelease = 'actor'
  } else if (field.type === 'date') {
    if (field.fillOnRelease === 'date') raw.fillOnRelease = 'date'
  }

  return raw
}

/** Die komplette Draft-Feld-Liste → das `PUT`-Body-Payload (`{fields: [...],
 *  versioning}`, s. `apps/api/src/routes/metadata-schema.ts`). Reihenfolge im
 *  Array = Reihenfolge im gespeicherten Schema (kein `order` gesetzt, s.
 *  Modulkommentar).
 *
 * `versioning` ist ein PFLICHT-Parameter statt eines optionalen mit
 * `false`-Default: der Schema-Editor hat KEINE Bedienelemente für den
 * Schalter (bewusst, s. Modulkommentar) — er darf ihn beim Speichern trotzdem
 * nicht stillschweigend zurücksetzen. Ein Default würde genau diesen
 * Datenverlust-Pfad wieder öffnen (ein Aufrufer, der den Parameter vergisst,
 * bekäme unbemerkt `false` statt eines Typfehlers). Der Aufrufer
 * (`MetadataSchemaEditor`) hält dafür den beim Laden gesehenen
 * `schema.versioning`-Wert in einem eigenen State und reicht ihn hier bei
 * jedem Speichern unverändert durch. */
export function draftFieldsToPayload(
  fields: DraftMetadataField[],
  versioning: boolean,
  // Like `versioning`: no control in the editor, only passed through so a
  // save never drops the space's `classification:` block.
  classification?: ClassificationSettings,
): { fields: unknown[]; versioning: boolean; classification?: ClassificationSettings } {
  return { fields: fields.map(draftFieldToRawField), versioning, ...(classification ? { classification } : {}) }
}
