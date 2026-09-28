import { describe, expect, it } from 'vitest'
import { computeOrderKeys, orderFilePath, parseOrderFile, serializeOrderFile } from '../src/indexer/order-file.js'

/**
 * `.order`-Dateien (Phase 3.3, „Baum-Umsortierung"): reine Unit-Tests ohne
 * Container für Parsen/Positions-Berechnung — der Container-gestützte Test der
 * eigentlichen Indexer-Integration (`loadOrderKeysForPages`, Provider-Lesen)
 * lebt in `test/indexer.test.ts` (`describe('indexSpace: \`.order\`-Dateien …`).
 */
describe('orderFilePath', () => {
  it('liefert `.order` (nicht `/.order`) für die Space-Wurzel', () => {
    expect(orderFilePath('')).toBe('.order')
  })

  it('liefert `<dir>/.order` für ein Unterverzeichnis', () => {
    expect(orderFilePath('betrieb')).toBe('betrieb/.order')
    expect(orderFilePath('betrieb/deployment')).toBe('betrieb/deployment/.order')
  })
})

describe('parseOrderFile', () => {
  it('liest eine Id pro Zeile', () => {
    expect(parseOrderFile('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('ignoriert leere Zeilen', () => {
    expect(parseOrderFile('a\n\n\nb\n\nc')).toEqual(['a', 'b', 'c'])
  })

  it('trimmt führenden/abschließenden Whitespace je Zeile', () => {
    expect(parseOrderFile('  a  \n\tb\t\n')).toEqual(['a', 'b'])
  })

  it('liefert eine leere Liste für eine leere Datei', () => {
    expect(parseOrderFile('')).toEqual([])
    expect(parseOrderFile('\n\n  \n')).toEqual([])
  })

  it('behandelt CRLF-Zeilenumbrüche wie LF', () => {
    expect(parseOrderFile('a\r\nb\r\n')).toEqual(['a', 'b'])
  })
})

describe('computeOrderKeys', () => {
  it('weist 0-basierte Positionen in Auftrittsreihenfolge zu', () => {
    const keys = computeOrderKeys(['b', 'a', 'c'], new Set(['a', 'b', 'c']))
    expect(keys.get('b')).toBe(0)
    expect(keys.get('a')).toBe(1)
    expect(keys.get('c')).toBe(2)
  })

  it('ignoriert unbekannte Ids (kein tatsächliches Kind) tolerant', () => {
    const keys = computeOrderKeys(['a', 'zzz-unbekannt', 'b'], new Set(['a', 'b']))
    expect([...keys.entries()]).toEqual([
      ['a', 0],
      ['b', 1],
    ])
    expect(keys.has('zzz-unbekannt')).toBe(false)
  })

  it('zählt bei einer doppelt vorkommenden Id nur das ERSTE Vorkommen', () => {
    const keys = computeOrderKeys(['a', 'b', 'a'], new Set(['a', 'b']))
    expect(keys.get('a')).toBe(0)
    expect(keys.get('b')).toBe(1)
    expect(keys.size).toBe(2)
  })

  it('liefert eine leere Map für eine leere Liste', () => {
    expect(computeOrderKeys([], new Set(['a', 'b'])).size).toBe(0)
  })

  it('Kinder, die in der Liste fehlen, tauchen im Ergebnis gar nicht auf (Aufrufer setzt orderKey=null)', () => {
    const keys = computeOrderKeys(['a'], new Set(['a', 'b', 'c']))
    expect(keys.has('a')).toBe(true)
    expect(keys.has('b')).toBe(false)
    expect(keys.has('c')).toBe(false)
  })
})

describe('serializeOrderFile', () => {
  it('schreibt eine Id pro Zeile mit abschließendem Zeilenumbruch', () => {
    expect(serializeOrderFile(['a', 'b', 'c'])).toBe('a\nb\nc\n')
  })

  it('liefert einen leeren String für eine leere Liste', () => {
    expect(serializeOrderFile([])).toBe('')
  })

  it('ist die Inverse von parseOrderFile für eine saubere Liste', () => {
    const ids = ['x', 'y', 'z']
    expect(parseOrderFile(serializeOrderFile(ids))).toEqual(ids)
  })
})
