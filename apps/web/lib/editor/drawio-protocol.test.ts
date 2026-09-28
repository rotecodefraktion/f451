import { describe, expect, it, vi } from 'vitest'
import { createDrawioProtocol, decodeSvgDataUri, drawioEmbedUrl } from './drawio-protocol'

const ORIGIN = 'http://localhost:8081'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile/&gt;"><rect/></svg>'
const SVG_URI = 'data:image/svg+xml;base64,' + Buffer.from(SVG, 'utf8').toString('base64')

function setup(initial = SVG) {
  const posted: Record<string, unknown>[] = []
  const callbacks = { getInitialContent: () => initial, onSave: vi.fn(), onExit: vi.fn() }
  const proto = createDrawioProtocol(ORIGIN, (msg) => posted.push(msg), callbacks)
  return { posted, callbacks, proto }
}
const msg = (data: object) => ({ origin: ORIGIN, data: JSON.stringify(data) })

describe('drawioEmbedUrl', () => {
  it('baut die Embed-URL mit JSON-Protokoll', () => {
    expect(drawioEmbedUrl('http://localhost:8081/')).toBe(
      'http://localhost:8081/?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&configure=1',
    )
  })
})

describe('decodeSvgDataUri', () => {
  it('dekodiert base64-SVG-Data-URIs (UTF-8)', () => {
    expect(decodeSvgDataUri(SVG_URI)).toBe(SVG)
  })
  it('lehnt fremde Data-URIs und Nicht-Data ab', () => {
    expect(decodeSvgDataUri('data:image/png;base64,AAAA')).toBeNull()
    expect(decodeSvgDataUri('https://example.com/x.svg')).toBeNull()
    expect(decodeSvgDataUri('data:image/svg+xml;utf8,<svg/>')).toBeNull()
  })
})

describe('createDrawioProtocol', () => {
  it('init → load mit Initialinhalt und autosave aus', () => {
    const { posted, proto } = setup()
    proto.handleMessage(msg({ event: 'init' }))
    expect(posted).toEqual([{ action: 'load', xml: SVG, autosave: 0 }])
  })
  it('save → export-Anforderung als xmlsvg', () => {
    const { posted, proto } = setup()
    proto.handleMessage(msg({ event: 'save', exit: true }))
    expect(posted).toEqual([{ action: 'export', format: 'xmlsvg' }])
  })
  it('export → onSave mit dekodiertem SVG-Text und gemerktem exit-Flag', () => {
    const { callbacks, proto } = setup()
    proto.handleMessage(msg({ event: 'save', exit: true }))
    proto.handleMessage(msg({ event: 'export', format: 'xmlsvg', data: SVG_URI }))
    expect(callbacks.onSave).toHaveBeenCalledWith(SVG, true)
  })
  it('configure → Konfiguration aus getConfig, ohne Callback eine leere', () => {
    const { posted, proto } = setup()
    proto.handleMessage(msg({ event: 'configure' }))
    expect(posted).toEqual([{ action: 'configure', config: {} }])

    const mitConfig: Array<Record<string, unknown>> = []
    const p2 = createDrawioProtocol(ORIGIN, (m) => mitConfig.push(m), {
      getInitialContent: () => '',
      onSave: () => {},
      onExit: () => {},
      getConfig: () => ({ defaultCustomLibraries: ['x'] }),
    })
    p2.handleMessage(msg({ event: 'configure' }))
    expect(mitConfig).toEqual([{ action: 'configure', config: { defaultCustomLibraries: ['x'] } }])
  })
  it('exit → onExit', () => {
    const { callbacks, proto } = setup()
    proto.handleMessage(msg({ event: 'exit' }))
    expect(callbacks.onExit).toHaveBeenCalled()
  })
  it('ignoriert fremde Origins und Nicht-JSON', () => {
    const { posted, callbacks, proto } = setup()
    proto.handleMessage({ origin: 'https://evil.example', data: JSON.stringify({ event: 'init' }) })
    proto.handleMessage({ origin: ORIGIN, data: 12345 })
    proto.handleMessage({ origin: ORIGIN, data: 'kein json {' })
    expect(posted).toEqual([])
    expect(callbacks.onExit).not.toHaveBeenCalled()
  })
  it('export mit invalidem Data-URI → kein onSave (kein stiller Datenverlust: Dialog bleibt offen)', () => {
    const { callbacks, proto } = setup()
    proto.handleMessage(msg({ event: 'save', exit: true }))
    proto.handleMessage(msg({ event: 'export', format: 'xmlsvg', data: 'data:image/png;base64,AA' }))
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  // Regressionsschutz für einen per manuellem Smoke gegen den echten
  // jgraph/drawio-Container (Task 4, Step 6) gefundenen Fund: der reale
  // „Save & Exit"-Button (mit noSaveBtn=1 der einzige save-auslösende Button)
  // sendet KEIN `exit`-Feld — anders als die Embed-Doku suggeriert. Ein
  // fehlendes Feld muss deshalb als „schließen" gelten, sonst bliebe der
  // Dialog nach jedem echten Speichern fälschlich offen.
  it('save ohne exit-Feld (echtes draw.io) gilt als „schließen"', () => {
    const { callbacks, proto } = setup()
    proto.handleMessage(msg({ event: 'save' }))
    proto.handleMessage(msg({ event: 'export', format: 'xmlsvg', data: SVG_URI }))
    expect(callbacks.onSave).toHaveBeenCalledWith(SVG, true)
  })
  it('save mit explizitem exit:false bleibt offen', () => {
    const { callbacks, proto } = setup()
    proto.handleMessage(msg({ event: 'save', exit: false }))
    proto.handleMessage(msg({ event: 'export', format: 'xmlsvg', data: SVG_URI }))
    expect(callbacks.onSave).toHaveBeenCalledWith(SVG, false)
  })
})
