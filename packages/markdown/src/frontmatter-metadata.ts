import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { joinFrontmatter, splitFrontmatter } from './frontmatter-split.js'

/**
 * Schreibpfad fürs Metadaten-Erfass-Formular (Metadaten-Feature M3,
 * `apps/web/components/editor/metadata-panel.tsx`): setzt/entfernt einzelne
 * Top-Level-Frontmatter-Felder in einem bereits durch {@link splitFrontmatter}
 * abgetrennten `frontmatterRaw`-Block (Zäune + abschließender Zeilenumbruch
 * inklusive, s. `frontmatter-split.ts`) und liefert den neuen Block im selben
 * Format zurück — Body bleibt außen vor, der Aufrufer fügt beides über
 * {@link joinFrontmatter} wieder zusammen (identischer Vertrag wie der
 * bestehende Editor-Speicherpfad, s. `editor-root.tsx`).
 *
 * Bewusst NUR für die Metadaten-Schlüssel selbst zuständig (`key` aus
 * `MetadataField`, s. `schema.ts`) — die bekannten Top-Level-Felder
 * (`id`/`title`/`tags`/`lang`/`relations`/`archived`/`description`, s.
 * `frontmatter.ts#KNOWN_FRONTMATTER_KEYS`) werden nie berührt: sie stehen
 * bereits im geparsten YAML-Objekt und werden unverändert zurückgeschrieben,
 * solange kein Aufrufer sie über `metadataValues` selbst adressiert (dann
 * gilt für sie exakt dieselbe Set/Entfernen-Regel wie für jeden anderen
 * Schlüssel — diese Funktion kennt den Unterschied "bekannt" vs. "Metadaten"
 * nicht, das ist Sache der darüberliegenden Schema-/Parse-Schicht).
 *
 * WICHTIG (Kompromiss, bewusst): das YAML wird komplett neu geparst und neu
 * serialisiert (`yaml`-Paket, wie `frontmatter.ts`) — Kommentare,
 * Schlüsselreihenfolge-Feinheiten, Anführungszeichen-Stil etc. des
 * ursprünglichen Textes gehen dabei verloren. Strikte BYTE-Gleichheit des
 * Frontmatter-Blocks (wie sie `frontmatterRaw` sonst überall garantiert) gilt
 * hier ausdrücklich NICHT mehr — das ist beim strukturellen Bearbeiten über
 * ein Formular unvermeidbar und akzeptiert (Spec Metadaten-Feature M3). Der
 * BODY bleibt davon komplett unberührt (diese Funktion sieht ihn nie), und
 * das Ergebnis ist wieder valides `frontmatterRaw` — ein erneutes
 * `splitFrontmatter(joinFrontmatter(neu, body))` liefert exakt denselben
 * `body` zurück (s. Testdatei, Abschnitt „Integration").
 */

/** Zieht den YAML-Kern (ohne `---`-Zäune) aus einem `frontmatterRaw`-Block.
 *  Robust gegen alle Fälle aus `frontmatter-split.ts`s Roundtrip-Korpus:
 *  leeres Frontmatter (`---\n---\n`), fehlender abschließender Zeilenumbruch,
 *  CRLF. Kein Frontmatter (`frontmatterRaw === ''`) oder ein strukturell
 *  kaputter Block (keine erkennbare schließende `---`-Zeile) → `''` (leeres
 *  YAML, Fail-Soft-Philosophie wie `parseFrontmatterBlock`). Zeilenendungen
 *  werden dabei auf `\n` normalisiert — das ist unschädlich, weil das
 *  Ergebnis ohnehin durch `yaml`s `parse` läuft, nicht byte-identisch
 *  zurückgegeben wird (s. Modulkommentar oben). */
function extractYamlBody(frontmatterRaw: string): string {
  if (!frontmatterRaw.trim()) return ''

  const firstNewline = frontmatterRaw.indexOf('\n')
  if (firstNewline === -1) return ''

  const rest = frontmatterRaw.slice(firstNewline + 1)
  const lines = rest.split(/\r?\n/)

  // Die schließende `---`-Zeile ist die letzte NICHT-leere Zeile — davor darf
  // (muss aber nicht) genau eine leere Zeile stehen (Artefakt des
  // abschließenden Zeilenumbruchs, den `split` erzeugt).
  let closingIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === '---') {
      closingIndex = i
      break
    }
    if (lines[i] !== '') break
  }
  if (closingIndex === -1) return ''

  return lines.slice(0, closingIndex).join('\n')
}

/** `undefined`/`null`/leerer (getrimmter) String/leeres Array gelten als
 *  „kein Wert" — der Schlüssel wird dann aus dem Frontmatter ENTFERNT statt
 *  mit einem leeren Wert geschrieben (Spec: „leere → entfernen"). Dieselbe
 *  Konvention wie `lib/metadata-view.ts#isEmptyValue`. */
function isEmptyMetadataValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Setzt/entfernt Metadaten-Werte in einem `frontmatterRaw`-Block (s.
 * Modulkommentar oben für den vollständigen Vertrag).
 *
 * @param frontmatterRaw Aktueller Frontmatter-Block INKLUSIVE `---`-Zäune
 *   (Format von {@link splitFrontmatter}s `frontmatterRaw`) — auch `''`
 *   (Seite hatte bisher gar kein Frontmatter) ist gültig.
 * @param metadataValues Ein Eintrag pro zu setzendem/entfernendem Schlüssel.
 *   Werte, für die {@link isEmptyMetadataValue} zutrifft, entfernen den
 *   Schlüssel; alle anderen Werte werden 1:1 (roh) übernommen — Typ-/
 *   Formatkonvertierung (z. B. `multi` → Array von getrimmten Strings) ist
 *   Sache des Aufrufers (`lib/metadata-form.ts`), nicht dieser Funktion.
 * @returns Neuer `frontmatterRaw`-Block (`---\n…\n---\n`), oder `''`, wenn
 *   nach der Änderung kein Top-Level-Feld mehr übrig ist (kein leerer
 *   `---\n---\n`-Block ohne Inhalt).
 */
export function setFrontmatterMetadata(
  frontmatterRaw: string,
  metadataValues: Record<string, unknown>,
): string {
  const yamlBody = extractYamlBody(frontmatterRaw)

  let data: Record<string, unknown> = {}
  if (yamlBody.trim().length > 0) {
    try {
      const parsed: unknown = parseYaml(yamlBody)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = { ...(parsed as Record<string, unknown>) }
      }
    } catch {
      // Kaputtes YAML im Ausgangs-Frontmatter — Fail-Soft: die neuen Werte
      // gewinnen, statt dass der ganze Aufruf wirft (Philosophie wie
      // `parseFrontmatterBlock`, das ebenfalls nie wirft).
      data = {}
    }
  }

  for (const [key, value] of Object.entries(metadataValues)) {
    if (isEmptyMetadataValue(value)) {
      delete data[key]
    } else {
      data[key] = value
    }
  }

  if (Object.keys(data).length === 0) return ''

  const yamlText = stringifyYaml(data).trimEnd()
  return `---\n${yamlText}\n---\n`
}

/**
 * Stellt sicher, dass das Frontmatter die stabile Seiten-`id` trägt.
 *
 * Die `id` ist systemverwaltet und identifiziert eine Seite dauerhaft (s.
 * „Stabile IDs", `indexer/page-id.ts`/`derivePageId`). Verschwindet sie aus
 * dem Frontmatter — etwa weil ein Client (Editor, Import, MCP) den Inhalt
 * ohne das `id`-Feld speichert —, fällt die Indexierung nach dem Merge nach
 * `main` auf eine pfadbasierte Fallback-Id (`path:<space>/<datei>`) zurück.
 * Das kollidiert beim INKREMENTELLEN Reindex mit dem
 * `(space_id, path, ref)`-Unique-Constraint (die alte Zeile trägt denselben
 * Pfad, aber die stabile `id`) und lässt den `main`-Index STILL veralten
 * (der Duplicate-Key wird im Release-Pfad gefangen und nur geloggt).
 *
 * Diese Funktion erzwingt die `id` an der Schreibquelle (analog dazu, dass
 * die Draft-Indexierung die `id` bereits hart auf die `pageId` setzt,
 * `drafts/save.ts#indexDraftPage`). Der Inhalt bleibt BYTE-genau unverändert,
 * wenn die `id` bereits stimmt (Normalfall) — nur im Korrekturfall wird das
 * Frontmatter neu serialisiert.
 */
export function ensureFrontmatterId(markdown: string, pageId: string): string {
  const { frontmatterRaw, body } = splitFrontmatter(markdown)
  const yamlBody = extractYamlBody(frontmatterRaw)
  if (yamlBody.trim().length > 0) {
    let parsed: unknown
    try {
      parsed = parseYaml(yamlBody)
    } catch {
      // Kaputtes YAML NICHT anfassen: `setFrontmatterMetadata` würde bei einem
      // Parse-Fehler den gesamten (noch unparsbaren, aber vom Nutzer getippten)
      // Frontmatter-Inhalt verwerfen und nur `id:` zurückschreiben — stiller
      // Datenverlust. Der Fehler bleibt so als `parse_error`/`frontmatterErrors`
      // sichtbar und korrigierbar, und die Draft-/Reindex-Indexierung setzt die
      // `id` ohnehin hart auf `pageId` (s. `drafts/save.ts`, `incremental.ts`).
      return markdown
    }
    const currentId =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).id
        : undefined
    if (currentId === pageId) return markdown
  }
  // Kein Frontmatter (leerer YAML-Kern) ODER valides YAML mit fehlender/
  // abweichender id → `id` einfügen bzw. korrigieren.
  return joinFrontmatter(setFrontmatterMetadata(frontmatterRaw, { id: pageId }), body)
}
