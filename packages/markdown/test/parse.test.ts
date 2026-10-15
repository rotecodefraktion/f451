import { describe, expect, it } from 'vitest'
import { linkContext, parsePage } from '../src/parse.js'

const doc = `---
id: 8f3ka2
title: Deployment
tags: [betrieb]
---

# Ignorierte H1 (Frontmatter-Titel gewinnt)

Siehe [[betrieb/monitoring]] und [[Monitoring|die Monitoring-Seite]].

Relativer Link: [Runbook](../runbooks/index.md) und ein [externer](https://example.com).

## Abschnitt Eins

### Unterpunkt

![Diagramm](_media/arch.drawio.svg)
`

describe('parsePage', () => {
  it('extrahiert Wikilinks und relative Links, keine externen und keine Bilder', () => {
    const p = parsePage(doc)
    expect(p.links).toEqual([
      {
        rawTarget: 'betrieb/monitoring',
        kind: 'wikilink',
        text: 'betrieb/monitoring',
        context: 'Siehe betrieb/monitoring und die Monitoring-Seite.',
      },
      {
        rawTarget: 'Monitoring',
        kind: 'wikilink',
        text: 'die Monitoring-Seite',
        context: 'Siehe betrieb/monitoring und die Monitoring-Seite.',
      },
      {
        rawTarget: '../runbooks/index.md',
        kind: 'relative',
        text: 'Runbook',
        context: 'Relativer Link: Runbook und ein externer.',
      },
    ])
  })

  it('extrahiert Headings mit Slugs (ohne das Titel-H1 zu verlieren)', () => {
    const p = parsePage(doc)
    expect(p.headings).toEqual([
      { depth: 1, text: 'Ignorierte H1 (Frontmatter-Titel gewinnt)', slug: 'ignorierte-h1-frontmatter-titel-gewinnt' },
      { depth: 2, text: 'Abschnitt Eins', slug: 'abschnitt-eins' },
      { depth: 3, text: 'Unterpunkt', slug: 'unterpunkt' },
    ])
  })

  it('Titel: Frontmatter gewinnt; ohne Frontmatter erstes H1; sonst undefined', () => {
    expect(parsePage(doc).title).toBe('Deployment')
    expect(parsePage('# Nur H1\n\ntext').title).toBe('Nur H1')
    expect(parsePage('nur text').title).toBeUndefined()
  })

  it('transportiert Frontmatter-Fehler aus Task 1', () => {
    const p = parsePage('---\nid: 42\n---\n\ntext')
    expect(p.frontmatterErrors).toContain('id: muss ein String sein')
  })

  it('Anker-Links (#...) und mailto werden nicht als interne Links extrahiert', () => {
    const p = parsePage('[a](#abschnitt) [b](mailto:x@y.z) [c](./echt.md)')
    expect(p.links).toEqual([
      { rawTarget: './echt.md', kind: 'relative', text: 'c', context: 'a b c' },
    ])
  })

  it('Heading mit Alias-Wikilink: Heading-Text nutzt den Alias, nicht das Roh-Ziel', () => {
    const p = parsePage('## See [[Foo|Bar Alias]]')
    expect(p.headings).toEqual([{ depth: 2, text: 'See Bar Alias', slug: 'see-bar-alias' }])
  })

  it('doppelte Headings bekommen eindeutige, fortlaufend nummerierte Slugs', () => {
    const p = parsePage('## Setup\n\ntext\n\n## Setup\n\nmehr text')
    expect(p.headings).toEqual([
      { depth: 2, text: 'Setup', slug: 'setup' },
      { depth: 2, text: 'Setup', slug: 'setup-1' },
    ])
  })

  it('Umlaute im Heading bleiben im Slug erhalten', () => {
    const p = parsePage('## Größe ändern')
    expect(p.headings).toEqual([{ depth: 2, text: 'Größe ändern', slug: 'größe-ändern' }])
  })
})

describe('parsePage: link context', () => {
  const contextOf = (md: string): string[] => parsePage(md).links.map((l) => l.context)

  it('short paragraph: whole text without ellipsis', () => {
    expect(contextOf('Mehr dazu in [[Monitoring]] nachlesen.')).toEqual([
      'Mehr dazu in Monitoring nachlesen.',
    ])
  })

  it('long paragraph: cut on both sides with ellipsis and no half words', () => {
    const md = `${'alpha '.repeat(30)}[Ziel](./ziel.md)${' omega'.repeat(30)}`
    expect(contextOf(md)).toEqual([`…${'alpha '.repeat(13)}Ziel${' omega'.repeat(13)}…`])
  })

  it('link at the start: no leading ellipsis', () => {
    const md = `[Ziel](./ziel.md)${' omega'.repeat(30)}`
    expect(contextOf(md)).toEqual([`Ziel${' omega'.repeat(13)}…`])
  })

  it('link at the end: no trailing ellipsis', () => {
    const md = `${'alpha '.repeat(30)}[[Ziel]]`
    expect(contextOf(md)).toEqual([`…${'alpha '.repeat(13)}Ziel`])
  })

  it('link in a list item', () => {
    expect(contextOf('- Punkt mit [[Ziel]] drin\n- anderer Punkt')).toEqual(['Punkt mit Ziel drin'])
  })

  it('link in a table cell: only that cell', () => {
    const md = '| A | B |\n|---|---|\n| x [[Ziel]] y | anderes |'
    expect(contextOf(md)).toEqual(['x Ziel y'])
  })

  it('link in a heading', () => {
    expect(contextOf('## Siehe [[Ziel|Alias]] hier')).toEqual(['Siehe Alias hier'])
  })

  it('same word earlier in the paragraph: context centred on the real link', () => {
    const md = `Ziel ${'filler '.repeat(20)}[Ziel](./ziel.md) danach.`
    expect(contextOf(md)).toEqual([`…${'filler '.repeat(11)}Ziel danach.`])
  })

  it('newline inside the paragraph collapses to a space', () => {
    expect(contextOf('Erste Zeile mit\n[[Ziel]] und\nzweite Zeile')).toEqual([
      'Erste Zeile mit Ziel und zweite Zeile',
    ])
  })
})

describe('linkContext', () => {
  it('returns the whole block when it fits', () => {
    expect(linkContext('a b c', 2, 3)).toBe('a b c')
  })

  it('collapses whitespace runs and trims the outer ends', () => {
    expect(linkContext('  foo   bar\n\tbaz  ', 8, 11)).toBe('foo bar baz')
  })

  it('drops a partial word on both sides and marks the cuts', () => {
    expect(linkContext('one two three LINK four five six', 14, 18, 8)).toBe('…three LINK four…')
  })

  it('keeps whole words when the cut falls on a word boundary', () => {
    expect(linkContext('aaa bbb LINK ccc ddd', 8, 12, 4)).toBe('…bbb LINK ccc…')
  })

  it('a single word longer than the radius leaves only the ellipsis', () => {
    expect(linkContext('Donaudampfschifffahrt LINK', 22, 26, 5)).toBe('…LINK')
  })

  it('no ellipsis when the text is exactly radius long', () => {
    expect(linkContext('abc LINK def', 4, 8, 4)).toBe('abc LINK def')
  })
})
