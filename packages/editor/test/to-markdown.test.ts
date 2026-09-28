import { describe, expect, it } from 'vitest'
import { getEditorSchema } from '../src/index.js'
import { markdownToDoc } from '../src/from-markdown.js'
import { docToMarkdown } from '../src/to-markdown.js'

// --- Tests für docToMarkdown (ProseMirror -> mdast -> Markdown) ---------------------
//
// Gezielte Fälle für PROGRAMMATISCH gebaute Docs (schema.node(...)/schema.text(...)
// direkt über prosemirror-model, wie es der Editor selbst tut — kein Umweg über
// markdownToDoc) — der Editor erzeugt Docs, die nie aus Markdown kamen, auch diese
// müssen kanonisch serialisieren. Der eigentliche Beweis für "Inverse von
// markdownToDoc" ist die Roundtrip-Suite (roundtrip.test.ts); diese Datei deckt jeden
// Node-Typ/Mark/Attr-Kombination für sich ab (auch solche, die im Golden-Korpus gar
// nicht vorkommen, z. B. eine Alert-Marker-only-Rekonstruktion).

const schema = getEditorSchema()

function doc(...content: Parameters<typeof schema.node>[2] extends infer C ? C[] : never) {
  return schema.node('doc', null, content.flat())
}

describe('docToMarkdown', () => {
  it('paragraph mit einfachem Text', () => {
    const d = doc(schema.node('paragraph', null, [schema.text('Hallo Welt.')]))
    expect(docToMarkdown(d)).toBe('Hallo Welt.\n')
  })

  it('heading 1-6', () => {
    for (let level = 1; level <= 6; level++) {
      const d = doc(schema.node('heading', { level }, [schema.text('Titel')]))
      expect(docToMarkdown(d)).toBe(`${'#'.repeat(level)} Titel\n`)
    }
  })

  describe('einzelne Marks', () => {
    it('bold', () => {
      const d = doc(
        schema.node('paragraph', null, [schema.text('fett', [schema.mark('bold')])]),
      )
      expect(docToMarkdown(d)).toBe('**fett**\n')
    })

    it('italic', () => {
      const d = doc(
        schema.node('paragraph', null, [schema.text('kursiv', [schema.mark('italic')])]),
      )
      expect(docToMarkdown(d)).toBe('*kursiv*\n')
    })

    it('strike', () => {
      const d = doc(
        schema.node('paragraph', null, [schema.text('gestrichen', [schema.mark('strike')])]),
      )
      expect(docToMarkdown(d)).toBe('~~gestrichen~~\n')
    })

    it('code', () => {
      const d = doc(
        schema.node('paragraph', null, [schema.text('const x = 1', [schema.mark('code')])]),
      )
      expect(docToMarkdown(d)).toBe('`const x = 1`\n')
    })
  })

  describe('Mark-Merging benachbarter Textknoten', () => {
    it('zwei angrenzende Textknoten mit identischem Mark-Set werden zu EINEM Lauf zusammengefasst', () => {
      const bold = schema.mark('bold')
      const d = doc(
        schema.node('paragraph', null, [schema.text('fett', [bold]), schema.text('fett2', [bold])]),
      )
      // NICHT "**fett****fett2**" (zwei separate strong-Läufe), sondern EIN Lauf.
      expect(docToMarkdown(d)).toBe('**fettfett2**\n')
    })

    it('zwei angrenzende unmarkierte Textknoten werden zu einem Textknoten zusammengefasst', () => {
      const d = doc(schema.node('paragraph', null, [schema.text('Hallo '), schema.text('Welt.')]))
      expect(docToMarkdown(d)).toBe('Hallo Welt.\n')
    })
  })

  describe('verschachtelte Marks (partielle Überlappung)', () => {
    it('bold außen, italic innen (Korpus-Form: "fett und *kursiv* darin")', () => {
      const bold = schema.mark('bold')
      const italic = schema.mark('italic')
      const d = doc(
        schema.node('paragraph', null, [
          schema.text('fett und ', [bold]),
          schema.text('verschachtelt kursiv', [bold, italic]),
          schema.text(' darin', [bold]),
        ]),
      )
      expect(docToMarkdown(d)).toBe('**fett und *verschachtelt kursiv* darin**\n')
    })

    it('italic außen, bold innen (umgekehrte Verschachtelung, algorithmisch KEIN Rang-Spezialfall)', () => {
      const bold = schema.mark('bold')
      const italic = schema.mark('italic')
      const d = doc(
        schema.node('paragraph', null, [
          schema.text('kursiv und ', [italic]),
          schema.text('verschachtelt fett', [bold, italic]),
          schema.text(' darin', [italic]),
        ]),
      )
      expect(docToMarkdown(d)).toBe('*kursiv und **verschachtelt fett** darin*\n')
    })
  })

  describe('Link-Mark', () => {
    it('literal: false -> reguläre [Text](url)-Form', () => {
      const link = schema.mark('link', { href: 'https://example.com/seite', literal: false })
      const d = doc(schema.node('paragraph', null, [schema.text('Ein Link', [link])]))
      expect(docToMarkdown(d)).toBe('[Ein Link](https://example.com/seite)\n')
    })

    it('literal: true, Text === URL -> Autolink-Literal (nackte URL)', () => {
      const link = schema.mark('link', { href: 'https://example.com/seite', literal: true })
      const d = doc(schema.node('paragraph', null, [schema.text('https://example.com/seite', [link])]))
      expect(docToMarkdown(d)).toBe('https://example.com/seite\n')
    })
  })

  describe('Bild (block-level -> mdast paragraph mit einem image-Kind)', () => {
    it('mit alt und title', () => {
      const d = doc(schema.node('image', { src: 'bild.png', alt: 'Alt-Text', title: 'Ein Titel' }))
      expect(docToMarkdown(d)).toBe('![Alt-Text](bild.png "Ein Titel")\n')
    })

    it('mit alt, ohne title (title: null wird nicht als leeres "" ausgegeben)', () => {
      const d = doc(schema.node('image', { src: 'bild.png', alt: 'Alt-Text', title: null }))
      expect(docToMarkdown(d)).toBe('![Alt-Text](bild.png)\n')
    })

    it('ohne alt, ohne title (beide null)', () => {
      const d = doc(schema.node('image', { src: 'bild.png', alt: null, title: null }))
      expect(docToMarkdown(d)).toBe('![](bild.png)\n')
    })

    it('mit width -> Obsidian-Suffix `|400` am Alt-Text', () => {
      const d = doc(schema.node('image', { src: 'bild.png', alt: 'Alt-Text', width: 400 }))
      expect(docToMarkdown(d)).toBe('![Alt-Text|400](bild.png)\n')
    })

    it('mit width + height -> `|400x300`', () => {
      const d = doc(schema.node('image', { src: 'bild.png', alt: 'd', width: 400, height: 300 }))
      expect(docToMarkdown(d)).toBe('![d|400x300](bild.png)\n')
    })

    it('width ohne alt -> `![|400]`', () => {
      const d = doc(schema.node('image', { src: 'bild.png', alt: null, width: 400 }))
      expect(docToMarkdown(d)).toBe('![|400](bild.png)\n')
    })
  })

  describe('Wikilink', () => {
    it('ohne Alias -> bare [[ziel]]', () => {
      const d = doc(
        schema.node('paragraph', null, [
          schema.text('Siehe '),
          schema.node('wikiLink', { target: 'betrieb/monitoring', alias: null }),
          schema.text('.'),
        ]),
      )
      expect(docToMarkdown(d)).toBe('Siehe [[betrieb/monitoring]].\n')
    })

    it('mit Alias -> [[ziel|alias]]', () => {
      const d = doc(
        schema.node('paragraph', null, [
          schema.node('wikiLink', { target: 'betrieb/monitoring', alias: 'Monitoring-Übersicht' }),
        ]),
      )
      expect(docToMarkdown(d)).toBe('[[betrieb/monitoring|Monitoring-Übersicht]]\n')
    })
  })

  it('harter Umbruch (hardBreak -> mdast break)', () => {
    const d = doc(
      schema.node('paragraph', null, [schema.text('Zeile eins'), schema.node('hardBreak'), schema.text('Zeile zwei')]),
    )
    expect(docToMarkdown(d)).toBe('Zeile eins\\\nZeile zwei\n')
  })

  describe('Codeblock', () => {
    it('mit language-Attribut', () => {
      const d = doc(schema.node('codeBlock', { language: 'ts' }, [schema.text('const x = 1')]))
      expect(docToMarkdown(d)).toBe('```ts\nconst x = 1\n```\n')
    })

    it('ohne Sprachangabe', () => {
      const d = doc(schema.node('codeBlock', { language: null }, [schema.text('plain')]))
      expect(docToMarkdown(d)).toBe('```\nplain\n```\n')
    })
  })

  it('horizontalRule -> thematicBreak', () => {
    const d = doc(
      schema.node('paragraph', null, [schema.text('Vorher.')]),
      schema.node('horizontalRule'),
      schema.node('paragraph', null, [schema.text('Nachher.')]),
    )
    expect(docToMarkdown(d)).toBe('Vorher.\n\n---\n\nNachher.\n')
  })

  it('blockquote (normales Zitat ohne Marker)', () => {
    const d = doc(schema.node('blockquote', null, [schema.node('paragraph', null, [schema.text('Ein Zitat.')])]))
    expect(docToMarkdown(d)).toBe('> Ein Zitat.\n')
  })

  describe('Listen', () => {
    it('verschachtelte Bullet-Liste (tight, spread: false)', () => {
      const item = (text: string, ...rest: ReturnType<typeof schema.node>[]) =>
        schema.node('listItem', null, [schema.node('paragraph', null, [schema.text(text)]), ...rest])
      const nested = schema.node('bulletList', null, [item('Verschachtelt A'), item('Verschachtelt B')])
      const d = doc(schema.node('bulletList', null, [item('Erster'), item('Zweiter', nested), item('Dritter')]))
      expect(docToMarkdown(d)).toBe('- Erster\n- Zweiter\n  - Verschachtelt A\n  - Verschachtelt B\n- Dritter\n')
    })

    it('geordnete Liste mit abweichendem Start-Wert', () => {
      const item = (text: string) => schema.node('listItem', null, [schema.node('paragraph', null, [schema.text(text)])])
      const d = doc(schema.node('orderedList', { start: 5 }, [item('Fünftens'), item('Sechstens')]))
      expect(docToMarkdown(d)).toBe('5. Fünftens\n6. Sechstens\n')
    })

    it('Task-Liste mit checked-Attributen (verschachtelt)', () => {
      const taskItem = (checked: boolean, text: string, ...rest: ReturnType<typeof schema.node>[]) =>
        schema.node('taskItem', { checked }, [schema.node('paragraph', null, [schema.text(text)]), ...rest])
      const nested = schema.node('taskList', null, [taskItem(false, 'Unteraufgabe offen'), taskItem(true, 'Unteraufgabe erledigt')])
      const d = doc(schema.node('taskList', null, [taskItem(false, 'Offen'), taskItem(true, 'Erledigt', nested)]))
      expect(docToMarkdown(d)).toBe(
        '- [ ] Offen\n- [x] Erledigt\n  - [ ] Unteraufgabe offen\n  - [x] Unteraufgabe erledigt\n',
      )
    })
  })

  describe('Tabelle', () => {
    it('mit Alignment-Attributen (Header-Zeile -> table.align)', () => {
      const cell = (type: 'tableHeader' | 'tableCell', align: 'left' | 'center' | 'right' | null, text: string) =>
        schema.node(type, { align }, [schema.node('paragraph', null, [schema.text(text)])])
      const header = schema.node('tableRow', null, [
        cell('tableHeader', 'left', 'Links'),
        cell('tableHeader', 'center', 'Zentriert'),
        cell('tableHeader', 'right', 'Rechts'),
      ])
      const row = schema.node('tableRow', null, [
        cell('tableCell', 'left', 'a'),
        cell('tableCell', 'center', 'b'),
        cell('tableCell', 'right', 'c'),
      ])
      const d = doc(schema.node('table', null, [header, row]))
      expect(docToMarkdown(d)).toBe(
        '| Links | Zentriert | Rechts |\n| :---- | :-------: | -----: |\n| a     |     b     |      c |\n',
      )
    })

    it('ohne Alignment (align: null überall)', () => {
      const cell = (type: 'tableHeader' | 'tableCell', text: string) =>
        schema.node(type, { align: null }, [schema.node('paragraph', null, [schema.text(text)])])
      const header = schema.node('tableRow', null, [cell('tableHeader', 'A'), cell('tableHeader', 'B')])
      const row = schema.node('tableRow', null, [cell('tableCell', 'a'), cell('tableCell', 'b')])
      const d = doc(schema.node('table', null, [header, row]))
      expect(docToMarkdown(d)).toBe('| A | B |\n| - | - |\n| a | b |\n')
    })

    // --- Befund I1 (Final-Review Phase 2b): Mehrblock-Zellen dürfen NICHT still
    // verlustig werden (bislang: cell.firstChild! ignoriert alles ab dem zweiten
    // Block) — Markdown-Tabellenzellen können ohnehin nur einen Absatz darstellen,
    // also Hard-Throw statt stillem Drop. Das Schema erlaubt content: 'block+' auf
    // tableCell/tableHeader (siehe @tiptap/extension-table), die UI verhindert das
    // Anlegen einer solchen Zelle erst ab Phase 2c — programmatisch (wie hier) ist
    // ein PM-Dokument mit einer Zwei-Absatz-Zelle also durchaus konstruierbar.
    it('Zelle mit einem Absatz bleibt unverändert grün (Bestand)', () => {
      const cell = schema.node('tableHeader', { align: null }, [
        schema.node('paragraph', null, [schema.text('erst')]),
      ])
      const header = schema.node('tableRow', null, [cell])
      const d = doc(schema.node('table', null, [header]))
      expect(docToMarkdown(d)).toBe('| erst |\n| ---- |\n')
    })

    it('Zelle mit ZWEI Absätzen: Hard-Throw statt stillem Verlust des zweiten Absatzes', () => {
      const cell = schema.node('tableHeader', { align: null }, [
        schema.node('paragraph', null, [schema.text('erst')]),
        schema.node('paragraph', null, [schema.text('zweit')]),
      ])
      const header = schema.node('tableRow', null, [cell])
      const d = doc(schema.node('table', null, [header]))
      expect(() => docToMarkdown(d)).toThrow(/Tabellenzelle/)
    })

    it('Zelle mit einem Nicht-Absatz-Block (z. B. bulletList): Hard-Throw', () => {
      const item = schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('Punkt')])])
      const cell = schema.node('tableHeader', { align: null }, [schema.node('bulletList', null, [item])])
      const header = schema.node('tableRow', null, [cell])
      const d = doc(schema.node('table', null, [header]))
      expect(() => docToMarkdown(d)).toThrow(/Tabellenzelle/)
    })
  })

  describe('YouTube-Embed (Node -> Paragraph mit Autolink-Literal, nackte URL-Zeile)', () => {
    it('youtubeEmbed serialisiert zur nackten URL-Zeile (byte-identischer Roundtrip)', () => {
      const md = 'https://youtu.be/dQw4w9WgXcQ\n'
      expect(docToMarkdown(markdownToDoc(md))).toBe(md)
    })
  })

  describe('Alert-Rückbau (Node -> Blockquote mit [!TYP]-Marker)', () => {
    it.each([
      ['note', 'NOTE'],
      ['tip', 'TIP'],
      ['important', 'IMPORTANT'],
      ['warning', 'WARNING'],
      ['caution', 'CAUTION'],
    ] as const)('alertType %s -> Marker [!%s] im ersten Absatz', (alertType, marker) => {
      const d = doc(
        schema.node('alert', { alertType }, [schema.node('paragraph', null, [schema.text('Der eigentliche Text.')])]),
      )
      expect(docToMarkdown(d)).toBe(`> [!${marker}]\n> Der eigentliche Text.\n`)
    })

    it('ohne markerOwnParagraph-Attr (Default false) -> Normalform: Marker in der ersten Body-Zeile', () => {
      // Programmatisch gebauter Alert OHNE explizites markerOwnParagraph — so erzeugt
      // ihn der Editor selbst (Default false, s. nodes/alert.ts) -> Normalform.
      const d = doc(
        schema.node('alert', { alertType: 'note' }, [
          schema.node('paragraph', null, [schema.text('Der eigentliche Text.')]),
        ]),
      )
      expect(docToMarkdown(d)).toBe('> [!NOTE]\n> Der eigentliche Text.\n')
    })

    it('markerOwnParagraph: true -> Marker-only-Form: eigener Marker-Absatz + Leerzeile vor dem Body', () => {
      const d = doc(
        schema.node('alert', { alertType: 'note', markerOwnParagraph: true }, [
          schema.node('paragraph', null, [schema.text('Der eigentliche Text.')]),
        ]),
      )
      expect(docToMarkdown(d)).toBe('> [!NOTE]\n>\n> Der eigentliche Text.\n')
    })

    it('Marker-only-Fall: erstes Kind ist KEIN Absatz (Alert beginnt direkt mit einer Liste) -> eigener Marker-Absatz', () => {
      const item = schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('Punkt eins')])])
      const d = doc(schema.node('alert', { alertType: 'warning' }, [schema.node('bulletList', null, [item])]))
      expect(docToMarkdown(d)).toBe('> [!WARNING]\n>\n> - Punkt eins\n')
    })

    it('erster Absatz beginnt mit einem Nicht-Text-Kind (Wikilink) -> Marker als eigener Textknoten davor', () => {
      const d = doc(
        schema.node('alert', { alertType: 'note' }, [
          schema.node('paragraph', null, [
            schema.node('wikiLink', { target: 'betrieb/monitoring', alias: null }),
            schema.text(' siehe dort.'),
          ]),
        ]),
      )
      expect(docToMarkdown(d)).toBe('> [!NOTE]\n> [[betrieb/monitoring]] siehe dort.\n')
    })
  })
})
