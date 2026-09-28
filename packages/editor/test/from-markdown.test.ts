import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectUnsupported, markdownToDoc, UnsupportedMarkdownError } from '../src/from-markdown.js'
import { parseMarkdownTree } from '@f451/markdown'

// --- Tests für markdownToDoc (mdast -> ProseMirror) --------------------------------
//
// Ein Testfall pro Konstrukt aus der Brief-Liste: Eingabe-Markdown -> erwartete
// Doc-Struktur, verglichen über doc.toJSON()-Teilbäume (nicht das gesamte Dokument —
// das koppelt die Tests unnötig an paragraph-Wrapping-Details, die woanders geprüft
// werden). Reine Modellebene: kein DOM, kein jsdom (markdownToDoc arbeitet nur mit
// prosemirror-model). Am Ende: Smoke-Test über den gesamten Golden-Korpus.

const CANONICAL_DIR = fileURLToPath(new URL('../../markdown/test/fixtures/canonical/', import.meta.url))

describe('markdownToDoc', () => {
  it('paragraph mit einfachem Text', () => {
    const doc = markdownToDoc('Hallo Welt.')
    expect(doc.toJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hallo Welt.' }] }],
    })
  })

  it('heading 1-6', () => {
    for (let level = 1; level <= 6; level++) {
      const doc = markdownToDoc(`${'#'.repeat(level)} Titel`)
      const [heading] = doc.toJSON().content
      expect(heading).toEqual({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: 'Titel' }],
      })
    }
  })

  it('mehrere Marks auf einem Textknoten (bold+italic)', () => {
    const doc = markdownToDoc('Das ist ***fett-kursiv***.')
    const [paragraph] = doc.toJSON().content
    const marked = paragraph.content.find((n: { text?: string }) => n.text === 'fett-kursiv')
    expect(marked.marks).toEqual(
      expect.arrayContaining([{ type: 'bold' }, { type: 'italic' }]),
    )
    expect(marked.marks).toHaveLength(2)
  })

  it('Inline-Code mit Sonderzeichen', () => {
    const doc = markdownToDoc('Ein `<Foo & "Bar">`-Code.')
    const [paragraph] = doc.toJSON().content
    const code = paragraph.content.find((n: { marks?: unknown[] }) => n.marks)
    expect(code).toEqual({ type: 'text', text: '<Foo & "Bar">', marks: [{ type: 'code' }] })
  })

  it('Strikethrough (GFM delete)', () => {
    const doc = markdownToDoc('Das ist ~~gestrichen~~.')
    const [paragraph] = doc.toJSON().content
    const marked = paragraph.content.find((n: { text?: string }) => n.text === 'gestrichen')
    expect(marked.marks).toEqual([{ type: 'strike' }])
  })

  it('regulärer Link mit Titel (literal: false)', () => {
    const doc = markdownToDoc('[Text](https://example.com/seite "Ein Titel")')
    const [paragraph] = doc.toJSON().content
    expect(paragraph.content[0]).toEqual({
      type: 'text',
      text: 'Text',
      marks: [{ type: 'link', attrs: expect.objectContaining({ href: 'https://example.com/seite', literal: false }) }],
    })
  })

  it('Autolink-Literal (https) -> Link-Mark mit literal: true', () => {
    const doc = markdownToDoc('Siehe https://example.com/seite für Details.')
    const [paragraph] = doc.toJSON().content
    const linked = paragraph.content.find((n: { marks?: unknown[] }) => n.marks?.length)
    expect(linked).toEqual({
      type: 'text',
      text: 'https://example.com/seite',
      marks: [{ type: 'link', attrs: expect.objectContaining({ href: 'https://example.com/seite', literal: true }) }],
    })
  })

  it('Autolink-Literal (www.) -> literal: true, href mit http://-Präfix', () => {
    const doc = markdownToDoc('Siehe www.example.com für Details.')
    const [paragraph] = doc.toJSON().content
    const linked = paragraph.content.find((n: { marks?: unknown[] }) => n.marks?.length)
    expect(linked.marks[0]).toEqual({
      type: 'link',
      attrs: expect.objectContaining({ href: 'http://www.example.com', literal: true }),
    })
  })

  it('Bild mit Titel (eigener Block, da @tiptap/extension-image group: "block" ist)', () => {
    const doc = markdownToDoc('![Alt-Text](bild.png "Ein Titel")')
    const [image] = doc.toJSON().content
    expect(image).toEqual({
      type: 'image',
      attrs: expect.objectContaining({ src: 'bild.png', alt: 'Alt-Text', title: 'Ein Titel' }),
    })
  })

  it('Bild mit Breiten-Suffix `![Alt|400]` -> width-Attribut, Alt bereinigt', () => {
    const [image] = markdownToDoc('![Programmablauf|400](_media/pa.drawio.svg)').toJSON().content
    expect(image).toEqual({
      type: 'image',
      attrs: expect.objectContaining({ src: '_media/pa.drawio.svg', alt: 'Programmablauf', width: 400, height: null }),
    })
  })

  it('Bild mit Breite+Höhe `![Alt|400x300]` -> width + height', () => {
    const [image] = markdownToDoc('![d|400x300](x.png)').toJSON().content
    expect(image.attrs).toEqual(expect.objectContaining({ alt: 'd', width: 400, height: 300 }))
  })

  it('Bild ohne Suffix -> kein width (null), Alt unverändert', () => {
    const [image] = markdownToDoc('![ganz normal](x.png)').toJSON().content
    expect(image.attrs).toEqual(expect.objectContaining({ alt: 'ganz normal', width: null, height: null }))
  })

  it('Text und Bild gemischt in einem Absatz -> Split paragraph/image/paragraph', () => {
    const doc = markdownToDoc('Text vor ![alt](bild.png) Text danach.')
    expect(doc.toJSON().content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Text vor ' }] },
      { type: 'image', attrs: expect.objectContaining({ src: 'bild.png', alt: 'alt' }) },
      { type: 'paragraph', content: [{ type: 'text', text: ' Text danach.' }] },
    ])
  })

  it('Wikilink ohne Alias', () => {
    const doc = markdownToDoc('Siehe [[betrieb/monitoring]].')
    const [paragraph] = doc.toJSON().content
    const wikiLink = paragraph.content.find((n: { type: string }) => n.type === 'wikiLink')
    expect(wikiLink.attrs).toEqual(expect.objectContaining({ target: 'betrieb/monitoring', alias: null }))
  })

  it('Wikilink mit Alias', () => {
    const doc = markdownToDoc('Siehe [[betrieb/monitoring|Monitoring]].')
    const [paragraph] = doc.toJSON().content
    const wikiLink = paragraph.content.find((n: { type: string }) => n.type === 'wikiLink')
    expect(wikiLink.attrs).toEqual(
      expect.objectContaining({ target: 'betrieb/monitoring', alias: 'Monitoring' }),
    )
  })

  it('harter Umbruch: zwei Leerzeichen am Zeilenende', () => {
    const doc = markdownToDoc('Zeile eins  \nZeile zwei')
    const [paragraph] = doc.toJSON().content
    expect(paragraph.content).toEqual([
      { type: 'text', text: 'Zeile eins' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Zeile zwei' },
    ])
  })

  it('harter Umbruch: Backslash am Zeilenende', () => {
    const doc = markdownToDoc('Zeile eins\\\nZeile zwei')
    const [paragraph] = doc.toJSON().content
    expect(paragraph.content).toEqual([
      { type: 'text', text: 'Zeile eins' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Zeile zwei' },
    ])
  })

  it('Codeblock mit language-Attribut', () => {
    const doc = markdownToDoc('```ts\nconst x = 1\n```')
    const [codeBlock] = doc.toJSON().content
    expect(codeBlock).toEqual({
      type: 'codeBlock',
      attrs: expect.objectContaining({ language: 'ts' }),
      content: [{ type: 'text', text: 'const x = 1' }],
    })
  })

  it('Codeblock ohne Sprachangabe -> language: null', () => {
    const doc = markdownToDoc('```\nplain\n```')
    const [codeBlock] = doc.toJSON().content
    expect(codeBlock.attrs).toEqual(expect.objectContaining({ language: null }))
  })

  it('verschachtelte Bullet-Liste', () => {
    const doc = markdownToDoc('- Erster\n- Zweiter\n  - Verschachtelt A\n  - Verschachtelt B\n- Dritter')
    const [list] = doc.toJSON().content
    expect(list.type).toBe('bulletList')
    expect(list.content).toHaveLength(3)
    const [, second] = list.content
    expect(second.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Zweiter' }],
    })
    expect(second.content[1].type).toBe('bulletList')
    expect(second.content[1].content).toHaveLength(2)
  })

  it('geordnete Liste', () => {
    const doc = markdownToDoc('1. Erstens\n2. Zweitens\n3. Drittens')
    const [list] = doc.toJSON().content
    expect(list.type).toBe('orderedList')
    expect(list.attrs).toEqual(expect.objectContaining({ start: 1 }))
    expect(list.content).toHaveLength(3)
  })

  it('geordnete Liste mit abweichendem Start-Wert', () => {
    const doc = markdownToDoc('5. Fünftens\n6. Sechstens')
    const [list] = doc.toJSON().content
    expect(list.attrs).toEqual(expect.objectContaining({ start: 5 }))
  })

  it('Task-Liste mit checked-Attributen (verschachtelt)', () => {
    const doc = markdownToDoc('- [ ] Offen\n- [x] Erledigt\n  - [ ] Unteraufgabe offen\n  - [x] Unteraufgabe erledigt')
    const [taskList] = doc.toJSON().content
    expect(taskList.type).toBe('taskList')
    expect(taskList.content[0].attrs).toEqual(expect.objectContaining({ checked: false }))
    expect(taskList.content[1].attrs).toEqual(expect.objectContaining({ checked: true }))
    const nested = taskList.content[1].content[1]
    expect(nested.type).toBe('taskList')
    expect(nested.content[0].attrs).toEqual(expect.objectContaining({ checked: false }))
    expect(nested.content[1].attrs).toEqual(expect.objectContaining({ checked: true }))
  })

  it('Tabelle: Header-Zeile -> tableHeader, Alignment als Attr', () => {
    const md = '| Links | Zentriert | Rechts |\n| :---- | :-------: | -----: |\n| a | b | c |'
    const doc = markdownToDoc(md)
    const [table] = doc.toJSON().content
    expect(table.type).toBe('table')
    const [headerRow, dataRow] = table.content
    expect(headerRow.content.map((cell: { type: string }) => cell.type)).toEqual([
      'tableHeader',
      'tableHeader',
      'tableHeader',
    ])
    expect(headerRow.content.map((cell: { attrs: { align: unknown } }) => cell.attrs.align)).toEqual([
      'left',
      'center',
      'right',
    ])
    expect(dataRow.content.map((cell: { type: string }) => cell.type)).toEqual(['tableCell', 'tableCell', 'tableCell'])
    expect(dataRow.content.map((cell: { attrs: { align: unknown } }) => cell.attrs.align)).toEqual([
      'left',
      'center',
      'right',
    ])
  })

  it('Tabelle ohne Alignment-Marker: alle Zellen tragen align: null', () => {
    const md = '| A | B |\n| --- | --- |\n| a | b |'
    const doc = markdownToDoc(md)
    const [table] = doc.toJSON().content
    const [headerRow, dataRow] = table.content
    expect(headerRow.content.map((cell: { attrs: { align: unknown } }) => cell.attrs.align)).toEqual([
      null,
      null,
    ])
    expect(dataRow.content.map((cell: { attrs: { align: unknown } }) => cell.attrs.align)).toEqual([
      null,
      null,
    ])
  })

  it('thematicBreak -> horizontalRule', () => {
    const doc = markdownToDoc('Vorher.\n\n---\n\nNachher.')
    const [, hr] = doc.toJSON().content
    expect(hr).toEqual({ type: 'horizontalRule' })
  })

  it('normales Blockquote (ohne Marker) bleibt blockquote', () => {
    const doc = markdownToDoc('> Ein ganz normales Zitat.')
    const [blockquote] = doc.toJSON().content
    expect(blockquote.type).toBe('blockquote')
    expect(blockquote.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Ein ganz normales Zitat.' }],
    })
  })

  // --- Befund I2 (Final-Review Phase 2b): leeres Blockquote darf nicht crashen -----
  //
  // '>\n' ist valides Markdown (ein leeres Zitat), das ein Nutzer im Roh-Modus tippen
  // kann. Der Nicht-Alert-Zweig von convertBlockquote nutzte — anders als der
  // Alert-Zweig direkt darüber — bislang NICHT nonEmptyBlockContent, wodurch
  // schema.node('blockquote', null, []) mit einer leeren Kindliste aufgerufen wurde;
  // 'blockquote' verlangt aber content: 'block+' (mind. ein Block), was PM mit
  // `RangeError: Invalid content for node blockquote` quittiert.
  it('leeres Blockquote ("> ") crasht nicht, sondern liefert ein blockquote mit einem leeren Absatz', () => {
    const doc = markdownToDoc('>\n')
    const [blockquote] = doc.toJSON().content
    expect(blockquote.type).toBe('blockquote')
    // nonEmptyBlockContent füllt mit genau einem leeren paragraph auf (derselbe
    // Lückenfüller wie beim Marker-only-Alert ohne Restkörper, s. from-markdown.ts).
    expect(blockquote.content).toEqual([{ type: 'paragraph' }])
  })

  describe('Alert-Umbau (Blockquote + Marker -> alert-Node)', () => {
    it.each([
      ['NOTE', 'note'],
      ['TIP', 'tip'],
      ['IMPORTANT', 'important'],
      ['WARNING', 'warning'],
      ['CAUTION', 'caution'],
    ])('[!%s] -> alertType %s, Marker aus dem ersten Absatz entfernt', (marker, alertType) => {
      const doc = markdownToDoc(`> [!${marker}]\n> Der eigentliche Text.`)
      const [alert] = doc.toJSON().content
      expect(alert.type).toBe('alert')
      // markerOwnParagraph: false — Marker und Text stehen im SELBEN Absatz
      // (Soft-Break-Form); Quelltreue-Attr für den Roundtrip, s. nodes/alert.ts.
      expect(alert.attrs).toEqual(expect.objectContaining({ alertType, markerOwnParagraph: false }))
      expect(alert.content).toEqual([
        { type: 'paragraph', content: [{ type: 'text', text: 'Der eigentliche Text.' }] },
      ])
    })

    it('Marker-only-Absatz: der leere erste Absatz entfällt komplett, markerOwnParagraph konserviert die Quellform', () => {
      const doc = markdownToDoc('> [!NOTE]\n>\n> Text danach.')
      const [alert] = doc.toJSON().content
      expect(alert.type).toBe('alert')
      expect(alert.attrs).toEqual(
        expect.objectContaining({ alertType: 'note', markerOwnParagraph: true }),
      )
      expect(alert.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'Text danach.' }] }])
    })
  })

  describe('YouTube-Embed (Spec §6: YouTube-URL allein auf einer Zeile -> youtubeEmbed-Node)', () => {
    it('YouTube-Zeile wird zum youtubeEmbed-Node (URL bleibt vollständig erhalten)', () => {
      const doc = markdownToDoc('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s\n')
      const node = doc.child(0)
      expect(node.type.name).toBe('youtubeEmbed')
      expect(node.attrs.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')
    })

    it('YouTube-URL im Satz bleibt Paragraph mit Link', () => {
      const doc = markdownToDoc('Siehe https://www.youtube.com/watch?v=dQw4w9WgXcQ dazu.\n')
      expect(doc.child(0).type.name).toBe('paragraph')
    })
  })

  describe('UnsupportedMarkdownError', () => {
    it('wirft für rohes HTML (Typ + Zeile)', () => {
      let caught: unknown
      try {
        markdownToDoc('Ein Absatz.\n\n<div>roh</div>')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(UnsupportedMarkdownError)
      const err = caught as InstanceType<typeof UnsupportedMarkdownError>
      expect(err.nodeType).toBe('html')
      expect(err.line).toBe(3)
    })

    it('wirft für inline-HTML (Typ + Zeile)', () => {
      let caught: unknown
      try {
        markdownToDoc('Ein <b>fett</b> Wort.')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(UnsupportedMarkdownError)
      expect((caught as InstanceType<typeof UnsupportedMarkdownError>).nodeType).toBe('html')
    })

    it('wirft für Fußnoten-Referenz (Typ + Zeile)', () => {
      let caught: unknown
      try {
        markdownToDoc('Text mit Fußnote[^1].\n\n[^1]: Die Fußnote.')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(UnsupportedMarkdownError)
      const err = caught as InstanceType<typeof UnsupportedMarkdownError>
      expect(err.nodeType).toBe('footnoteReference')
      expect(err.line).toBe(1)
    })

    it('wirft für Referenz-Definitionen/-Links/-Bilder', () => {
      expect(() => markdownToDoc('[label]: /url\n\nSiehe [label].')).toThrow(UnsupportedMarkdownError)
      expect(() => markdownToDoc('![alt][img]\n\n[img]: /bild.png')).toThrow(UnsupportedMarkdownError)
      expect(() => markdownToDoc('Ein [Link][ref].\n\n[ref]: /ziel')).toThrow(UnsupportedMarkdownError)
    })
  })

  describe('collectUnsupported', () => {
    it('liefert ALLE Befunde eines Dokuments statt beim ersten zu werfen', () => {
      const tree = parseMarkdownTree('<div>a</div>\n\nText[^1] mit Fußnote.\n\n[^1]: Erklärung.')
      const findings = collectUnsupported(tree)
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'html' }),
          expect.objectContaining({ type: 'footnoteReference' }),
          expect.objectContaining({ type: 'footnoteDefinition' }),
        ]),
      )
      expect(findings).toHaveLength(3)
    })

    it('liefert eine leere Liste für ein vollständig unterstütztes Dokument', () => {
      const tree = parseMarkdownTree('# Titel\n\nEin Absatz mit **fett**.')
      expect(collectUnsupported(tree)).toEqual([])
    })
  })

  describe('Golden-Korpus: Smoke-Test — jede Fixture muss ohne Fehler einlesbar sein', () => {
    const files = readdirSync(CANONICAL_DIR).filter((file) => file.endsWith('.md'))

    it('deckt mindestens die bekannten Fixtures ab (Canary gegen leeres Glob)', () => {
      expect(files.length).toBeGreaterThan(5)
    })

    it.each(files)('%s wird ohne Fehler zu einem doc konvertiert', (file) => {
      const markdown = readFileSync(`${CANONICAL_DIR}${file}`, 'utf8')
      const doc = markdownToDoc(markdown)
      expect(doc.type.name).toBe('doc')
      expect(() => doc.check()).not.toThrow()
    })
  })
})
