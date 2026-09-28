import type { MetadataSchema } from '@f451/markdown'

/**
 * Reine Ableitungslogik für `type: auto`-Felder (Metadaten-Feature M3b
 * Teil A, `routes/pages.ts#GET /api/pages/:id`): kombiniert das Space-Schema
 * mit den bereits bekannten Ableitungsquellen (Index-`updatedAt`,
 * `pages.lastAuthor`) zu einem vollständigen `metadata`-Objekt, OHNE dass die
 * auto-Werte im Frontmatter der Seite selbst stehen müssen (Nutzer-
 * Entscheidung: `last_author`/`last_updated` sind automatisch, nicht manuell
 * editierbar — s. `@f451/markdown#schema.ts`-Modulkommentar).
 *
 * Bewusst DOM-/DB-/Provider-frei (keine IO hier) — der Aufrufer (Route) holt
 * `schema` (`spaces/metadata-schema.ts#loadMetadataSchema`, gecacht) und
 * `source` (aus der bereits geladenen `pages`-Zeile) VOR dem Aufruf.
 */

/** Bereits ermittelte Ableitungswerte für die `auto`-Felder EINER Seite. */
export interface AutoMetadataSource {
  /**
   * Autor des letzten main-Commits (`pages.lastAuthor`, s. `db/schema.ts`-
   * Spaltenkommentar) — `null`, wenn (noch) unbekannt (Seite kam nur über
   * einen Voll-Reindex in den Index, s. `index-space.ts`s Kompromiss-
   * Kommentar). Ein `null`-Wert überschreibt NIE einen im Frontmatter bereits
   * stehenden Alt-Wert (s. {@link applyAutoMetadata}).
   */
  lastAuthor: string | null
  /** `pages.updatedAt` als ISO-8601-String (`GET /api/pages/:id`s `updatedAt`-
   *  Feld, s. `routes/pages.ts`) — IMMER bekannt, überschreibt daher IMMER
   *  einen evtl. veralteten Frontmatter-Wert für `source: 'last_updated'`. */
  lastUpdatedIso: string
}

/**
 * Setzt die `auto`-Felder des Schemas mit den abgeleiteten Werten in ein
 * Metadaten-Objekt ein (Kopie — `metadata` bleibt unverändert):
 *  - `source: 'last_updated'`: IMMER überschrieben (der Index-Zeitstempel ist
 *    per Definition aktuell).
 *  - `source: 'last_author'`: NUR überschrieben, wenn `source.lastAuthor`
 *    bekannt ist (`!== null`) — ist er unbekannt, bleibt ein evtl. bereits im
 *    Frontmatter stehender (potenziell veralteter) Wert unangetastet statt
 *    stillschweigend gelöscht zu werden; gibt es auch dort keinen, fehlt der
 *    Schlüssel schlicht (die Rail/M2 blendet ihn dann aus, s.
 *    `apps/web/lib/metadata-view.ts#isEmptyValue`).
 *
 * Felder, die NICHT `type: auto` sind, bleiben unverändert (Nutzer-Werte,
 * z. B. `approved_by`/`process_id`).
 */
export function applyAutoMetadata(
  schema: MetadataSchema,
  metadata: Record<string, unknown>,
  source: AutoMetadataSource,
): Record<string, unknown> {
  const result = { ...metadata }
  for (const field of schema.fields) {
    if (field.type !== 'auto') continue
    if (field.source === 'last_updated') {
      result[field.key] = source.lastUpdatedIso
    } else if (field.source === 'last_author' && source.lastAuthor !== null) {
      result[field.key] = source.lastAuthor
    }
  }
  return result
}
