export interface PageResult {
  sourceId: string
  title: string
  pageId?: string
  reason?: string
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
}

export function emptyReport(): ImportReport {
  return { created: [], updated: [], skipped: [], failed: [], cancelled: [], mediaSkipped: [], droppedHtml: {}, drawingsAsPng: [] }
}

function section(title: string, rows: PageResult[]): string {
  if (rows.length === 0) return ''
  const lines = rows.map((r) => `- ${r.title} (${r.sourceId})${r.pageId ? ` → ${r.pageId}` : ''}${r.reason ? `: ${r.reason}` : ''}`)
  return `## ${title} (${rows.length})\n\n${lines.join('\n')}\n\n`
}

export function renderReport(r: ImportReport): string {
  let out = '# Import report\n\n'
  const cancelled = r.cancelled.length ? `, cancelled ${r.cancelled.length}` : ''
  out += `Created ${r.created.length}, updated ${r.updated.length}, skipped ${r.skipped.length}, failed ${r.failed.length}${cancelled}.\n\n`
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
  if (r.drawingsAsPng.length) {
    out += `## Drawings kept as PNG (no draw.io container)\n\n` + r.drawingsAsPng.map((d) => `- ${d}`).join('\n') + '\n'
  }
  return out
}
