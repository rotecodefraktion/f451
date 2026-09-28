import { getSchema } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpDiagramVersion } from './diagram-versions.js'
import { uiExtensions, type UiExtensionsOptions } from './ui-extensions.js'

// Headless (kein DOM): `NodeSpec.toDOM` liefert nur die DOMOutputSpec-Datenstruktur
// (ein Array, keine echten DOM-Knoten) — testbar ohne jsdom, s. @tiptap/core:
// `schema.toDOM = (node) => renderHTML({node, HTMLAttributes: …})`.

describe('uiExtensions — Media-URL-Mapping (Image)', () => {
  it('behält den relativen Pfad im Node-Attribut (Markdown-Wahrheit)', () => {
    const schema = getSchema(uiExtensions('demo'))
    const node = schema.nodes.image!.create({ src: '_media/diagramm.png', alt: 'Diagramm' })
    expect(node.toJSON()).toMatchObject({ attrs: { src: '_media/diagramm.png', alt: 'Diagramm' } })
  })

  it('löst den relativen Pfad im gerenderten HTML über mediaHref(pageId, src, "draft") auf', () => {
    const schema = getSchema(uiExtensions('demo'))
    const node = schema.nodes.image!.create({ src: '_media/diagramm.png', alt: 'Diagramm' })
    const [tag, attrs] = schema.nodes.image!.spec.toDOM!(node) as [string, Record<string, unknown>]
    expect(tag).toBe('img')
    // Bugfix (Phase 2c Task 7): `mediaHref` entfernt das `_media/`-Präfix — die
    // Server-Route baut es selbst wieder an (s. `lib/urls.ts#mediaHref`-Kommentar),
    // ein verbliebenes Präfix hier hätte serverseitig `_media/_media/…` ergeben (404).
    expect(attrs.src).toBe('/media/demo/diagramm.png?ref=draft')
    expect(attrs.alt).toBe('Diagramm')
  })

  it('kodiert Sonderzeichen in pageId UND relativem Pfad', () => {
    const schema = getSchema(uiExtensions('path:demo/a b.md'))
    const node = schema.nodes.image!.create({ src: '_media/mit leerzeichen.png' })
    const [, attrs] = schema.nodes.image!.spec.toDOM!(node) as [string, Record<string, unknown>]
    expect(attrs.src).toBe('/media/path%3Ademo%2Fa%20b.md/mit%20leerzeichen.png?ref=draft')
  })

  it('lässt absolute URLs (http/https) unangetastet', () => {
    const schema = getSchema(uiExtensions('demo'))
    const node = schema.nodes.image!.create({ src: 'https://example.org/bild.png' })
    const [, attrs] = schema.nodes.image!.spec.toDOM!(node) as [string, Record<string, unknown>]
    expect(attrs.src).toBe('https://example.org/bild.png')
  })

  it('lässt data:-URIs unangetastet', () => {
    const schema = getSchema(uiExtensions('demo'))
    const node = schema.nodes.image!.create({ src: 'data:image/png;base64,AAAA' })
    const [, attrs] = schema.nodes.image!.spec.toDOM!(node) as [string, Record<string, unknown>]
    expect(attrs.src).toBe('data:image/png;base64,AAAA')
  })

  it('lässt einen leeren src unangetastet (kein Absturz, kein mediaHref-Aufruf)', () => {
    const schema = getSchema(uiExtensions('demo'))
    const node = schema.nodes.image!.create({})
    const [, attrs] = schema.nodes.image!.spec.toDOM!(node) as [string, Record<string, unknown>]
    expect(attrs.src).toBeNull()
  })
})

describe('uiExtensions — UI-only-Extensions', () => {
  it('enthält UndoRedo, Dropcursor, Gapcursor und tableGuard zusätzlich zum Dialekt-Schema', () => {
    const names = uiExtensions('demo').map((extension) => extension.name)
    expect(names).toContain('undoRedo')
    expect(names).toContain('dropCursor')
    expect(names).toContain('gapCursor')
    expect(names).toContain('tableGuard')
  })

  it('registriert "image" genau einmal (keine doppelte Extension-Registrierung)', () => {
    const names = uiExtensions('demo').map((extension) => extension.name)
    expect(names.filter((name) => name === 'image')).toHaveLength(1)
  })

  it('deckt weiterhin den vollen Markdown-Dialekt ab (z. B. Tabellen, Alerts, Wikilinks)', () => {
    const schema = getSchema(uiExtensions('demo'))
    expect(schema.nodes.table).toBeDefined()
    expect(schema.nodes.alert).toBeDefined()
    expect(schema.nodes.wikiLink).toBeDefined()
  })
})

// --- Diagramm-NodeView (Phase 3e Task 3) --------------------------------------------
//
// `addNodeView()` liefert reines DOM-Bauwerk (`document.createElement`, s.
// ui-extensions.ts) — die Fabrikfunktion selbst nutzt kein `this` und kann daher
// direkt vom `image`-Extension-Config abgerufen und mit einem minimalen
// `{node, editor}`-Fake aufgerufen werden, OHNE eine vollständige ProseMirror-
// `EditorView` (die echtes `document`/jsdom bräuchte, hier nicht installiert).
// Ein handgebautes Fake-`document` (Muster: `client-api.test.ts#mockFetch` —
// `vi.stubGlobal` statt einer echten DOM-Implementierung) reicht für die paar
// DOM-Operationen, die die NodeView tatsächlich nutzt (`createElement`,
// Property-Zuweisungen, `append`, `addEventListener`).

class FakeElement {
  readonly tagName: string
  className = ''
  type = ''
  textContent = ''
  alt = ''
  title = ''
  src = ''
  readonly children: FakeElement[] = []
  private readonly listeners = new Map<string, () => void>()

  constructor(tagName: string) {
    this.tagName = tagName
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, handler)
  }

  click(): void {
    this.listeners.get('click')?.()
  }
}

interface FakeNodeViewResult {
  dom: FakeElement
  destroy?: () => void
  stopEvent?: (event: { target: unknown }) => boolean
}

type FakeNodeViewFactory = (props: { node: { attrs: Record<string, unknown> }; editor: { isEditable: boolean } }) => FakeNodeViewResult

function getImageNodeView(options: UiExtensionsOptions = {}): FakeNodeViewFactory {
  const extensions = uiExtensions('demo', options) as unknown as Array<{
    name: string
    config: { addNodeView?: () => FakeNodeViewFactory }
  }>
  const imageExtension = extensions.find((extension) => extension.name === 'image')
  if (!imageExtension?.config.addNodeView) throw new Error('image-Extension ohne addNodeView')
  return imageExtension.config.addNodeView()
}

describe('uiExtensions — Diagramm-NodeView', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rendert ein Diagramm-Bild als div.diagram-node mit img + button.diagram-edit', () => {
    const nodeView = getImageNodeView()
    const result = nodeView({ node: { attrs: { src: '_media/fluss.drawio.svg', alt: 'Fluss' } }, editor: { isEditable: true } })

    expect(result.dom.tagName).toBe('div')
    expect(result.dom.className).toBe('diagram-node')
    const img = result.dom.children.find((child) => child.tagName === 'img')
    const button = result.dom.children.find((child) => child.tagName === 'button')
    expect(img).toBeDefined()
    expect(img?.alt).toBe('Fluss')
    expect(button).toBeDefined()
    expect(button?.className).toBe('diagram-edit')
  })

  it('rendert ein normales Bild ohne Wrapper (unverändertes Verhalten)', () => {
    const nodeView = getImageNodeView()
    const result = nodeView({ node: { attrs: { src: '_media/foto.png' } }, editor: { isEditable: true } })

    expect(result.dom.tagName).toBe('img')
    expect(result.dom.children).toHaveLength(0)
  })

  it('Klick auf den Bearbeiten-Button ruft onEditDiagram mit { path, kind } auf', () => {
    const onEditDiagram = vi.fn()
    const nodeView = getImageNodeView({ onEditDiagram })
    const result = nodeView({
      node: { attrs: { src: '_media/skizze.excalidraw.svg' } },
      editor: { isEditable: true },
    })

    const button = result.dom.children.find((child) => child.tagName === 'button')!
    button.click()

    expect(onEditDiagram).toHaveBeenCalledExactlyOnceWith({ path: '_media/skizze.excalidraw.svg', kind: 'excalidraw' })
  })

  it('ignoriert den Klick, solange der Editor nicht editierbar ist (Read-Only-Modus)', () => {
    const onEditDiagram = vi.fn()
    const nodeView = getImageNodeView({ onEditDiagram })
    const result = nodeView({
      node: { attrs: { src: '_media/skizze.excalidraw.svg' } },
      editor: { isEditable: false },
    })

    result.dom.children.find((child) => child.tagName === 'button')!.click()

    expect(onEditDiagram).not.toHaveBeenCalled()
  })

  it('stopEvent markiert nur Button-Events als von ProseMirror unbehandelt (kein NodeSelection-Beifang)', () => {
    // Regression zu dem per E2E gefundenen Bug (Task 6, Auflage A): ein Klick
    // auf den Bearbeiten-Button darf NICHT zusätzlich eine NodeSelection auf dem
    // Diagramm setzen — `stopEvent` liefert nur für Events MIT `target === button`
    // true, für alles andere (Bild-Klick, Drag, Delete) false.
    const nodeView = getImageNodeView()
    const result = nodeView({ node: { attrs: { src: '_media/fluss.drawio.svg' } }, editor: { isEditable: true } })
    const button = result.dom.children.find((child) => child.tagName === 'button')!
    const img = result.dom.children.find((child) => child.tagName === 'img')!

    expect(result.stopEvent?.({ target: button })).toBe(true)
    expect(result.stopEvent?.({ target: img })).toBe(false)
  })

  it('hängt die Versionsnummer nach bumpDiagramVersion an die Bild-URL an, solange die NodeView lebt', () => {
    const nodeView = getImageNodeView()
    const result = nodeView({ node: { attrs: { src: '_media/fluss.drawio.svg' } }, editor: { isEditable: true } })
    const img = result.dom.children.find((child) => child.tagName === 'img')!
    const srcBefore = img.src

    bumpDiagramVersion('demo', '_media/fluss.drawio.svg')

    expect(img.src).not.toBe(srcBefore)
    expect(img.src).toMatch(/&v=\d+$/)
  })

  it('destroy() beendet das Versions-Abo (kein Update nach dem Unmount)', () => {
    const nodeView = getImageNodeView()
    const result = nodeView({ node: { attrs: { src: '_media/nach-unmount.drawio.svg' } }, editor: { isEditable: true } })
    const img = result.dom.children.find((child) => child.tagName === 'img')!
    const srcBefore = img.src

    result.destroy?.()
    bumpDiagramVersion('demo', '_media/nach-unmount.drawio.svg')

    expect(img.src).toBe(srcBefore)
  })
})
