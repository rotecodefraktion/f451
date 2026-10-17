import { describe, expect, it } from 'vitest'
import { NoTablesError, buildFods, classifyCell, sheetName } from './fods.js'
import { page, wellFormedRoot } from './test-helpers.js'

describe('sheetName', () => {
  it('removes invalid characters, cuts to 31 and makes names unique', () => {
    const used = new Set<string>()
    expect(sheetName('Q1: [Plan] a/b\\c*?', used)).toBe('Q1 Plan abc')
    const long = 'A very long heading that goes on and on'
    expect(sheetName(long, used)).toBe('A very long heading that goes o')
    expect(sheetName(long, used)).toBe('A very long heading that go (2)')
    expect(sheetName('q1 plan abc', used)).toBe('q1 plan abc (2)')
    expect(sheetName("'quoted'", used)).toBe('quoted')
    expect(sheetName('[]', used)).toBe('Sheet')
    expect(sheetName('Grüße "x"', used)).toBe('Grüße "x"')
  })
})

describe('classifyCell', () => {
  it('reads plain numbers with one separator as the decimal sign', () => {
    expect(classifyCell('42')).toEqual({ type: 'float', value: 42 })
    expect(classifyCell('-3,5')).toEqual({ type: 'float', value: -3.5 })
    expect(classifyCell('1.25')).toEqual({ type: 'float', value: 1.25 })
  })

  it('reads thousands separators with the last separator as the decimal sign', () => {
    expect(classifyCell('1.234,5')).toEqual({ type: 'float', value: 1234.5 })
    expect(classifyCell('1,234.5')).toEqual({ type: 'float', value: 1234.5 })
    expect(classifyCell('12.345.678,90')).toEqual({ type: 'float', value: 12345678.9 })
  })

  it('reads percentages and ISO dates', () => {
    expect(classifyCell('12 %')).toEqual({ type: 'percentage', value: 0.12, decimals: 0 })
    expect(classifyCell('12,5%')).toEqual({ type: 'percentage', value: 0.125, decimals: 1 })
    expect(classifyCell('2026-10-16')).toEqual({ type: 'date', value: '2026-10-16' })
  })

  it('keeps everything that only looks like a number as text', () => {
    for (const s of ['1.2.3', '0049 170 1234567', '0049', '2026-02-30', '12345678901234567890', '1.234.567', '1,2,3', 'x12', '12 € ', '%', '']) {
      expect(classifyCell(s)).toEqual({ type: 'string' })
    }
  })
})

describe('buildFods', () => {
  const table = '| Name | Amount | Share | Date |\n|---|---|---|---|\n| A & B | 1.234,5 | 12 % | 2026-10-16 |\n| 1.2.3 | 0049 170 1234567 | x | y |'

  it('makes one sheet per table, named after the nearest heading or the page title', () => {
    const xml = buildFods([
      page('start', 'Report', 0, `${table}\n\n## Costs\n\n${table}\n\n## Costs\n\n${table}`),
      page('child', 'Child', 1, table),
    ])
    expect(wellFormedRoot(xml)).toBe('office:document')
    expect(xml).toContain('office:mimetype="application/vnd.oasis.opendocument.spreadsheet"')
    const names = [...xml.matchAll(/<table:table table:name="([^"]*)"/g)].map((m) => m[1])
    expect(names).toEqual(['Report', 'Costs', 'Costs (2)', 'Child'])
  })

  it('writes a bold header row and typed values', () => {
    const xml = buildFods([page('start', 'Report', 0, table)])
    expect(xml).toContain('<table:table-cell table:style-name="ce-head" office:value-type="string"><text:p>Name</text:p></table:table-cell>')
    expect(xml).toMatch(/<style:style style:name="ce-head" style:family="table-cell"><style:text-properties fo:font-weight="bold"/)
    expect(xml).toContain('<table:table-cell office:value-type="string"><text:p>A &amp; B</text:p></table:table-cell>')
    expect(xml).toContain('<table:table-cell office:value-type="float" office:value="1234.5"><text:p>1.234,5</text:p></table:table-cell>')
    expect(xml).toContain('table:style-name="ce-pct0" office:value-type="percentage" office:value="0.12"')
    expect(xml).toContain('office:value-type="date" office:date-value="2026-10-16"')
    expect(xml).toContain('<table:table-cell office:value-type="string"><text:p>1.2.3</text:p></table:table-cell>')
    expect(xml).toContain('<table:table-cell office:value-type="string"><text:p>0049 170 1234567</text:p></table:table-cell>')
    expect(xml).toContain('<number:percentage-style style:name="N-pct0">')
  })

  it('throws NoTablesError without tables', () => {
    expect(() => buildFods([page('start', 'Report', 0, 'Just text')])).toThrow(NoTablesError)
  })
})
