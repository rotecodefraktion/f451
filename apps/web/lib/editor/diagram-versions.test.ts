import { describe, expect, it } from 'vitest'
import { bumpDiagramVersion, diagramVersion, subscribeDiagramVersions } from './diagram-versions'

describe('diagram-versions', () => {
  it('startet bei 0, bump erhöht nur den betroffenen Schlüssel', () => {
    expect(diagramVersion('p1', '_media/a.drawio.svg')).toBe(0)
    bumpDiagramVersion('p1', '_media/a.drawio.svg')
    expect(diagramVersion('p1', '_media/a.drawio.svg')).toBe(1)
    expect(diagramVersion('p1', '_media/b.drawio.svg')).toBe(0)
    expect(diagramVersion('p2', '_media/a.drawio.svg')).toBe(0)
  })
  it('benachrichtigt Subscriber; unsubscribe beendet', () => {
    const seen: string[] = []
    const off = subscribeDiagramVersions((pageId, path) => seen.push(`${pageId}:${path}`))
    bumpDiagramVersion('p1', '_media/a.drawio.svg')
    off()
    bumpDiagramVersion('p1', '_media/a.drawio.svg')
    expect(seen).toEqual(['p1:_media/a.drawio.svg'])
  })
})
