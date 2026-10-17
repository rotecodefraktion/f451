import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { ExportTarget } from '../soffice.js'
import { exportFileName, exportOffice } from './index.js'
import { NoTablesError } from './fods.js'
import type { ExportF451Reader } from './load.js'
import { node } from './test-helpers.js'

const roots = [node('start', 'Plan A/B: "Q4" Ü', [node('child', 'Child')])]

const f451: ExportF451Reader = {
  tree: async () => roots,
  raw: async (id) =>
    id === 'start'
      ? '## Slide\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![gone](_media/gone.png)'
      : '## Child slide\n\ntext',
  media: async () => null,
}

function stubConverter() {
  const calls: Array<{ zip: Uint8Array; to: ExportTarget; timeoutS?: number }> = []
  return {
    calls,
    converter: {
      async fromBundle(zip: Uint8Array, to: ExportTarget, opts?: { timeoutS?: number }) {
        calls.push({ zip, to, timeoutS: opts?.timeoutS })
        return new Uint8Array([7])
      },
    },
  }
}

const base = { space: 'space', pageId: 'start', subpages: true, publicBaseUrl: 'https://wiki.example' }

describe('exportOffice', () => {
  it.each([
    ['docx', 'document.html'],
    ['pdf', 'document.html'],
    ['pptx', 'document.fodp'],
    ['xlsx', 'document.fods'],
  ] as const)('sends a %s bundle with %s to the converter', async (format, doc) => {
    const { calls, converter } = stubConverter()
    const result = await exportOffice(f451, converter, { ...base, format, timeoutS: 600 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toBe(format)
    expect(calls[0]!.timeoutS).toBe(600)
    const files = unzipSync(calls[0]!.zip)
    expect(Object.keys(files)).toContain(doc)
    expect(strFromU8(files[doc]!)).toContain('Slide')
    expect(result.file).toEqual(new Uint8Array([7]))
    expect(result.fileName).toBe(`Plan A_B_ _Q4_ Ü.${format}`)
    expect(result.report.pages).toBe(2)
    expect(result.report.droppedMedia).toEqual(['Plan A/B: "Q4" Ü: _media/gone.png'])
  })

  it('fails with NoTablesError for xlsx without tables, before converting', async () => {
    const { calls, converter } = stubConverter()
    const noTables: ExportF451Reader = { ...f451, raw: async () => 'text' }
    await expect(exportOffice(noTables, converter, { ...base, format: 'xlsx' })).rejects.toBeInstanceOf(NoTablesError)
    expect(calls).toHaveLength(0)
  })

  it('stops before the conversion when aborted', async () => {
    const { calls, converter } = stubConverter()
    const controller = new AbortController()
    controller.abort()
    await expect(exportOffice(f451, converter, { ...base, format: 'docx', signal: controller.signal })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('exportFileName', () => {
  it('replaces characters invalid in file names', () => {
    expect(exportFileName('a<b>c|d?e*', 'pdf')).toBe('a_b_c_d_e_.pdf')
    expect(exportFileName('  ', 'docx')).toBe('export.docx')
    expect(exportFileName('Ends with dot.', 'xlsx')).toBe('Ends with dot.xlsx')
  })
})
