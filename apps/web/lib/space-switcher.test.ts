import { describe, expect, it } from 'vitest'
import { cycleIndex, indexOfSpace, resolveCurrentSpace, type SpaceSwitcherSpace } from './space-switcher.js'

const SPACES: SpaceSwitcherSpace[] = [
  { id: 'betrieb', name: 'Betrieb' },
  { id: 'handbuch', name: 'Handbuch' },
]

describe('indexOfSpace', () => {
  it('findet den Index eines bekannten Space', () => {
    expect(indexOfSpace(SPACES, 'handbuch')).toBe(1)
  })

  it('liefert -1 für einen unbekannten Space', () => {
    expect(indexOfSpace(SPACES, 'unbekannt')).toBe(-1)
  })

  it('liefert -1 ohne currentSpaceId (Seiten ohne Space-Bezug, z. B. Einstellungen)', () => {
    expect(indexOfSpace(SPACES, undefined)).toBe(-1)
  })

  it('liefert -1 für eine leere Space-Liste', () => {
    expect(indexOfSpace([], 'betrieb')).toBe(-1)
  })
})

describe('resolveCurrentSpace', () => {
  it('liefert den passenden Space-Eintrag', () => {
    expect(resolveCurrentSpace(SPACES, 'betrieb')).toEqual({ id: 'betrieb', name: 'Betrieb' })
  })

  it('liefert undefined ohne Treffer', () => {
    expect(resolveCurrentSpace(SPACES, 'unbekannt')).toBeUndefined()
  })

  it('liefert undefined ohne currentSpaceId', () => {
    expect(resolveCurrentSpace(SPACES, undefined)).toBeUndefined()
  })
})

describe('cycleIndex', () => {
  it('springt vorwärts zum nächsten Index', () => {
    expect(cycleIndex(0, 1, 2)).toBe(1)
  })

  it('springt vom letzten Eintrag zyklisch zurück zum ersten (ArrowDown)', () => {
    expect(cycleIndex(1, 1, 2)).toBe(0)
  })

  it('springt vom ersten Eintrag zyklisch zum letzten (ArrowUp)', () => {
    expect(cycleIndex(0, -1, 2)).toBe(1)
  })

  it('springt rückwärts zum vorherigen Index', () => {
    expect(cycleIndex(1, -1, 2)).toBe(0)
  })

  it('behandelt currentIndex -1 (kein Eintrag fokussiert) wie vor dem ersten Eintrag', () => {
    expect(cycleIndex(-1, 1, 3)).toBe(0)
    expect(cycleIndex(-1, -1, 3)).toBe(2)
  })

  it('liefert -1 für eine leere Liste', () => {
    expect(cycleIndex(0, 1, 0)).toBe(-1)
  })
})
