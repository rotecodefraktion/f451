import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_EXPORT_BYTES, fileNameFromDisposition, registerReadTools } from '../src/tools/read.js'
import { authExtra, callOf, fakeServer, mockFetch, respond, textOf, type ToolResult } from './naht.js'

/** `export_page` über die gemeinsame Naht (s. `naht.ts`): echter Handler, echter Client, nur `fetch` ersetzt. */
function exportTool() {
  const { server, handlers } = fakeServer()
  registerReadTools(server as never)
  return handlers.get('export_page')!
}

function fileResponse(bytes: Uint8Array, headers: Record<string, string>): Response {
  return new Response(bytes, { status: 200, headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('export_page', () => {
  it('fragt die Export-Route ab und liefert die Datei als eingebettete Ressource', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3])
    const spy = mockFetch([
      fileResponse(bytes, {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `attachment; filename="Uebersicht.docx"; filename*=UTF-8''%C3%9Cbersicht.docx`,
      }),
    ])
    const result = (await exportTool()({ page_id: 'p-1', format: 'docx', subpages: true }, authExtra)) as unknown as {
      content: { type: string; resource?: { uri: string; mimeType: string; blob: string } }[]
      isError?: boolean
    }

    const { url } = callOf(spy)
    expect(url.pathname).toBe('/api/pages/p-1/export')
    expect(url.searchParams.get('format')).toBe('docx')
    expect(url.searchParams.get('subpages')).toBe('1')

    expect(result.isError).toBeUndefined()
    const resource = result.content.find((c) => c.type === 'resource')!.resource!
    expect(resource.mimeType).toContain('wordprocessingml')
    expect(resource.uri).toContain(encodeURIComponent('Übersicht.docx'))
    expect(Buffer.from(resource.blob, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('sendet subpages=0, wenn nichts angegeben ist', async () => {
    const spy = mockFetch([fileResponse(new Uint8Array([1]), { 'content-type': 'application/pdf' })])
    await exportTool()({ page_id: 'p-1', format: 'pdf' }, authExtra)
    expect(callOf(spy).url.searchParams.get('subpages')).toBe('0')
  })

  it('verweist bei einer zu großen Datei auf den Export im Browser', async () => {
    mockFetch([fileResponse(new Uint8Array(MAX_EXPORT_BYTES + 1), { 'content-type': 'application/pdf' })])
    const result = (await exportTool()({ page_id: 'p-1', format: 'pdf' }, authExtra)) as ToolResult
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Import-/Export-Bereich')
  })

  it('verweist bei 413 auf den Export im Browser', async () => {
    mockFetch([respond(413, { status: 'payload_too_large', reason: 'too many pages' })])
    const result = (await exportTool()({ page_id: 'p-1', format: 'docx', subpages: true }, authExtra)) as ToolResult
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Import-/Export-Bereich')
  })
})

describe('fileNameFromDisposition', () => {
  it('bevorzugt filename* und verwirft Verzeichnisanteile', () => {
    expect(fileNameFromDisposition(`attachment; filename="a.docx"; filename*=UTF-8''%C3%84.docx`)).toBe('Ä.docx')
    expect(fileNameFromDisposition('attachment; filename="../../x.pdf"')).toBe('x.pdf')
    expect(fileNameFromDisposition(null)).toBeNull()
  })
})
