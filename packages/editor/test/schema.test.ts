import { describe, expect, it } from 'vitest'
import { getEditorSchema } from '../src/index.js'

// --- Schema-Tests für den Tiptap-Kern des Markdown-Dialekts ------------------------
//
// Bewusst reine Modell-Ebene: getEditorSchema() ruft getSchema(editorExtensions())
// aus @tiptap/core auf (headless, ohne EditorView) — kein DOM, kein jsdom nötig.
// Die Tests prüfen drei Dinge:
// 1. Vollständigkeits- UND Abwesenheitsliste der Node-/Mark-Namen (Dialekt-Umfang exakt
//    getroffen, nichts vergessen, nichts Ungeplantes eingeschleppt — z. B. keine von
//    StarterKit stillschweigend mitgebrachte History/Dropcursor/Underline).
// 2. Attribute und content-Expressions der beiden eigenen Nodes (alert, wikiLink).
// 3. nodeFromJSON-Smoke: für jeden Node-Typ lässt sich ein minimales JSON-Dokument
//    tatsächlich instanziieren (Attrs sind valide, content-Expression stimmt).

const EXPECTED_NODE_NAMES = [
  'doc',
  'text',
  'paragraph',
  'heading',
  'image',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'hardBreak',
  'alert',
  'wikiLink',
  'youtubeEmbed',
  'footnoteReference',
  'footnoteDefinition',
]

const EXPECTED_MARK_NAMES = ['bold', 'italic', 'strike', 'code', 'link']

// Namen, die eine unbedacht mitgeschleppte Extension einschleusen könnte (StarterKit-
// Defaults wie History/Dropcursor/Gapcursor sind reine Extensions ohne Node/Mark und
// tauchen daher hier nicht auf — die Abwesenheitsliste deckt trotzdem die
// Dialekt-fremden Marks/Nodes ab, die eine Verwechslung am ehesten nahelegen würde).
const FORBIDDEN_NAMES = ['underline', 'textStyle', 'color', 'highlight', 'subscript', 'superscript']

describe('getEditorSchema', () => {
  const schema = getEditorSchema()

  it('enthält exakt die erwarteten Node-Namen (Vollständigkeit)', () => {
    const actual = Object.keys(schema.nodes).sort()
    expect(actual).toEqual([...EXPECTED_NODE_NAMES].sort())
  })

  it('enthält exakt die erwarteten Mark-Namen (Vollständigkeit)', () => {
    const actual = Object.keys(schema.marks).sort()
    expect(actual).toEqual([...EXPECTED_MARK_NAMES].sort())
  })

  it('enthält keine Dialekt-fremden Marks/Nodes (Abwesenheit)', () => {
    for (const name of FORBIDDEN_NAMES) {
      expect(schema.nodes[name]).toBeUndefined()
      expect(schema.marks[name]).toBeUndefined()
    }
  })

  describe('alert-Node', () => {
    it('hat die Attribute alertType mit Default "note"', () => {
      const spec = schema.nodes.alert!
      expect(spec.spec.attrs?.alertType?.default).toBe('note')
    })

    it('hat die content-Expression block+', () => {
      expect(schema.nodes.alert!.spec.content).toBe('block+')
    })

    it('ist eine Block-Node (nicht inline)', () => {
      expect(schema.nodes.alert!.isInline).toBe(false)
    })
  })

  describe('wikiLink-Node', () => {
    it('hat die Attribute target (Pflicht) und alias (Default null)', () => {
      const spec = schema.nodes.wikiLink!
      expect('target' in (spec.spec.attrs ?? {})).toBe(true)
      expect(spec.spec.attrs?.alias?.default).toBeNull()
    })

    it('ist inline und atomar', () => {
      const spec = schema.nodes.wikiLink!
      expect(spec.isInline).toBe(true)
      expect(spec.isAtom).toBe(true)
    })
  })

  describe('youtubeEmbed-Node', () => {
    it('hat die Attribute url mit Default ""', () => {
      const spec = schema.nodes.youtubeEmbed!
      expect(spec.spec.attrs?.url?.default).toBe('')
    })

    it('ist eine Block-Node und atomar', () => {
      const spec = schema.nodes.youtubeEmbed!
      expect(spec.isInline).toBe(false)
      expect(spec.isAtom).toBe(true)
    })
  })

  describe('link-Mark', () => {
    it('hat das Attribut literal mit Default false', () => {
      const spec = schema.marks.link!
      expect(spec.spec.attrs?.literal?.default).toBe(false)
    })
  })

  describe('GFM-Tabellen-Alignment (align-Attr auf tableHeader/tableCell)', () => {
    it.each(['tableHeader', 'tableCell'] as const)(
      '%s hat das Attribut align mit Default null',
      (name) => {
        const spec = schema.nodes[name]!
        expect('align' in (spec.spec.attrs ?? {})).toBe(true)
        expect(spec.spec.attrs?.align?.default).toBeNull()
      },
    )

    // Tiptap 3.27 bringt auf TableCell/TableHeader bereits ein eingebautes
    // align-Attribut mit — rendert es aber als `style="text-align: …"`. Die
    // Lese-Pipeline (render.ts via mdast-util-to-hast) erzeugt dagegen ein
    // `align`-HTML-Attribut auf th/td. Dieser Test schützt das Markup-Override
    // (withAlignAttribute in extensions.ts): ohne es wäre das Attribut zwar da,
    // aber das gerenderte HTML wiche vom Lese-HTML ab. toDOM ist hier DOM-frei
    // aufrufbar, weil Tiptaps renderHTML reine Arrays/Objekte liefert.
    it.each(['tableHeader', 'tableCell'] as const)(
      '%s rendert align als HTML-Attribut (Markup der Lese-Pipeline), nicht als style',
      (name) => {
        const node = schema.nodeFromJSON({
          type: name,
          attrs: { align: 'center' },
          content: [{ type: 'paragraph' }],
        })
        const rendered = schema.nodes[name]!.spec.toDOM!(node) as [
          string,
          Record<string, unknown>,
          ...unknown[],
        ]
        expect(rendered[1]).toMatchObject({ align: 'center' })
        expect(rendered[1]).not.toHaveProperty('style')
      },
    )
  })

  describe('nodeFromJSON-Smoke pro Node-Typ', () => {
    it('paragraph mit Text', () => {
      const node = schema.nodeFromJSON({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hallo' }],
      })
      expect(node.type.name).toBe('paragraph')
    })

    it('heading mit level 1-6', () => {
      for (let level = 1; level <= 6; level++) {
        const node = schema.nodeFromJSON({
          type: 'heading',
          attrs: { level },
          content: [{ type: 'text', text: `H${level}` }],
        })
        expect(node.attrs.level).toBe(level)
      }
    })

    it('image mit src/alt/title', () => {
      const node = schema.nodeFromJSON({
        type: 'image',
        attrs: { src: '/bild.png', alt: 'Alt', title: 'Titel' },
      })
      expect(node.attrs.src).toBe('/bild.png')
      expect(node.attrs.alt).toBe('Alt')
      expect(node.attrs.title).toBe('Titel')
    })

    it('bulletList > listItem > paragraph (verschachtelt)', () => {
      const node = schema.nodeFromJSON({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
                  },
                ],
              },
            ],
          },
        ],
      })
      expect(node.type.name).toBe('bulletList')
    })

    it('orderedList > listItem', () => {
      const node = schema.nodeFromJSON({
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
          },
        ],
      })
      expect(node.type.name).toBe('orderedList')
    })

    it('taskList > taskItem (verschachtelt, mit checked-Attr)', () => {
      const node = schema.nodeFromJSON({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
              {
                type: 'taskList',
                content: [
                  {
                    type: 'taskItem',
                    attrs: { checked: false },
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
                  },
                ],
              },
            ],
          },
        ],
      })
      expect(node.type.name).toBe('taskList')
    })

    it('table > tableRow > tableHeader/tableCell', () => {
      const node = schema.nodeFromJSON({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph' }] },
              { type: 'tableHeader', content: [{ type: 'paragraph' }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph' }] },
              { type: 'tableCell', content: [{ type: 'paragraph' }] },
            ],
          },
        ],
      })
      expect(node.type.name).toBe('table')
    })

    it('tableHeader/tableCell mit align-Attr (GFM-Alignment)', () => {
      // Zwei Werte pro Node-Typ, damit ein versehentlich hartkodierter Default
      // (statt Durchreichen des Attributs) auffliegen würde.
      const header = schema.nodeFromJSON({
        type: 'tableHeader',
        attrs: { align: 'center' },
        content: [{ type: 'paragraph' }],
      })
      expect(header.attrs.align).toBe('center')

      const headerRight = schema.nodeFromJSON({
        type: 'tableHeader',
        attrs: { align: 'right' },
        content: [{ type: 'paragraph' }],
      })
      expect(headerRight.attrs.align).toBe('right')

      const cell = schema.nodeFromJSON({
        type: 'tableCell',
        attrs: { align: 'center' },
        content: [{ type: 'paragraph' }],
      })
      expect(cell.attrs.align).toBe('center')

      const cellRight = schema.nodeFromJSON({
        type: 'tableCell',
        attrs: { align: 'right' },
        content: [{ type: 'paragraph' }],
      })
      expect(cellRight.attrs.align).toBe('right')
    })

    it('codeBlock mit language-Attr', () => {
      const node = schema.nodeFromJSON({
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [{ type: 'text', text: 'const x = 1' }],
      })
      expect(node.attrs.language).toBe('ts')
    })

    it('blockquote > paragraph', () => {
      const node = schema.nodeFromJSON({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Zitat' }] }],
      })
      expect(node.type.name).toBe('blockquote')
    })

    it('horizontalRule', () => {
      const node = schema.nodeFromJSON({ type: 'horizontalRule' })
      expect(node.type.name).toBe('horizontalRule')
    })

    it('hardBreak innerhalb eines paragraph', () => {
      const node = schema.nodeFromJSON({
        type: 'paragraph',
        content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }],
      })
      expect(node.type.name).toBe('paragraph')
    })

    it('alert mit alertType und block-Inhalt', () => {
      const node = schema.nodeFromJSON({
        type: 'alert',
        attrs: { alertType: 'warning' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Achtung' }] }],
      })
      expect(node.attrs.alertType).toBe('warning')
    })

    it('wikiLink mit target/alias', () => {
      const node = schema.nodeFromJSON({
        type: 'wikiLink',
        attrs: { target: 'betrieb/monitoring', alias: 'Monitoring' },
      })
      expect(node.attrs.target).toBe('betrieb/monitoring')
      expect(node.attrs.alias).toBe('Monitoring')
    })

    it('youtubeEmbed mit url-Attr', () => {
      const node = schema.nodeFromJSON({
        type: 'youtubeEmbed',
        attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' },
      })
      expect(node.attrs.url).toBe('https://youtu.be/dQw4w9WgXcQ')
    })

    it('text mit link-Mark (literal-Attr)', () => {
      const node = schema.nodeFromJSON({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'https://example.com',
            marks: [{ type: 'link', attrs: { href: 'https://example.com', literal: true } }],
          },
        ],
      })
      expect(node.type.name).toBe('paragraph')
    })
  })
})
