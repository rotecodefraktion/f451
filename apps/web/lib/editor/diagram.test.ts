import { describe, expect, it } from 'vitest'
import { diagramKind, diagramPath, diagramSlug } from './diagram'

describe('diagramKind', () => {
  it('erkennt beide Suffixe case-insensitiv', () => {
    expect(diagramKind('_media/fluss.drawio.svg')).toBe('drawio')
    expect(diagramKind('_media/Skizze.EXCALIDRAW.SVG')).toBe('excalidraw')
  })
  it('null für normale Bilder, absolute URLs, data:, leer', () => {
    expect(diagramKind('_media/foto.svg')).toBeNull()
    expect(diagramKind('_media/foto.png')).toBeNull()
    expect(diagramKind('https://example.com/x.drawio.svg')).toBeNull()
    expect(diagramKind('data:image/svg+xml;base64,x')).toBeNull()
    expect(diagramKind(null)).toBeNull()
    expect(diagramKind(undefined)).toBeNull()
  })
})

describe('diagramSlug/diagramPath', () => {
  it('slugifiziert wie der Server (Kleinbuchstaben, Bindestriche, Umlaute)', () => {
    expect(diagramSlug('Deployment-Übersicht 2026')).toBe('deployment-uebersicht-2026')
    expect(diagramSlug('___')).toBeNull()
    expect(diagramSlug('')).toBeNull()
  })
  it('baut den _media-Pfad', () => {
    expect(diagramPath('fluss', 'drawio')).toBe('_media/fluss.drawio.svg')
    expect(diagramPath('skizze', 'excalidraw')).toBe('_media/skizze.excalidraw.svg')
  })
})
