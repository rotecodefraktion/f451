export interface ExportedPage {
  pageId: string
  name: string
  bsId: number
}

export interface ExportReport {
  created: ExportedPage[]
  updated: ExportedPage[]
  failed: Array<{ pageId: string; name: string; reason: string }>
  /** Unresolved wikilinks, exported as plain text. */
  brokenLinks: number
  /** BookStack pages of the target book tagged with the space but not part of this export. Never deleted. */
  stale: Array<{ bsId: number; name: string }>
  /** `_media/` references that f451 does not have (404); the link is left as is. */
  /** Files not found in f451 (no reason) or refused by BookStack (reason). */
  missingMedia: Array<{ pageId: string; ref: string; reason?: string }>
  /** Dry run only: the rendered HTML per page. */
  dryRunPages?: Array<{ pageId: string; name: string; html: string }>
}

export function emptyExportReport(): ExportReport {
  return { created: [], updated: [], failed: [], brokenLinks: 0, stale: [], missingMedia: [] }
}

function section<T>(title: string, rows: T[], line: (row: T) => string): string {
  if (rows.length === 0) return ''
  return `## ${title} (${rows.length})\n\n${rows.map((r) => `- ${line(r)}`).join('\n')}\n\n`
}

export function renderExportReport(r: ExportReport): string {
  let out = '# Export report\n\n'
  if (r.dryRunPages) {
    out += `Dry run: rendered ${r.dryRunPages.length} pages, failed ${r.failed.length}, broken links ${r.brokenLinks}. Nothing was written to BookStack.\n\n`
  } else {
    out += `Created ${r.created.length}, updated ${r.updated.length}, failed ${r.failed.length}, broken links ${r.brokenLinks}, stale ${r.stale.length}.\n\n`
  }
  const page = (p: ExportedPage) => `${p.name} (${p.pageId}) → BookStack page ${p.bsId}`
  out += section('Failed', r.failed, (f) => `${f.name} (${f.pageId}): ${f.reason}`)
  out += section('Created', r.created, page)
  out += section('Updated', r.updated, page)
  out += section('Missing media', r.missingMedia, (m) => `${m.ref} on ${m.pageId}${m.reason ? `: ${m.reason}` : ''}`)
  out += section(
    'Stale BookStack pages (not deleted)',
    r.stale,
    (s) => `${s.name} (BookStack page ${s.bsId})`,
  )
  if (r.dryRunPages) out += section('Rendered', r.dryRunPages, (p) => `${p.name} (${p.pageId})`)
  return out
}
