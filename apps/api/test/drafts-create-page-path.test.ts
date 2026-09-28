import { describe, expect, it } from 'vitest'
import { pathSegmentFromTitle } from '../src/drafts/create-page.js'

/**
 * `pathSegmentFromTitle` (Phase 2d Task 5, Fix-Runde 2 — Finding „Pfad-Slug aus
 * Titeln ist nicht git-pfadsicher"): reiner Unit-Test ohne Container, deckt die
 * Slug-Härtung isoliert ab. Der Integrations-Beweis (Forgejo akzeptiert den
 * gehärteten Pfad tatsächlich) liegt in `create-page.test.ts`.
 */
describe('pathSegmentFromTitle', () => {
  it('lässt einen normalen Titel unverändert (identisch zu slugify)', () => {
    expect(pathSegmentFromTitle('Neue Seite')).toBe('neue-seite')
  })

  it('strippt einen führenden Bindestrich, den slugify aus "- Titel" erzeugt', () => {
    // slugify("- Strich zuerst") -> "--strich-zuerst" (jedes Leerzeichen wird
    // einzeln zu '-', siehe packages/markdown/src/slug.ts) — git-unsicher als
    // erstes Pfadsegment.
    expect(pathSegmentFromTitle('- Strich zuerst')).toBe('strich-zuerst')
  })

  it('strippt einen abschließenden Bindestrich', () => {
    expect(pathSegmentFromTitle('Strich am Ende -')).toBe('strich-am-ende')
  })

  it('strippt mehrfache Bindestriche an beiden Rändern', () => {
    expect(pathSegmentFromTitle('--- Titel ---')).toBe('titel')
  })

  it('liefert null für einen Titel ohne verwertbare Zeichen (leerer Slug)', () => {
    expect(pathSegmentFromTitle('!!!')).toBeNull()
  })

  it('liefert null für einen Titel, der nur aus Bindestrichen/Leerzeichen besteht', () => {
    expect(pathSegmentFromTitle('---')).toBeNull()
    expect(pathSegmentFromTitle('- - -')).toBeNull()
  })

  it('lässt einen inneren Bindestrich unangetastet', () => {
    expect(pathSegmentFromTitle('Vor-Nachbereitung')).toBe('vor-nachbereitung')
  })
})
