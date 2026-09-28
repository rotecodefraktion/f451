import { describe, expect, it } from 'vitest'
import type { DiffBlock } from '@f451/markdown'
import { t as translate } from '../i18n/format.js'
import type { DotPaths, Params } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import { en } from '../i18n/messages/en/index.js'
import type { Messages } from '../i18n/types.js'
import { changedBlocks, dchangeModifierClass, dtagLabel, railLabel, stripHtmlToText, truncate } from './diff-view-model'

const tDe = (key: DotPaths<Messages>, params?: Params) => translate(de, key, params)
const tEn = (key: DotPaths<Messages>, params?: Params) => translate(en, key, params)

function block(kind: DiffBlock['kind'], html: string, anchor = 'c1'): DiffBlock {
  return { kind, html, anchor }
}

describe('stripHtmlToText', () => {
  it('entfernt Tags und normalisiert Whitespace', () => {
    expect(stripHtmlToText('<p>Hallo <strong>Welt</strong>\n  !</p>')).toBe('Hallo Welt !')
  })

  it('dekodiert die gängigen Entities', () => {
    expect(stripHtmlToText('<p>Tom &amp; Jerry &lt;3&gt; &quot;x&quot; &#39;y&#39;</p>')).toBe(
      `Tom & Jerry <3> "x" 'y'`,
    )
  })

  it('liefert einen leeren String für reines Markup ohne Text (z. B. nur ein Bild)', () => {
    expect(stripHtmlToText('<img src="x.png">')).toBe('')
  })
})

describe('truncate', () => {
  it('lässt kurze Texte unverändert', () => {
    expect(truncate('Kurzer Text', 90)).toBe('Kurzer Text')
  })

  it('kürzt am letzten Leerzeichen vor der Grenze und hängt „…" an', () => {
    const text = 'Dies ist ein langer Beispieltext, der definitiv über das Limit hinausgeht'
    const result = truncate(text, 30)
    expect(result.length).toBeLessThanOrEqual(31)
    expect(result.endsWith('…')).toBe(true)
    expect(result).not.toMatch(/ …$/) // kein Leerzeichen direkt vor der Ellipse
  })

  it('schneidet hart ab, wenn kein Leerzeichen nahe der Grenze liegt', () => {
    const text = 'A'.repeat(50)
    const result = truncate(text, 10)
    expect(result).toBe(`${'A'.repeat(10)}…`)
  })
})

describe('dchangeModifierClass / dtagLabel', () => {
  it('mappt added -> add / "Hinzugefügt" (DE) bzw. "Added" (EN)', () => {
    expect(dchangeModifierClass('added')).toBe('add')
    expect(dtagLabel(tDe, 'added')).toBe('Hinzugefügt')
    expect(dtagLabel(tEn, 'added')).toBe('Added')
  })

  it('mappt changed -> chg / "Geändert" (DE) bzw. "Changed" (EN)', () => {
    expect(dchangeModifierClass('changed')).toBe('chg')
    expect(dtagLabel(tDe, 'changed')).toBe('Geändert')
    expect(dtagLabel(tEn, 'changed')).toBe('Changed')
  })

  it('liefert null für removed (nutzt <details> statt .dchange/.dtag)', () => {
    expect(dchangeModifierClass('removed')).toBeNull()
    expect(dtagLabel(tDe, 'removed')).toBeNull()
  })

  it('liefert null für same (unmarkiert, "nackt")', () => {
    expect(dchangeModifierClass('same')).toBeNull()
    expect(dtagLabel(tDe, 'same')).toBeNull()
  })
})

describe('changedBlocks', () => {
  it('filtert same-Blöcke heraus, behält Reihenfolge der übrigen', () => {
    const blocks = [
      block('same', '<p>a</p>', 'c1'),
      block('added', '<p>b</p>', 'c2'),
      block('removed', '<p>c</p>', 'c3'),
      block('changed', '<p>d</p>', 'c4'),
    ]
    expect(changedBlocks(blocks).map((b) => b.anchor)).toEqual(['c2', 'c3', 'c4'])
  })

  it('liefert ein leeres Array, wenn es keine Änderungen gibt', () => {
    expect(changedBlocks([block('same', '<p>a</p>')])).toEqual([])
  })
})

describe('railLabel', () => {
  it('leitet das Label aus dem Textinhalt des Blocks ab (Inhalt bleibt unübersetzt)', () => {
    expect(railLabel(tDe, block('added', '<p>Ein neuer Absatz mit Inhalt.</p>'))).toBe('Ein neuer Absatz mit Inhalt.')
  })

  it('kürzt lange Blöcke', () => {
    const longText = 'Wort '.repeat(40).trim()
    const label = railLabel(tDe, block('changed', `<p>${longText}</p>`))
    expect(label.length).toBeLessThan(longText.length)
    expect(label.endsWith('…')).toBe(true)
  })

  it('fällt bei leerem Textinhalt auf ein generisches Label je Kind zurück (DE)', () => {
    expect(railLabel(tDe, block('added', '<img src="x.png">'))).toBe('Neuer Inhaltsblock')
    expect(railLabel(tDe, block('removed', '<img src="x.png">'))).toBe('Entfernter Inhaltsblock')
    expect(railLabel(tDe, block('changed', '<img src="x.png">'))).toBe('Geänderter Inhaltsblock')
  })

  it('generisches Label je Kind auf EN', () => {
    expect(railLabel(tEn, block('added', '<img src="x.png">'))).toBe('New content block')
    expect(railLabel(tEn, block('removed', '<img src="x.png">'))).toBe('Removed content block')
    expect(railLabel(tEn, block('changed', '<img src="x.png">'))).toBe('Changed content block')
  })
})
