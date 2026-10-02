import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { RELATION_TYPES_DEFAULT } from './types.js'
import { CLASSIFICATIONS, isClassification } from './classification.js'
import type { ChangelogEntry, PageFrontmatter, ParseOptions } from './types.js'

/** Bekannte Top-Level-Frontmatter-Felder — alles andere landet in
 *  `frontmatter.metadata` (s. Kommentar dort und am Ende dieser Funktion).
 *  EXPORTIERT (Befund 2, Final-Review Seitenversionierung Etappe 1): der
 *  Metadaten-Schema-Parser (`schema.ts#parseField`) muss dieselbe Liste kennen,
 *  um zu verhindern, dass ein Space-Schema ein Feld mit einem dieser reservierten
 *  Namen (z. B. `version`) deklariert — sonst würde ein Feldwert still im
 *  Metadaten-Passthrough verschwinden (er landet nie in `frontmatter.metadata`,
 *  s. unten) und beim nächsten Speichern über das Metadaten-Formular aus der
 *  Datei entfernt (Datenverlust in Git). EINE Quelle für beide Module, damit die
 *  Listen nicht auseinanderlaufen können — s. `schema.ts#RESERVED_METADATA_KEY_ERROR`. */
export const KNOWN_FRONTMATTER_KEYS = new Set([
  'id', 'title', 'description', 'tags', 'lang', 'relations', 'archived',
  'version', 'changelog', 'classification',
])

/** Parst und validiert einen YAML-Frontmatter-Block. Wirft nie — Fehler werden
 *  gesammelt und separat zurückgegeben, ungültige/fehlende Felder bleiben leer. */
export function parseFrontmatterBlock(
  yamlText: string,
  opts?: ParseOptions,
): { frontmatter: PageFrontmatter; errors: string[] } {
  const emptyFrontmatter: PageFrontmatter = { tags: [], relations: {} }

  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { frontmatter: emptyFrontmatter, errors: [`YAML-Syntaxfehler: ${message}`] }
  }

  const isPlainObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  const data: Record<string, unknown> = isPlainObject ? (raw as Record<string, unknown>) : {}

  const errors: string[] = []
  const frontmatter: PageFrontmatter = { tags: [], relations: {} }

  // Nicht-Objekt-Toplevel (Liste/Skalar) ist ungültiges Frontmatter — außer leerer
  // String/null, die ein leeres/fehlendes Frontmatter darstellen (kein Fehler).
  if (!isPlainObject && raw !== null && raw !== '') {
    errors.push('Frontmatter: muss ein Objekt sein')
  }

  if (data.id !== undefined) {
    if (typeof data.id === 'string') {
      frontmatter.id = data.id
    } else {
      errors.push('id: muss ein String sein')
    }
  }

  if (data.title !== undefined) {
    if (typeof data.title === 'string') {
      frontmatter.title = data.title
    } else {
      errors.push('title: muss ein String sein')
    }
  }

  if (data.description !== undefined) {
    if (typeof data.description === 'string') {
      frontmatter.description = data.description
    } else {
      errors.push('description: muss ein String sein')
    }
  }

  if (data.tags !== undefined) {
    if (Array.isArray(data.tags)) {
      const strings = data.tags.filter((t): t is string => typeof t === 'string')
      if (strings.length !== data.tags.length) {
        errors.push('tags: muss eine Liste von Strings sein')
      }
      frontmatter.tags = strings
    } else {
      errors.push('tags: muss eine Liste von Strings sein')
    }
  }

  if (data.lang !== undefined) {
    if (typeof data.lang === 'string') {
      frontmatter.lang = data.lang
    } else {
      errors.push('lang: muss ein String sein')
    }
  }

  if (data.archived !== undefined) {
    if (typeof data.archived === 'boolean') {
      frontmatter.archived = data.archived
    } else {
      errors.push('archived: muss ein Boolean sein')
    }
  }

  if (data.classification !== undefined) {
    if (isClassification(data.classification)) {
      frontmatter.classification = data.classification
    } else {
      errors.push(`classification: must be one of ${CLASSIFICATIONS.join(', ')}`)
    }
  }

  if (data.relations !== undefined) {
    const allowed: readonly string[] = opts?.relationTypes ?? RELATION_TYPES_DEFAULT

    if (
      data.relations !== null &&
      typeof data.relations === 'object' &&
      !Array.isArray(data.relations)
    ) {
      const relationsData = data.relations as Record<string, unknown>
      for (const [type, value] of Object.entries(relationsData)) {
        if (!allowed.includes(type)) {
          errors.push(`relations: unbekannter Typ "${type}"`)
          continue
        }
        if (Array.isArray(value)) {
          const strings = value.filter((v): v is string => typeof v === 'string')
          if (strings.length !== value.length) {
            errors.push(`relations: "${type}" muss eine Liste von Strings sein`)
          }
          frontmatter.relations[type] = strings
        } else {
          errors.push(`relations: "${type}" muss eine Liste von Strings sein`)
        }
      }
    } else {
      errors.push('relations: muss ein Objekt sein')
    }
  }

  if (data.version !== undefined) {
    if (typeof data.version === 'string' && data.version.trim().length > 0) {
      frontmatter.version = data.version.trim()
    } else {
      errors.push('version: muss eine Zeichenkette sein')
    }
  }

  if (data.changelog !== undefined) {
    if (!Array.isArray(data.changelog)) {
      errors.push('changelog: muss eine Liste sein')
    } else {
      const entries: ChangelogEntry[] = []
      data.changelog.forEach((raw, index) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          errors.push(`changelog[${index}]: muss ein Objekt sein`)
          return
        }
        const entry = raw as Record<string, unknown>
        const text = (key: string): string | undefined =>
          typeof entry[key] === 'string' && (entry[key] as string).trim().length > 0
            ? (entry[key] as string).trim()
            : undefined
        const version = text('version')
        const date = text('date')
        const author = text('author')
        // `note` ist OPTIONAL: die Freigabe-Route (`routes/workflow.ts`) schreibt
        // bei einer Freigabe ohne Kommentar `note: ""`. Würde der Parser den
        // Eintrag deswegen verwerfen, trüge die Seite dauerhaft einen
        // Verarbeitungsfehler, den niemand beseitigen kann — `version`/`changelog`
        // sind systemverwaltet und über den Editor nicht änderbar. Leerer,
        // fehlender und nicht-string Wert werden gleich behandelt (leere Notiz).
        const note = typeof entry.note === 'string' ? entry.note.trim() : ''
        if (!version || !date || !author) {
          errors.push(`changelog[${index}]: version, date und author sind Pflicht`)
          return
        }
        const ref = text('ref')
        entries.push({ version, date, author, note, ...(ref ? { ref } : {}) })
      })
      // Fail-Soft wie der Rest des Parsers: gültige Einträge überleben, auch
      // wenn ein einzelner kaputt ist. Nur wenn NICHTS gültig war, bleibt das
      // Feld undefined statt eine leere Liste vorzutäuschen.
      if (entries.length > 0) frontmatter.changelog = entries
    }
  }

  // Übrige Top-Level-Felder (Metadaten-Feature M1, `_meta/schema.yaml`, s.
  // schema.ts): unbekannt für DIESE Schicht — sie werden roh nach `metadata`
  // durchgereicht statt verworfen zu werden, damit spätere Schema-getriebene
  // Felder (SAP-Prozess-Doku: Process ID, Approved by, …) im Frontmatter
  // erhalten bleiben. Keine Typprüfung hier (Sache der Schema-Validierung/UI);
  // `metadata` bleibt `undefined` (statt `{}`), wenn keine solchen Felder
  // vorkommen — bestehende Frontmatter-Objekte ändern sich dadurch nicht.
  if (isPlainObject) {
    const extraKeys = Object.keys(data).filter((key) => !KNOWN_FRONTMATTER_KEYS.has(key))
    if (extraKeys.length > 0) {
      const metadata: Record<string, unknown> = {}
      for (const key of extraKeys) metadata[key] = data[key]
      frontmatter.metadata = metadata
    }
  }

  return { frontmatter, errors }
}

/**
 * Gegenstück zu `parseFrontmatterBlock`: serialisiert Frontmatter-Felder YAML-sicher.
 * Werte mit `:`, führendem `-`/`@`/`*`, Quotes o. ä. brechen als naive
 * String-Interpolation (`` `title: ${value}` ``) einen `YAMLException` beim erneuten
 * Parsen aus — die `yaml`-Bibliothek quotet/escaped sie stattdessen automatisch
 * korrekt. Gedacht für Stellen, die einen Frontmatter-Block aus wenigen bekannten
 * Feldern bauen (z. B. `drafts/create-page.ts`s Initialinhalt einer neuen Seite),
 * damit deren Ausgabe garantiert wieder fehlerfrei durch `parseFrontmatterBlock`
 * geht. Gibt NUR die YAML-Zeile(n) zurück (kein `---`-Rahmen, kein Trailing-
 * Newline) — der Aufrufer baut den vollständigen Frontmatter-Block selbst.
 */
export function stringifyFrontmatterBlock(data: Record<string, unknown>): string {
  return stringifyYaml(data).trimEnd()
}
