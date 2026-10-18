import { describe, expect, it } from 'vitest'
import { emptyExportReport, renderExportReport } from './export/bookstack/report.js'
import { emptyReport, renderReport } from './report.js'

describe('renderReport', () => {
  it('lists failures first and omits empty sections', () => {
    const r = emptyReport()
    r.created.push({ sourceId: '1', title: 'A', pageId: 'p-a' })
    r.failed.push({ sourceId: '2', title: 'B', reason: 'title empty' })
    const out = renderReport(r)
    expect(out.indexOf('## Failed')).toBeLessThan(out.indexOf('## Created'))
    expect(out).toContain('- B (2): title empty')
    expect(out).toContain('- A (1) → p-a')
    expect(out).not.toContain('## Skipped')
    expect(out).not.toContain('## Cancelled')
    expect(out).not.toContain('cancelled')
  })

  it('lists cancelled pages and counts them in the summary', () => {
    const r = emptyReport()
    r.created.push({ sourceId: '1', title: 'A', pageId: 'p-a' })
    r.cancelled.push({ sourceId: '2', title: 'B', pageId: 'p-b', reason: 'cancelled before content, draft discarded' })
    r.cancelled.push({ sourceId: '3', title: 'C', reason: 'cancelled' })
    const out = renderReport(r)
    expect(out).toContain('Created 1, updated 0, skipped 0, failed 0, cancelled 2.')
    expect(out).toContain('## Cancelled (2)')
    expect(out).toContain('- B (2) → p-b: cancelled before content, draft discarded')
    expect(out).toContain('- C (3): cancelled')
  })

  it('names the previous title of a renamed page', () => {
    const r = emptyReport()
    r.updated.push({ sourceId: '1', title: 'New', pageId: 'p-a', previousTitle: 'Old' })
    r.updated.push({ sourceId: '2', title: 'Same', pageId: 'p-b' })
    const out = renderReport(r)
    expect(out).toContain('- New (was "Old") (1) → p-a')
    expect(out).toContain('- Same (2) → p-b')
  })

  it('shows the file-import sections only when present', () => {
    const r = emptyReport()
    const plain = renderReport(r)
    expect(plain).not.toContain('Frontmatter')
    expect(plain).not.toContain('without a target')
    expect(plain).not.toContain('Ambiguous')
    expect(plain).not.toContain('Attachments')
    r.droppedFrontmatter = { aliases: 2 }
    r.unresolved = [{ sourceId: 'obsidian:a.md', target: 'Missing' }]
    r.ambiguous = [{ sourceId: 'obsidian:a.md', target: 'Dup', chosen: 'x/Dup.md' }]
    r.unreferenced = ['attachments/old.png']
    const out = renderReport(r)
    expect(out).toContain('- `aliases`: 2')
    expect(out).toContain('## Links without a target (kept as text) (1)')
    expect(out).toContain('- Missing on obsidian:a.md')
    expect(out).toContain('- Dup on obsidian:a.md → x/Dup.md')
    expect(out).toContain('- attachments/old.png')
  })

  it('lists sheets cut at the row limit only when present', () => {
    const r = emptyReport()
    expect(renderReport(r)).not.toContain('row limit')
    r.truncated = [{ sourceId: 'office:book.xlsx@1', sheet: 'Daten', rows: 2500 }]
    const out = renderReport(r)
    expect(out).toContain('## Sheets cut at the row limit (1)')
    expect(out).toContain('- Daten on office:book.xlsx@1: 2500 rows')
  })
})

describe('renderExportReport', () => {
  it('lists cancelled pages and counts them in the summary only when present', () => {
    const r = emptyExportReport()
    expect(renderExportReport(r)).not.toContain('ancelled')
    r.cancelled.push({ pageId: 'p-x', name: 'X', reason: 'cancelled, placeholder page deleted' })
    const out = renderExportReport(r)
    expect(out).toContain('failed 0, cancelled 1, broken links 0')
    expect(out).toContain('## Cancelled (1)')
    expect(out).toContain('- X (p-x): cancelled, placeholder page deleted')
  })
})
