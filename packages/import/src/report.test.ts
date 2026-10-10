import { describe, expect, it } from 'vitest'
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
  })
})
