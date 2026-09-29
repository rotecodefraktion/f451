import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMSerializer } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { getEditorSchema } from '../src/index.js'
import type { AlertType } from '../src/nodes/alert.js'

// --- Regressionstest Issue #22 ------------------------------------------------------
//
// Bug: Alert.renderHTML lieferte ein statisches Titel-<p> NEBEN dem Content-Loch (`0`)
// zurück — ProseMirrors DOMSerializer.renderSpec verlangt aber, dass das Content-Loch
// das EINZIGE Kind seines Elternknotens ist ("Content hole must be the only child of
// its parent node"), sobald mehr als ein Geschwister-Eintrag vor/nach ihm steht. Jeder
// Editor-Mount mit einer Alert-Node im Dokument (z.B. `> [!NOTE]` im Seed) crashte
// dadurch beim ersten Rendern.
//
// Dieser Test geht bewusst über den ECHTEN ProseMirror-`DOMSerializer` (denselben Pfad,
// den Tiptaps EditorView beim Mounten nutzt) statt nur die renderHTML-Rückgabe als
// Array zu inspizieren — ein Array-Shape-Test hätte den Bug nicht zuverlässig
// aufgedeckt (das Array *sieht* plausibel aus; erst renderSpec's Kind-Zählung wirft).
//
// Da dieses Package testweise ganz ohne DOM läuft (vitest environment: 'node', kein
// happy-dom/jsdom im Repo installiert — s. packages/editor/vitest.config.ts und
// pnpm-lock.yaml, wo beide nur als optionale peerDependencies von vitest selbst
// auftauchen, nirgends als echte Dependency), bringt dieser Test die minimale
// DOM-Oberfläche selbst mit, die `DOMSerializer.renderSpec` tatsächlich braucht:
// `createElement`, `createElementNS`, `createTextNode`, `appendChild`, `setAttribute`.
// Das ist keine Mock-Attrappe des Bugs selbst — renderSpec/DOMSerializer sind die
// echten, unveränderten Implementierungen aus `prosemirror-model`; nur `document`
// ist gestubbt (über `options.document`, dem dafür vorgesehenen Erweiterungspunkt
// für Nicht-Browser-Umgebungen, s. DOMSerializer-Doku "the `document` option").

class FakeText {
  readonly nodeType = 3
  constructor(public data: string) {}
}

class FakeElement {
  readonly nodeType = 1
  readonly childNodes: Array<FakeElement | FakeText> = []
  readonly attributes = new Map<string, string>()
  style: Record<string, string> = {}

  constructor(public tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value)
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    this.childNodes.push(child)
    return child
  }

  get className(): string {
    return this.attributes.get('class') ?? ''
  }

  get textContent(): string {
    return this.childNodes
      .map((child) => (child instanceof FakeText ? child.data : child.textContent))
      .join('')
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  createElementNS(_ns: string, tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  createTextNode(data: string): FakeText {
    return new FakeText(data)
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement('#fragment')
  }
}

const ALERT_TYPES: readonly AlertType[] = ['note', 'tip', 'important', 'warning', 'caution']

describe('Alert-Node: echter ProseMirror-DOMSerializer (Issue #22 Regression)', () => {
  const schema = getEditorSchema()
  const serializer = DOMSerializer.fromSchema(schema)

  it.each(ALERT_TYPES)(
    'serialisiert alertType=%s ohne "Content hole"-Absturz',
    (alertType) => {
      const node = schema.nodeFromJSON({
        type: 'alert',
        attrs: { alertType },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Textkörper' }] }],
      })

      let dom: FakeElement
      expect(() => {
        dom = serializer.serializeNode(node, {
          document: new FakeDocument() as unknown as Document,
        }) as unknown as FakeElement
      }).not.toThrow()

      dom = dom!
      expect(dom.tagName).toBe('div')
      // Die Klasse ist der einzige Träger der Typ-Information im gerenderten DOM —
      // der Titel wird (Fix: CSS-`::before` statt statischem <p>, s. globals.css)
      // NICHT mehr Teil des serialisierten Baums, sonst wäre das Content-Loch
      // wieder nicht das alleinige Kind. Die Klasse muss daher exakt stimmen, sonst
      // greift die CSS-Regel für den Titel nicht.
      expect(dom.className).toBe(`alert alert-${alertType}`)
      expect(dom.textContent).toContain('Textkörper')
      // Der Alert-Titel-Absatz selbst darf im editierbaren DOM nicht mehr auftauchen
      // (er würde sonst als editierbarer Content-Absatz im Dokument landen, s.
      // parseHTML.contentElement, das genau das beim Einlesen entfernt).
      expect(dom.childNodes.some((child) => child instanceof FakeElement && child.className === 'alert-title')).toBe(false)
    },
  )

  it.each(ALERT_TYPES)(
    'CSS liefert den Titel für .alert-%s als CSS-Variable, nicht als Literal (Issue #9)',
    (alertType) => {
      // Gesucht wird im GESAMTEN Anwendungs-CSS, nicht in einer bestimmten
      // Datei: Seit dem Umbau des Bausteinsystems enthält `globals.css` nur
      // noch die Import-Liste, die Regeln stehen in `app/styles/*.css`. In
      // welcher Teildatei die Regel liegt, ist für die Zusage („der Titel
      // kommt aus einer CSS-Variable, nicht aus einem statischen Absatz oder
      // einem im CSS fest verdrahteten deutschen Wort") ohnehin belanglos.
      //
      // Seit Issue #9 folgt der Titeltext der UI-Sprache (de/en-Umschalter),
      // nicht der Seitensprache: das CSS selbst enthält keinen Titeltext mehr,
      // nur noch einen Verweis auf `--label-alert-<typ>`, den
      // `apps/web/app/layout.tsx` aus `lib/i18n` setzt.
      const stylesDir = fileURLToPath(new URL('../../../apps/web/app/styles/', import.meta.url))
      const css = readdirSync(stylesDir)
        .filter((name) => name.endsWith('.css'))
        .map((name) => readFileSync(join(stylesDir, name), 'utf8'))
        .join('\n')
      const rule = new RegExp(`\\.alert-${alertType}::before\\s*\\{[^}]*content:\\s*var\\(--label-alert-${alertType}\\)`)
      expect(css).toMatch(rule)
    },
  )
})
