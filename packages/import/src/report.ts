export interface PageResult {
  sourceId: string
  title: string
  pageId?: string
  reason?: string
  /** Updated pages only: the title the page had before, when it changed. */
  previousTitle?: string
}

export interface ImportReport {
  created: PageResult[]
  updated: PageResult[]
  skipped: PageResult[]
  failed: PageResult[]
  /** Pages not processed because the run was cancelled. */
  cancelled: PageResult[]
  mediaSkipped: Array<{ sourceId: string; name: string; reason: string }>
  droppedHtml: Record<string, number>
  drawingsAsPng: string[]
  droppedFrontmatter?: Record<string, number>
  unreferenced?: string[]
  unresolved?: Array<{ sourceId: string; target: string }>
  ambiguous?: Array<{ sourceId: string; target: string; chosen: string }>
  truncated?: Array<{ sourceId: string; sheet: string; rows: number }>
  warnings?: Array<{ sourceId: string; title: string; kind: string; detail: string }>
}

export function emptyReport(): ImportReport {
  return { created: [], updated: [], skipped: [], failed: [], cancelled: [], mediaSkipped: [], droppedHtml: {}, drawingsAsPng: [] }
}

function section(title: string, rows: PageResult[]): string {
  if (rows.length === 0) return ''
  const lines = rows.map((r) => `- ${r.title}${r.previousTitle ? ` (was "${r.previousTitle}")` : ''} (${r.sourceId})${r.pageId ? ` → ${r.pageId}` : ''}${r.reason ? `: ${r.reason}` : ''}`)
  return `## ${title} (${rows.length})\n\n${lines.join('\n')}\n\n`
}

export function renderReport(r: ImportReport): string {
  let out = '# Import report\n\n'
  const cancelled = r.cancelled.length ? `, cancelled ${r.cancelled.length}` : ''
  out += `Created ${r.created.length}, updated ${r.updated.length}, skipped ${r.skipped.length}, failed ${r.failed.length}${cancelled}.\n\n`
  if (r.warnings?.length) {
    out += `## Warnings (${r.warnings.length})\n\n` + r.warnings.map((w) => `- ${w.title} (${w.sourceId}) [${w.kind}]: ${w.detail}`).join('\n') + '\n\n'
  }
  out += section('Failed', r.failed) + section('Cancelled', r.cancelled) + section('Created', r.created) + section('Updated', r.updated) + section('Skipped', r.skipped)
  if (r.mediaSkipped.length) {
    out += `## Media skipped (${r.mediaSkipped.length})\n\n` + r.mediaSkipped.map((m) => `- ${m.name} on ${m.sourceId}: ${m.reason}`).join('\n') + '\n\n'
  }
  const dropped = Object.entries(r.droppedHtml)
  if (dropped.length) {
    // Keys are HTML tag names (`span`, `!--` for comments) or constructs
    // such as `colspan` and `tableBlock`.
    out += '## Content without a Markdown equivalent\n\n' + dropped.map(([t, n]) => `- \`${t}\`: ${n}`).join('\n') + '\n\n'
  }
  const frontmatter = Object.entries(r.droppedFrontmatter ?? {})
  if (frontmatter.length) {
    out += '## Frontmatter fields dropped\n\n' + frontmatter.map(([k, n]) => `- \`${k}\`: ${n}`).join('\n') + '\n\n'
  }
  if (r.unresolved?.length) {
    out += `## Links without a target (kept as text) (${r.unresolved.length})\n\n` + r.unresolved.map((u) => `- ${u.target} on ${u.sourceId}`).join('\n') + '\n\n'
  }
  if (r.ambiguous?.length) {
    out += `## Ambiguous links (${r.ambiguous.length})\n\n` + r.ambiguous.map((a) => `- ${a.target} on ${a.sourceId} → ${a.chosen}`).join('\n') + '\n\n'
  }
  if (r.truncated?.length) {
    out += `## Sheets cut at the row limit (${r.truncated.length})\n\n` + r.truncated.map((t) => `- ${t.sheet} on ${t.sourceId}: ${t.rows} rows`).join('\n') + '\n\n'
  }
  if (r.unreferenced?.length) {
    out += `## Attachments no page references (${r.unreferenced.length})\n\n` + r.unreferenced.map((u) => `- ${u}`).join('\n') + '\n\n'
  }
  if (r.drawingsAsPng.length) {
    out += `## Drawings kept as PNG (no draw.io container)\n\n` + r.drawingsAsPng.map((d) => `- ${d}`).join('\n') + '\n'
  }
  return out
}
