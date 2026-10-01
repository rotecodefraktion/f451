/**
 * Reine (DOM-freie) Logik für die beiden neuen prominenten Editor-Widgets
 * „Titelfeld" (Feature 2) und „Archivieren"-Toggle (Feature 4): liest die
 * bekannten Top-Level-Frontmatter-Felder `title`/`archived` aus einem
 * `frontmatterRaw`-Block (Format von `@f451/markdown#splitFrontmatter`) für
 * die initiale/synchronisierte Anzeige. Analog zu
 * `lib/metadata-form.ts#rawMetadataFromFrontmatter`, hier für die BEKANNTEN
 * Felder statt der freien `metadata`-Restmenge.
 *
 * Der SCHREIBPFAD braucht KEIN eigenes Analogon: `@f451/markdown#setFrontmatterMetadata`
 * ist bereits vollständig generisch (setzt/entfernt JEDEN Top-Level-Schlüssel,
 * nicht nur `frontmatter.metadata`-Felder, s. dessen Modulkommentar/Testfall
 * „erhält bekannte Top-Level-Felder … unverändert") — `editor-root.tsx` ruft
 * sie direkt mit `{title: …}`/`{archived: …}` auf, kein zweiter Frontmatter-
 * Schreibmechanismus.
 */

import { parseFrontmatterBlock } from '@f451/markdown'

/** Zieht den YAML-Kern (ohne `---`-Zäune) aus einem `frontmatterRaw`-Block —
 *  identische Konvention wie `lib/metadata-form.ts#rawMetadataFromFrontmatter`. */
function extractYamlBody(frontmatterRaw: string): string {
  return frontmatterRaw.replace(/^---\r?\n/, '').replace(/\r?\n?---\r?\n?$/, '')
}

/** Aktueller Titel eines `frontmatterRaw`-Blocks — `''`, wenn kein `title`-Feld
 *  gesetzt ist (kontrollierter React-Input braucht einen definierten
 *  Ausgangswert, Muster `lib/metadata-form.ts#initialFieldValue`). */
export function titleFromFrontmatter(frontmatterRaw: string): string {
  if (!frontmatterRaw.trim()) return ''
  const { frontmatter } = parseFrontmatterBlock(extractYamlBody(frontmatterRaw))
  return frontmatter.title ?? ''
}

/** Aktueller Archiviert-Status eines `frontmatterRaw`-Blocks — `false`, wenn
 *  kein `archived`-Feld gesetzt ist (dieselbe Default-Semantik wie
 *  `@f451/markdown#parseFrontmatterBlock`/die `pages`-Tabelle,
 *  `db/schema.ts#archived`). */
export function archivedFromFrontmatter(frontmatterRaw: string): boolean {
  if (!frontmatterRaw.trim()) return false
  const { frontmatter } = parseFrontmatterBlock(extractYamlBody(frontmatterRaw))
  return frontmatter.archived ?? false
}

/** Raw `classification` value of the page, `''` when unset or invalid. */
export function classificationFromFrontmatter(frontmatterRaw: string): string {
  if (!frontmatterRaw.trim()) return ''
  const { frontmatter } = parseFrontmatterBlock(extractYamlBody(frontmatterRaw))
  return frontmatter.classification ?? ''
}
