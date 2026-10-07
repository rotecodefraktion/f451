import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { filterSlashItems } from './slash-items.js'
import { t as translate } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import type { T } from '../i18n/types.js'

// Phase-2-i18n: `filterSlashItems` bekommt `t` als Parameter (Modulkonvention, s.
// `lib/i18n/types.ts#T`) — hier an das DE-Wörterbuch gebunden, derselbe Wortlaut
// wie die bisherigen (unparametrisierten) Tests.
const t: T = (key, params) => translate(de, key, params)

// Reines Modul (kein Editor/DOM nötig) — `run(editor)` wird hier bewusst NICHT
// aufgerufen (bräuchte eine echte Tiptap-`Editor`-Instanz, s. Task-Brief: nur
// `filterSlashItems` ist Teil der geforderten Tests). Geprüft wird Filterung,
// Vollständigkeit (alle 5 Alert-Typen) und Deutsch-Labels.

describe('filterSlashItems', () => {
  it('liefert bei leerer Query alle Items', () => {
    const items = filterSlashItems('', t)
    expect(items.length).toBe(20) // Phase 3e: +draw.io +Excalidraw; f451#82: +footnote
    expect(items.map((item) => item.id)).toEqual([
      'heading1',
      'heading2',
      'heading3',
      'bulletList',
      'orderedList',
      'taskList',
      'table',
      'codeBlock',
      'blockquote',
      'alertNote',
      'alertTip',
      'alertImportant',
      'alertWarning',
      'alertCaution',
      'horizontalRule',
      'image',
      'drawio',
      'excalidraw',
      'video',
      'footnote',
    ])
  })

  it('Query "tab" matcht genau die Tabelle', () => {
    const items = filterSlashItems('tab', t)
    expect(items.map((item) => item.id)).toEqual(['table'])
    expect(items[0]!.label).toBe('Tabelle')
  })

  it('Query "hin" matcht alle 5 Hinweisbox-Typen', () => {
    const items = filterSlashItems('hin', t)
    expect(items).toHaveLength(5)
    expect(items.map((item) => item.id).sort()).toEqual(
      ['alertCaution', 'alertImportant', 'alertNote', 'alertTip', 'alertWarning'].sort(),
    )
    expect(items.map((item) => item.label)).toEqual(['Hinweis', 'Tipp', 'Wichtig', 'Warnung', 'Achtung'])
  })

  it('ist case-insensitive und trimmt die Query', () => {
    expect(filterSlashItems('  TAB  ', t).map((item) => item.id)).toEqual(['table'])
  })

  it('liefert eine leere Liste, wenn nichts matcht', () => {
    expect(filterSlashItems('xyzxyz', t)).toEqual([])
  })

  it('trägt .kbd-Hints für Überschrift 2 und Codeblock (Mockup)', () => {
    const items = filterSlashItems('', t)
    expect(items.find((item) => item.id === 'heading2')?.kbd).toBe('##')
    expect(items.find((item) => item.id === 'codeBlock')?.kbd).toBe('```')
  })

  it('drops the diagram items in the phone layout (f451#1)', () => {
    const ids = filterSlashItems('', t, { phone: true }).map((item) => item.id)
    expect(ids).not.toContain('drawio')
    expect(ids).not.toContain('excalidraw')
    expect(ids).toHaveLength(18)
  })

  it('query "draw" finds nothing in the phone layout', () => {
    expect(filterSlashItems('draw', t, { phone: true })).toEqual([])
  })

  it('query "draw" without opts contains drawio', () => {
    expect(filterSlashItems('draw', t).map((item) => item.id)).toContain('drawio')
  })

  it('deutsche Labels für alle Items', () => {
    const labels = filterSlashItems('', t).map((item) => item.label)
    expect(labels).toEqual([
      'Überschrift 1',
      'Überschrift 2',
      'Überschrift 3',
      'Aufzählung',
      'Nummerierte Liste',
      'Aufgabenliste',
      'Tabelle',
      'Codeblock',
      'Zitat',
      'Hinweis',
      'Tipp',
      'Wichtig',
      'Warnung',
      'Achtung',
      'Trennlinie',
      'Bild/Datei',
      'draw.io-Diagramm',
      'Excalidraw',
      'Video',
      'Fußnote',
    ])
  })
})

// --- Item „Video" (Phase 3d Task 4): run() braucht eine Editor-Instanz, daher
// eigener Block mit Stub statt im obigen reinen filterSlashItems-Test. Zugriff
// auf das Item selbst läuft über `filterSlashItems('')` — die Datei exportiert
// keine rohe `slashItems`-Liste (nur die Filterfunktion, s. Kopfkommentar der
// Quelldatei); minimal-invasiv also die vorhandene Filter-Funktion wiederverwendet
// statt einen zusätzlichen Export nur für den Test einzuführen.
function editorStub() {
  const insertContent = vi.fn().mockReturnThis()
  const chain = { focus: vi.fn().mockReturnThis(), insertContent, run: vi.fn() }
  return { editor: { chain: () => chain } as unknown as Editor, insertContent }
}

// --- Item „draw.io-Diagramm" (Phase 3e Task 4): `run()` delegiert nur an den
// Custom-Command `createDiagram` (der eigentliche Dialog-Flow — Namensabfrage,
// Öffnen des `DrawioDialog` — lebt in `wysiwyg-editor.tsx`/`ui-extensions.ts`,
// s. dortige Tests/Komponenten) — hier reicht der Beweis, dass der Chain-Aufruf
// mit dem richtigen `kind` ankommt, gleiches Stub-Muster wie oben.
function diagramEditorStub() {
  const createDiagram = vi.fn().mockReturnThis()
  const chain = { focus: vi.fn().mockReturnThis(), createDiagram, run: vi.fn() }
  return { editor: { chain: () => chain } as unknown as Editor, createDiagram }
}

describe('Slash-Item „draw.io-Diagramm"', () => {
  it('ruft createDiagram("drawio") im Chain auf', () => {
    const { editor, createDiagram } = diagramEditorStub()
    filterSlashItems('', t)
      .find((i) => i.id === 'drawio')!
      .run(editor)
    expect(createDiagram).toHaveBeenCalledWith('drawio')
  })
})

// --- Item „Excalidraw" (Phase 3e Task 5): gleiches Stub-Muster wie draw.io oben —
// `run()` delegiert nur an denselben Custom-Command mit `kind: 'excalidraw'`.
describe('Slash-Item „Excalidraw"', () => {
  it('ruft createDiagram("excalidraw") im Chain auf', () => {
    const { editor, createDiagram } = diagramEditorStub()
    filterSlashItems('', t)
      .find((i) => i.id === 'excalidraw')!
      .run(editor)
    expect(createDiagram).toHaveBeenCalledWith('excalidraw')
  })

  it('matcht die Query "skizze"', () => {
    expect(filterSlashItems('skizze', t).map((item) => item.id)).toEqual(['excalidraw'])
  })
})

describe('Slash-Item „Video"', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { prompt: vi.fn(), alert: vi.fn() })
  })

  it('fügt bei gültiger URL einen youtubeEmbed-Node ein', () => {
    ;(window.prompt as ReturnType<typeof vi.fn>).mockReturnValue('https://youtu.be/dQw4w9WgXcQ')
    const { editor, insertContent } = editorStub()
    filterSlashItems('', t)
      .find((i) => i.id === 'video')!
      .run(editor)
    expect(insertContent).toHaveBeenCalledWith({ type: 'youtubeEmbed', attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' } })
  })

  it('fügt bei ungültiger/abgebrochener Eingabe nichts ein', () => {
    ;(window.prompt as ReturnType<typeof vi.fn>).mockReturnValue('https://vimeo.com/1')
    const { editor, insertContent } = editorStub()
    filterSlashItems('', t)
      .find((i) => i.id === 'video')!
      .run(editor)
    expect(insertContent).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalled()
    ;(window.prompt as ReturnType<typeof vi.fn>).mockReturnValue(null)
    filterSlashItems('', t)
      .find((i) => i.id === 'video')!
      .run(editor)
    expect(insertContent).not.toHaveBeenCalled()
  })
})
