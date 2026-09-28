import { describe, expect, it } from 'vitest'
import {
  activeAncestorIds,
  isExpanded,
  parseExpansion,
  toNodeRefs,
  treeExpansionStorageKey,
  withExpanded,
  type TreeNodeRef,
} from './tree-expansion.js'

/** Baum wie ihn `GET /api/spaces/:space/tree` liefert (nur die Felder, die
 *  die Zustandslogik interessieren). */
const TREE = [
  {
    id: 'home',
    children: [
      { id: 'runbooks', children: [{ id: 'deployment', children: [] }] },
      { id: 'notes', children: [] },
    ],
  },
]

const REFS: TreeNodeRef[] = toNodeRefs(TREE)

describe('toNodeRefs', () => {
  it('flacht den Baum mit Elternbezug ab', () => {
    expect(REFS).toEqual([
      { id: 'home', parentId: null },
      { id: 'runbooks', parentId: 'home' },
      { id: 'deployment', parentId: 'runbooks' },
      { id: 'notes', parentId: 'home' },
    ])
  })
})

describe('isExpanded', () => {
  it('ist ohne Eintrag zu', () => {
    expect(isExpanded({}, 'home')).toBe(false)
  })

  it('folgt dem gespeicherten Eintrag', () => {
    expect(isExpanded({ home: false }, 'home')).toBe(false)
    expect(isExpanded({ home: true }, 'home')).toBe(true)
  })
})

describe('parseExpansion', () => {
  it('liest gespeicherte Booleans', () => {
    expect(parseExpansion('{"home":false,"notes":true}')).toEqual({ home: false, notes: true })
  })

  it('fällt bei fehlendem, kaputtem oder unpassendem Inhalt auf leer zurück', () => {
    expect(parseExpansion(null)).toEqual({})
    expect(parseExpansion('')).toEqual({})
    expect(parseExpansion('{nope')).toEqual({})
    expect(parseExpansion('["home"]')).toEqual({})
    expect(parseExpansion('null')).toEqual({})
  })

  it('wirft Nicht-Boolean-Werte weg, behält den Rest', () => {
    expect(parseExpansion('{"home":false,"kaputt":"ja"}')).toEqual({ home: false })
  })
})

describe('treeExpansionStorageKey', () => {
  it('trennt die Spaces', () => {
    expect(treeExpansionStorageKey('demo')).not.toBe(treeExpansionStorageKey('handbuch'))
  })
})

describe('activeAncestorIds', () => {
  it('liefert den Ast zur aktuellen Seite, ohne die Seite selbst', () => {
    expect(activeAncestorIds(REFS, 'demo', '/wiki/demo/deployment')).toEqual(['runbooks', 'home'])
  })

  it('erkennt auch Unterrouten der Seite (Bearbeiten/Review)', () => {
    expect(activeAncestorIds(REFS, 'demo', '/wiki/demo/deployment/edit')).toEqual(['runbooks', 'home'])
    expect(activeAncestorIds(REFS, 'demo', '/wiki/demo/deployment/review')).toEqual(['runbooks', 'home'])
  })

  it('gibt für die Wurzel und für Unbekanntes nichts zurück', () => {
    expect(activeAncestorIds(REFS, 'demo', '/wiki/demo/home')).toEqual([])
    expect(activeAncestorIds(REFS, 'demo', '/wiki/demo/graph')).toEqual([])
    expect(activeAncestorIds(REFS, 'demo', null)).toEqual([])
  })

  it('meint nicht den Nachbarknoten mit ähnlicher Id', () => {
    const refs = toNodeRefs([{ id: 'a', children: [] }, { id: 'ab', children: [{ id: 'x', children: [] }] }])
    expect(activeAncestorIds(refs, 'demo', '/wiki/demo/x')).toEqual(['ab'])
  })

  it('greift auch bei Ids mit Sonderzeichen (kodierter Pfad)', () => {
    const refs = toNodeRefs([{ id: 'path:demo/a.md', children: [{ id: 'path:demo/a/b.md', children: [] }] }])
    expect(activeAncestorIds(refs, 'demo', '/wiki/demo/path%3Ademo%2Fa%2Fb.md')).toEqual(['path:demo/a.md'])
  })

  it('läuft bei einem Ringschluss in den Elternbezügen nicht endlos', () => {
    const refs: TreeNodeRef[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]
    expect(activeAncestorIds(refs, 'demo', '/wiki/demo/a')).toEqual(['b'])
  })
})

describe('withExpanded', () => {
  it('klappt einen zugeklappten Ast wieder auf', () => {
    expect(withExpanded({ home: false, notes: false }, ['home'])).toEqual({ home: true, notes: false })
  })

  it('klappt auch einen Ast ohne Eintrag auf', () => {
    // Seit „zu" der Standard ist, ist ein eintragsloser Knoten geschlossen —
    // der Ast zur aufgerufenen Seite braucht deshalb seinen `true`-Eintrag.
    expect(withExpanded({}, ['home'])).toEqual({ home: true })
  })

  it('lässt den Zustand unangetastet, wenn schon alles offen ist', () => {
    const state = { home: true, runbooks: true }
    expect(withExpanded(state, ['home', 'runbooks'])).toBe(state)
    expect(withExpanded(state, [])).toBe(state)
  })
})
