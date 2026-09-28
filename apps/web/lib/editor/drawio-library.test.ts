import { describe, expect, it } from 'vitest'
import { diagrammStil, mxStil } from '@f451/design-tokens'
import { drawioKonfiguration, hausstilFormen, HAUSSTIL_BIBLIOTHEK_ID } from './drawio-library'

describe('Formenbibliothek Hausstil', () => {
  it('trägt dieselben Stil-Zeichenketten und Maße wie der Generator', () => {
    const formen = hausstilFormen('de')
    const stilVon = (titel: string) => {
      const xml = formen.find((f) => f.title === titel)!.xml
      const roh = /<mxCell id="2"[^>]* style="([^"]*)"/.exec(xml)![1]!
      return roh.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    }
    expect(stilVon('Anfang/Ende')).toBe(mxStil.anfangEnde)
    expect(stilVon('Schritt (Bahnen)')).toBe(mxStil.schritt('swimlane'))
    expect(stilVon('Schritt (Fluss)')).toBe(mxStil.schritt('flow'))
    expect(stilVon('Entscheidung')).toBe(mxStil.entscheidung)
    expect(stilVon('Bahn')).toBe(mxStil.bahn)

    const entscheidung = formen.find((f) => f.title === 'Entscheidung')!
    expect([entscheidung.w, entscheidung.h]).toEqual([diagrammStil.flowDecisionW, diagrammStil.flowDecisionH])
  })

  it('jede Form ist ein vollständiges mxGraphModel ohne rohe Sonderzeichen in Attributen', () => {
    for (const f of hausstilFormen('en')) {
      expect(f.xml, f.title).toMatch(/^<mxGraphModel><root><mxCell id="0"\/><mxCell id="1" parent="0"\/><mxCell id="2" .*<\/root><\/mxGraphModel>$/)
      for (const [, wert] of f.xml.matchAll(/="([^"]*)"/g)) expect(wert, f.title).not.toMatch(/[<>]/)
    }
  })

  it('schaltet die Bibliothek in der Seitenleiste frei, die eingebauten bleiben', () => {
    const config = drawioKonfiguration('de') as { defaultLibraries: string; libraries: Array<{ entries: Array<{ id: string }> }> }
    const liste = config.defaultLibraries.split(';')
    expect(liste[0]).toBe(HAUSSTIL_BIBLIOTHEK_ID)
    expect(liste).toContain('general')
    expect(config.libraries[0]!.entries[0]!.id).toBe(HAUSSTIL_BIBLIOTHEK_ID)
    expect(config).not.toHaveProperty('defaultCustomLibraries')
  })

  it('Version hängt nur an den Formen, nicht an der Sprache', () => {
    const de = drawioKonfiguration('de') as { version: string }
    const en = drawioKonfiguration('en') as { version: string }
    expect(de.version).toMatch(/^f451-hausstil-[0-9a-z]+$/)
    expect(en.version).toBe(de.version)
  })
})
