/**
 * Reine (DOM-freie) Formatierungs-Logik für die Schema-Metadaten-Anzeige der
 * Rail (Metadaten-Feature M2, `apps/web/components/rail.tsx`). Bildet aus dem
 * Space-Schema (`GET /api/spaces/:space/metadata-schema`, `@f451/markdown`
 * `MetadataSchema`) und den rohen Frontmatter-Metadaten-Werten einer Seite
 * (`GET /api/pages/:id`, Feld `metadata`) eine geordnete Liste anzeigefertiger
 * Einträge — typgerecht formatiert je Feldtyp (`MetadataFieldType`), leere/
 * fehlende Felder werden weggelassen (kein leerer Metadaten-Block, keine
 * Regression zum bisherigen Rail-Verhalten ohne Schema).
 *
 * Bewusst hier isoliert (statt inline in `rail.tsx`), damit die Logik ohne
 * React unit-testbar ist (`lib/**`-Testmuster, s. `page-view.test.ts`).
 *
 * Die Ableitung des tatsächlichen Werts für `type: auto`-Felder (aus der
 * Git-Historie/dem Index) ist Feature M3b (`apps/api/src/routes/pages.ts#resolveMetadata`
 * + `spaces/metadata-auto.ts`) — dieses Modul zeigt nur den bereits im
 * `metadata`-Feld ankommenden (dort schon aufgelösten) Wert an, ohne eigene
 * Berechnung; `last_updated` wird dabei wie ein `date`-Feld formatiert (der
 * Wert ist ein ISO-Zeitstempel), `last_author` als reiner Text.
 */

import type { MetadataField, MetadataSchema } from '@f451/markdown'
import type { Locale } from './i18n/types.js'

/** Anzeigefertiger Metadaten-Eintrag für die Rail: `'text'` für einzeilige
 *  Werte (`text`/`pattern`/`date`/`user`/`auto`), `'chips'` für Werte, die als
 *  `.tag`-Chips dargestellt werden (`multi`: mehrere Chips; `enum`: ein
 *  einzelner Badge-Chip — dieselbe Darstellung, unterschiedliche Anzahl). */
export type MetadataViewEntry =
  | { key: string; label: string; kind: 'text'; value: string }
  | { key: string; label: string; kind: 'chips'; values: string[] }

/** `undefined`/`null`/leerer String/leeres Array gelten als „kein Wert" —
 *  das Feld wird dann in der Rail weggelassen statt leer angezeigt. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** Rohwert eines `multi`/`enum`-Feldes → Liste von Chip-Texten. Erwartet für
 *  `multi` ein Array; ein einzelner (nicht-leerer) Skalar wird defensiv als
 *  Ein-Element-Liste behandelt (robust gegen abweichende Frontmatter-Werte,
 *  die kein Array sind). */
function toChipValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !isEmptyValue(v))
      .map((v) => String(v))
  }
  if (isEmptyValue(value)) return []
  return [String(value)]
}

/** ISO-/Datums-String → lokalisiertes Datum (dieselbe Formatierung wie
 *  `lib/page-view.ts#formatUpdatedAt`). Ungültiger, aber nicht-leerer Wert →
 *  Rohwert (gleicher Fallback wie dort). Kein Wert → `null` (Feld wird
 *  weggelassen). */
function formatDateValue(value: unknown, locale: Locale): string | null {
  if (isEmptyValue(value)) return null
  const raw = String(value)
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
}

/**
 * Formatiert den Rohwert EINES Schema-Feldes für die Rail-Anzeige. `null`,
 * wenn das Feld für diese Seite keinen darstellbaren Wert hat — Aufrufer
 * lässt ein solches Feld aus der Anzeige weg.
 */
export function formatMetadataField(field: MetadataField, rawValue: unknown, locale: Locale): MetadataViewEntry | null {
  if (field.type === 'multi') {
    const values = toChipValues(rawValue)
    if (values.length === 0) return null
    return { key: field.key, label: field.label, kind: 'chips', values }
  }

  if (field.type === 'enum') {
    if (isEmptyValue(rawValue)) return null
    return { key: field.key, label: field.label, kind: 'chips', values: [String(rawValue)] }
  }

  if (field.type === 'date' || (field.type === 'auto' && field.source === 'last_updated')) {
    // `auto`+`last_updated` liefert seit M3b einen ISO-Zeitstempel
    // (`pages.updatedAt`, s. `apps/api/src/routes/pages.ts#resolveMetadata`) —
    // wie ein `date`-Feld als lokalisiertes Datum formatiert, statt den rohen
    // ISO-String anzuzeigen.
    const formatted = formatDateValue(rawValue, locale)
    if (formatted === null) return null
    return { key: field.key, label: field.label, kind: 'text', value: formatted }
  }

  // 'text' | 'pattern' | 'user' | 'auto' (source: 'last_author') — reiner
  // Text, Ableitung selbst ist M3b (s. Modulkommentar oben).
  if (isEmptyValue(rawValue)) return null
  return { key: field.key, label: field.label, kind: 'text', value: String(rawValue) }
}

/**
 * Baut die vollständige, anzeigefertige Metadaten-Liste für die Rail: iteriert
 * über die Schema-Felder — sortiert nach `order` (Felder ohne `order` behalten
 * ihre relative Position, dieselbe stabile Sortierung wie
 * `@f451/markdown#parseMetadataSchema`, hier zusätzlich defensiv angewandt,
 * falls ein Aufrufer ein unsortiertes Schema übergibt) — formatiert je Feld
 * den zugehörigen Rohwert aus `metadata` und lässt Felder ohne Wert weg.
 *
 * Kein Schema (`null`/`undefined`) oder ein Schema ohne Felder → leere Liste;
 * die Rail zeigt dann KEINEN zusätzlichen Metadaten-Block (Fallback,
 * identisch zum Verhalten vor Feature M2).
 *
 * Ein Schema-Feld mit `key: 'status'` (z. B. ein Prozess-Status aus
 * `_meta/schema.yaml`) ist ein GEWÖHNLICHER Eintrag dieser Liste — er wird
 * nicht mit der fest verdrahteten Workflow-Status-Zeile der Rail
 * (`RailProps.status`, Released/Entwurf/…) zusammengeführt oder verwechselt;
 * beide werden unabhängig voneinander mit ihrem jeweils eigenen Label
 * gerendert (s. `rail.tsx`).
 */
export function buildMetadataView(
  schema: MetadataSchema | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  locale: Locale,
): MetadataViewEntry[] {
  if (!schema || schema.fields.length === 0) return []
  const values = metadata ?? {}

  const ordered = schema.fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const orderA = a.field.order ?? a.index
      const orderB = b.field.order ?? b.index
      if (orderA !== orderB) return orderA - orderB
      return a.index - b.index
    })

  const entries: MetadataViewEntry[] = []
  for (const { field } of ordered) {
    const entry = formatMetadataField(field, values[field.key], locale)
    if (entry) entries.push(entry)
  }
  return entries
}
