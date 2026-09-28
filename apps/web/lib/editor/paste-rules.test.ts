import { describe, expect, it } from 'vitest'
import { classifyPaste } from './paste-rules.js'

describe('classifyPaste', () => {
  it('nackte URL ohne Selektion → autolink', () => {
    expect(classifyPaste('https://example.org/pfad', false)).toEqual({ kind: 'autolink' })
  })

  it('nackte URL MIT Selektion → link-selection', () => {
    expect(classifyPaste('https://example.org/pfad', true)).toEqual({ kind: 'link-selection' })
  })

  it('erkennt http UND https', () => {
    expect(classifyPaste('http://example.org', false)).toEqual({ kind: 'autolink' })
    expect(classifyPaste('https://example.org', false)).toEqual({ kind: 'autolink' })
  })

  it('erkennt www.-URLs ohne Protokoll', () => {
    expect(classifyPaste('www.example.org', false)).toEqual({ kind: 'autolink' })
  })

  it('trimmt umgebenden Whitespace vor der Erkennung', () => {
    expect(classifyPaste('  https://example.org  ', false)).toEqual({ kind: 'autolink' })
  })

  it('Nicht-URL-Text ohne Selektion → default', () => {
    expect(classifyPaste('Das ist ein normaler Satz.', false)).toEqual({ kind: 'default' })
  })

  it('Nicht-URL-Text MIT Selektion → default (keine automatische Verlinkung)', () => {
    expect(classifyPaste('Das ist ein normaler Satz.', true)).toEqual({ kind: 'default' })
  })

  it('Fließtext, der zufällig eine URL enthält, ist KEINE nackte URL → default', () => {
    expect(classifyPaste('siehe https://example.org für Details', false)).toEqual({ kind: 'default' })
  })

  it('leerer String → default', () => {
    expect(classifyPaste('', false)).toEqual({ kind: 'default' })
    expect(classifyPaste('   ', true)).toEqual({ kind: 'default' })
  })

  it('mehrzeiliger Text (auch wenn jede Zeile für sich eine URL wäre) → default', () => {
    expect(classifyPaste('https://example.org\nhttps://example.com', false)).toEqual({ kind: 'default' })
  })
})
