import { describe, expect, it } from 'vitest'
import { parseSnippet } from './snippet.js'

describe('parseSnippet', () => {
  it('liefert reinen Text ohne Markup als ein unhervorgehobenes Segment', () => {
    expect(parseSnippet('Deployments erfolgen über die CI-Pipeline.')).toEqual([
      { text: 'Deployments erfolgen über die CI-Pipeline.', highlighted: false },
    ])
  })

  it('leerer String liefert keine Segmente', () => {
    expect(parseSnippet('')).toEqual([])
  })

  it('ein einzelnes <b>-Paar wird als hervorgehobenes Segment erkannt', () => {
    expect(parseSnippet('Standardprozess für das <b>Deployment</b> in Produktion.')).toEqual([
      { text: 'Standardprozess für das ', highlighted: false },
      { text: 'Deployment', highlighted: true },
      { text: ' in Produktion.', highlighted: false },
    ])
  })

  it('mehrere getrennte <b>-Paare werden alle erkannt', () => {
    expect(parseSnippet('<b>Deployment</b> und <b>Rollback</b> gehören zusammen.')).toEqual([
      { text: 'Deployment', highlighted: true },
      { text: ' und ', highlighted: false },
      { text: 'Rollback', highlighted: true },
      { text: ' gehören zusammen.', highlighted: false },
    ])
  })

  it('ein <b> direkt am Anfang/Ende ohne umgebenden Text erzeugt kein leeres Segment davor/danach', () => {
    expect(parseSnippet('<b>Deployment</b>')).toEqual([{ text: 'Deployment', highlighted: true }])
  })

  it('leeres <b></b>-Paar erzeugt selbst kein Segment (Text davor/danach bleibt getrennt, aber unhervorgehoben)', () => {
    expect(parseSnippet('vorher<b></b>nachher')).toEqual([
      { text: 'vorher', highlighted: false },
      { text: 'nachher', highlighted: false },
    ])
  })

  it('verschachteltes <b> bleibt literaler Text innerhalb des äußeren Treffers', () => {
    expect(parseSnippet('<b>foo<b>bar</b>baz</b>')).toEqual([
      { text: 'foo<b>bar', highlighted: true },
      { text: 'baz</b>', highlighted: false },
    ])
  })

  it('ein verwaistes schließendes </b> ohne offenes <b> bleibt literaler Text', () => {
    expect(parseSnippet('vorher</b>nachher')).toEqual([{ text: 'vorher</b>nachher', highlighted: false }])
  })

  it('ein nie geschlossenes <b> (unbalanciert) bleibt literaler Text statt endlos hervorzuheben', () => {
    expect(parseSnippet('Text mit <b>offenem Tag ohne Ende')).toEqual([
      { text: 'Text mit <b>offenem Tag ohne Ende', highlighted: false },
    ])
  })

  it('ein </b> vor einem gültigen späteren Paar wird literal behandelt, das spätere Paar bleibt gültig', () => {
    expect(parseSnippet('</b>foo<b>bar</b>')).toEqual([
      { text: '</b>foo', highlighted: false },
      { text: 'bar', highlighted: true },
    ])
  })

  it('<script>-Tags im Snippet werden als reiner Text behandelt, nie als Markup interpretiert', () => {
    const input = 'Ergebnis <b>Deployment</b> <script>alert(1)</script> Ende'
    expect(parseSnippet(input)).toEqual([
      { text: 'Ergebnis ', highlighted: false },
      { text: 'Deployment', highlighted: true },
      { text: ' <script>alert(1)</script> Ende', highlighted: false },
    ])
  })

  it('nur <b>-Großschreibung oder Attribute werden NICHT als Markup interpretiert (exakter Match)', () => {
    expect(parseSnippet('<B>Deployment</B> und <b class="x">Rollback</b>')).toEqual([
      { text: '<B>Deployment</B> und <b class="x">Rollback</b>', highlighted: false },
    ])
  })

  it('alle Segmente eines wohlgeformten Snippets ergeben zusammen den Text ohne die <b>/</b>-Marker', () => {
    const input = 'Der <b>Health-Check</b> läuft nach jedem <b>Rollout</b> automatisch.'
    const rebuilt = parseSnippet(input)
      .map((s) => s.text)
      .join('')
    expect(rebuilt).toBe('Der Health-Check läuft nach jedem Rollout automatisch.')
  })
})
