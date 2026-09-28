/** Response-Zeilen von `GET /api/spaces/:space/broken-links`
 *  (Vertrag: `apps/api/src/routes/broken-links.ts`, Doku in apps/api/README.md). */
export interface BrokenEntry {
  rawTarget: string
  type: 'link' | 'relation'
  label: string
}

export interface BrokenLinksReportRow {
  pageId: string
  title: string
  path: string
  entries: BrokenEntry[]
}

/** Menschlesbare Einordnung eines Report-Eintrags: Wikilinks/relative Links
 *  heißen „Verweis“, Frontmatter-Beziehungen tragen ihren Relationstyp. */
export function describeBrokenEntry(entry: BrokenEntry): string {
  return entry.type === 'relation' ? `Beziehung „${entry.label}“` : 'Verweis'
}
