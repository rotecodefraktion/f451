/**
 * Reine (DOM-freie) Logik für das schema-getriebene Metadaten-Erfass-Formular
 * im Editor (Metadaten-Feature M3, `components/editor/metadata-panel.tsx`).
 * Analog zu `lib/metadata-view.ts` (M2, Rail-ANZEIGE): dieses Modul ist die
 * Formular-SEITE — Ausgangswerte aus dem Frontmatter aufbereiten, Nutzereingaben
 * zurück in ein `setFrontmatterMetadata`-taugliches Werte-Objekt verwandeln,
 * sowie die beiden Validierungs-Fragen, die die Widgets brauchen (`pattern`
 * gültig? `required` erfüllt?). Bewusst ohne React, damit alles hier
 * `lib/**`-Standardmuster unit-testbar ist (kein Component-Test-Setup nötig,
 * s. `vitest.config.ts`: nur `lib/**` läuft unter Vitest).
 *
 * `type: 'auto'`-Felder (`last_author`/`last_updated`) sind in M3 read-only
 * (die automatische Ableitung aus Git ist M3b, s. `schema.ts`-Modulkommentar)
 * — sie tauchen deshalb NIE in einem Formular-Werte-Objekt dieses Moduls auf
 * ({@link buildInitialFormValues}/{@link toMetadataValues} überspringen sie
 * konsequent); die Anzeige ihres aktuellen Rohwerts übernimmt die Komponente
 * direkt aus den Seiten-Metadaten, ohne über dieses Modul zu laufen.
 */

import { parseFrontmatterBlock } from '@f451/markdown'
import type { MetadataField, MetadataSchema, PatternField } from '@f451/markdown'

/** Formular-Wert EINES Feldes: `multi` ist ein Array von Strings, jeder
 *  andere Feldtyp ein einzelner String (leerer String = kein Wert — dieselbe
 *  Konvention wie das native `<input>`, das dieses Modul letztlich befüllt). */
export type MetadataFormValue = string | string[]
export type MetadataFormValues = Record<string, MetadataFormValue>

/** `'auto'` ist in M3 nicht editierbar — die einzige Ausnahme unter den
 *  Feldtypen (s. Modulkommentar oben). */
export function isEditableField(field: MetadataField): boolean {
  return field.type !== 'auto'
}

/** Rohwert eines `multi`-Feldes → Array von (getrimmten, nicht-leeren)
 *  Strings. Ein einzelner Skalar wird defensiv als Ein-Element-Liste
 *  behandelt (dasselbe Verhalten wie `lib/metadata-view.ts#toChipValues`,
 *  hier für die EDITIERBARE Seite dupliziert statt importiert — die beiden
 *  Module haben unterschiedliche Rückgabeformen, kein gemeinsamer Nenner,
 *  der eine Extraktion lohnt). */
function toMultiFormValue(rawValue: unknown): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue
      .filter((v) => v !== null && v !== undefined && String(v).trim().length > 0)
      .map((v) => String(v))
  }
  if (rawValue === null || rawValue === undefined || String(rawValue).trim().length === 0) return []
  return [String(rawValue)]
}

/** Rohwert eines EINZELNEN Schema-Feldes → dessen initialer Formular-Wert
 *  (Ausgangsstand beim Öffnen des Editors). Fehlender/leerer Wert → `''`
 *  bzw. `[]`, NIE `undefined` — die Widgets sind kontrollierte
 *  React-Inputs und brauchen für jedes editierbare Feld einen definierten
 *  Ausgangswert. */
export function initialFieldValue(field: MetadataField, rawValue: unknown): MetadataFormValue {
  if (field.type === 'multi') return toMultiFormValue(rawValue)
  if (rawValue === null || rawValue === undefined) return ''
  return String(rawValue)
}

/** Baut den vollständigen Formular-Zustand aus dem Schema + den rohen
 *  Frontmatter-Metadaten-Werten einer Seite (`GET /api/pages/:id`, Feld
 *  `metadata`). `'auto'`-Felder werden übersprungen (s. Modulkommentar). */
export function buildInitialFormValues(
  schema: MetadataSchema,
  metadata: Record<string, unknown> | null | undefined,
): MetadataFormValues {
  const values = metadata ?? {}
  const result: MetadataFormValues = {}
  for (const field of schema.fields) {
    if (!isEditableField(field)) continue
    result[field.key] = initialFieldValue(field, values[field.key])
  }
  return result
}

/** Extrahiert die rohen Metadaten-Werte (`frontmatter.metadata`, s.
 *  `@f451/markdown#PageFrontmatter`) direkt aus einem `frontmatterRaw`-Block
 *  (Format von `splitFrontmatter`s `frontmatterRaw`). Basis für
 *  {@link deriveMetadataFormValues} UND für die read-only-Anzeige von
 *  `'auto'`-Feldern (`MetadataPanel`s `autoValues`-Prop, die NICHT über das
 *  editierbare Formular-Werte-Objekt läuft, s. Modulkommentar oben).
 *  `parseFrontmatterBlock` wirft nie — kaputtes/leeres Frontmatter liefert
 *  einfach `{}` statt eines Absturzes. */
export function rawMetadataFromFrontmatter(frontmatterRaw: string): Record<string, unknown> {
  if (!frontmatterRaw.trim()) return {}
  const withoutFences = frontmatterRaw.replace(/^---\r?\n/, '').replace(/\r?\n?---\r?\n?$/, '')
  const { frontmatter } = parseFrontmatterBlock(withoutFences)
  return frontmatter.metadata ?? {}
}

/** Wie {@link buildInitialFormValues}, aber liest die Metadaten direkt aus
 *  einem `frontmatterRaw`-Block statt aus bereits geparsten Werten — der
 *  Aufrufer (`editor-root.tsx`) hält `frontmatterRaw` als EINZIGE Quelle (s.
 *  dortiger Kommentar); nach jedem Mode-Wechsel/jeder Konfliktauflösung, die
 *  einen NEUEN `frontmatterRaw` liefert, ruft er diese Funktion, um das
 *  Formular wieder mit dem aktuellen Stand zu synchronisieren (kein
 *  Divergieren zwischen Formular und Rohtext-Modus). */
export function deriveMetadataFormValues(schema: MetadataSchema, frontmatterRaw: string): MetadataFormValues {
  return buildInitialFormValues(schema, rawMetadataFromFrontmatter(frontmatterRaw))
}

/** Konvertiert den aktuellen Formular-Zustand zurück in das Werte-Objekt, das
 *  `@f451/markdown#setFrontmatterMetadata` erwartet: Text-Werte getrimmt,
 *  `multi`-Werte getrimmt UND von leeren Einträgen befreit. Ein fehlender
 *  Formular-Wert (Feld noch nie angefasst) liefert `''`/`[]` statt zu werfen —
 *  `setFrontmatterMetadata` behandelt das ohnehin als „entfernen", also
 *  identisch zu einem unveränderten, leeren Ausgangszustand. `'auto'`-Felder
 *  werden NICHT in die Ausgabe aufgenommen (M3 schreibt sie nie, s.
 *  Modulkommentar). */
export function toMetadataValues(schema: MetadataSchema, formValues: MetadataFormValues): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of schema.fields) {
    if (!isEditableField(field)) continue
    const value = formValues[field.key]
    if (field.type === 'multi') {
      const list = Array.isArray(value) ? value : []
      result[field.key] = list.map((v) => v.trim()).filter((v) => v.length > 0)
    } else {
      result[field.key] = typeof value === 'string' ? value.trim() : ''
    }
  }
  return result
}

/** Prüft einen `pattern`-Feldwert gegen dessen Regex. Ein LEERER Wert ist NIE
 *  ein Pattern-Verstoß — Leere/Pflicht ist die separate Frage von
 *  {@link isFieldMissing} (Spec: leere Pflichtfelder werden angezeigt, aber
 *  blockieren nicht; ein leeres Feld soll deshalb nicht zusätzlich als
 *  "ungültiges Pattern" aufleuchten). Ein kaputtes Pattern im Schema selbst
 *  (sollte durch `parseMetadataSchema`s Validierung eigentlich nie vorkommen,
 *  s. `schema.ts`) fällt defensiv auf „gültig" zurück statt abzustürzen —
 *  ein Schema-Fehler darf den Editor nicht blockieren. */
export function isPatternValid(field: PatternField, value: string): boolean {
  if (value.trim().length === 0) return true
  try {
    return new RegExp(field.pattern).test(value)
  } catch {
    return true
  }
}

/** Ist ein Pflichtfeld aktuell leer? Nur informativ (Spec: „zeige Hinweis",
 *  blockiert das Speichern NICHT) — der Aufrufer entscheidet, was mit dem
 *  Ergebnis passiert (z. B. eine Hinweiszeile im Formular). */
export function isFieldMissing(field: MetadataField, value: MetadataFormValue): boolean {
  if (!field.required) return false
  if (Array.isArray(value)) return value.length === 0
  return value.trim().length === 0
}
