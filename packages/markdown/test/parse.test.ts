import { describe, expect, it } from 'vitest'
import { parsePage } from '../src/parse.js'

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
      { rawTarget: 'betrieb/monitoring', kind: 'wikilink', text: 'betrieb/monitoring' },
      { rawTarget: 'Monitoring', kind: 'wikilink', text: 'die Monitoring-Seite' },
      { rawTarget: '../runbooks/index.md', kind: 'relative', text: 'Runbook' },
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
    expect(p.links).toEqual([{ rawTarget: './echt.md', kind: 'relative', text: 'c' }])
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
