/** Ein Eintrag der Versionshistorie im Frontmatter (Seitenversionierung).
 *  Wird bei jeder Freigabe vorangestellt; die Liste ist im Dokument auf die
 *  letzten 10 Einträge begrenzt (die vollständige Historie steht in
 *  `page_versions` und ist aus der Git-Historie rekonstruierbar). */
export interface ChangelogEntry {
  /** Semver-Version dieses Eintrags, z. B. '1.2.0'. */
  version: string
  /** Freigabedatum, ISO-Datum ohne Zeit (YYYY-MM-DD). */
  date: string
  /** Anzeigename der freigebenden Person. */
  author: string
  /** Änderungsnotiz, vom Freigebenden verfasst. */
  note: string
}

/** Validiertes Frontmatter einer Seite. Fehlende/ungültige Felder sind undefined
 *  bzw. leer — Fehler stehen separat in errors (die Pipeline wirft nie). */
export interface PageFrontmatter {
  id?: string
  title?: string
  /** Template-Beschreibung (Spec §6) — für normale Seiten optional und ungenutzt. */
  description?: string
  tags: string[]
  lang?: string
  relations: Record<string, string[]>
  archived?: boolean
  /**
   * Semver-Version der zuletzt FREIGEGEBENEN Fassung (Seitenversionierung).
   * Systemverwaltet: wird ausschließlich vom Release-Pfad gesetzt, eine
   * handgeschriebene Änderung im Editor wird bei der nächsten Freigabe
   * überschrieben. `undefined` = nie freigegeben oder Space unversioniert.
   */
  version?: string
  /** Versionshistorie, neueste zuerst. Ebenfalls systemverwaltet, s. `version`. */
  changelog?: ChangelogEntry[]
  /**
   * Alle Top-Level-Frontmatter-Felder, die keinem der obigen bekannten Felder
   * entsprechen (Metadaten-Feature M1, `_meta/schema.yaml`, s. `schema.ts`) —
   * z. B. `process_id`, `approved_by` einer SAP-Prozess-Seite. Roh-Werte, WIE
   * im YAML geschrieben: KEINE Validierung/Typprüfung gegen ein Schema hier
   * (das ist Sache der Schema-Route/UI, M2/M3) — diese Schicht reicht sie nur
   * durch, statt sie zu verwerfen. `undefined`, wenn es keine solchen Felder
   * gibt (nicht `{}`, damit bestehende Frontmatter-Objekte ohne Metadaten
   * strukturell unverändert bleiben, siehe frontmatter.ts).
   */
  metadata?: Record<string, unknown>
}

export const RELATION_TYPES_DEFAULT = ['depends_on', 'supersedes', 'implements'] as const

export interface ParseOptions {
  /** Erlaubte Relations-Typen (ersetzt den Default vollständig). */
  relationTypes?: readonly string[]
}

export interface ExtractedLink {
  /** Roh-Ziel wie im Dokument: 'betrieb/monitoring' (wikilink) oder '../monitoring/index.md' (relativ). */
  rawTarget: string
  kind: 'wikilink' | 'relative'
  /** Sichtbarer Text (bei Wikilinks ggf. Alias). */
  text: string
}

export interface PageHeading {
  depth: 1 | 2 | 3 | 4 | 5 | 6
  text: string
  slug: string
}

export interface ParsedPage {
  frontmatter: PageFrontmatter
  frontmatterErrors: string[]
  /** frontmatter.title, sonst erstes H1, sonst undefined. */
  title?: string
  links: ExtractedLink[]
  headings: PageHeading[]
}

/** Minimaler mdast-Root-Typ für den Editor-Zugang (Phase 2b, Task 1) — bewusst lokal
 *  definiert statt einer @types/mdast-Dependency, analog zu den lokalen mdast-Typen in
 *  parse.ts/render.ts. parseMarkdownTree/stringifyMarkdown reichen den Baum nur
 *  durch — die innere Struktur der Kinder ist für dieses Paket kein Vertrag, sondern
 *  bleibt Sache von remark/mdast-util-to-markdown. */
export interface MdastRoot {
  type: 'root'
  children: unknown[]
}
