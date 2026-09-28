import { describe, expect, it } from 'vitest'
import { de } from './messages/de/index.js'
import { en } from './messages/en/index.js'
import { t } from './format.js'

describe('t — Dot-Key-Auflösung + Interpolation', () => {
  it('löst einen verschachtelten Dot-Key auf', () => {
    expect(t(de, 'sidebar.tools.graph.label')).toBe('Graph-Ansicht')
    expect(t(en, 'sidebar.tools.graph.label')).toBe('Graph view')
  })

  it('interpoliert einen einzelnen Platzhalter', () => {
    expect(t(de, 'sidebar.treeAriaLabel', { space: 'Betrieb' })).toBe('Seiten im Space Betrieb')
    expect(t(en, 'sidebar.treeAriaLabel', { space: 'Betrieb' })).toBe('Pages in space Betrieb')
  })

  it('lässt einen unbekannten Platzhalter unverändert stehen (kein leiser Datenverlust)', () => {
    expect(t(de, 'sidebar.treeAriaLabel', {})).toBe('Seiten im Space {space}')
  })

  it('liefert den Rohtext unverändert ohne Params', () => {
    expect(t(de, 'shell.account.logout')).toBe('Abmelden')
  })
})

describe('t — Plural (_one/_other)', () => {
  it('wählt _one bei count === 1, DE + EN', () => {
    expect(t(de, 'sidebar.pageCount', { count: 1 })).toBe('1 Seite')
    expect(t(en, 'sidebar.pageCount', { count: 1 })).toBe('1 page')
  })

  it('wählt _other bei count !== 1 (0, >1), DE + EN', () => {
    expect(t(de, 'sidebar.pageCount', { count: 0 })).toBe('0 Seiten')
    expect(t(de, 'sidebar.pageCount', { count: 2 })).toBe('2 Seiten')
    expect(t(en, 'sidebar.pageCount', { count: 0 })).toBe('0 pages')
    expect(t(en, 'sidebar.pageCount', { count: 5 })).toBe('5 pages')
  })
})

describe('t — fehlender Key', () => {
  it('wirft nie, sondern liefert einen sichtbaren Marker', () => {
    // `as never` umgeht bewusst den Typ-Schutz (DotPaths<Messages>) — genau
    // der Fall, den die Laufzeit-Fallback-Logik zusätzlich zur Typsicherheit
    // abfangen soll (z. B. ein Key, der nur in einem Zweig via `as`
    // durchgereicht wurde).
    expect(t(de, 'sidebar.doesNotExist' as never)).toBe('⟦sidebar.doesNotExist⟧')
  })

  it('behandelt einen Pfad durch ein Nicht-Objekt ebenfalls als fehlend', () => {
    expect(t(de, 'sidebar.pagesGroup.nope' as never)).toBe('⟦sidebar.pagesGroup.nope⟧')
  })
})
