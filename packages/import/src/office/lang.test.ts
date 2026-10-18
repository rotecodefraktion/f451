import { describe, expect, it } from 'vitest'
import { detectLang } from './lang.js'

// Invented text.
const GERMAN =
  'Dieses Handbuch beschreibt den Betrieb des Netzwerks an allen Standorten. Die Mitarbeiter finden hier die ' +
  'wichtigsten Regeln für den Zugang, die Pflege der Geräte und die Meldung von Störungen. Jede Abteilung ist ' +
  'verpflichtet, die Vorgaben einzuhalten und Änderungen rechtzeitig mitzuteilen.'
const ENGLISH =
  'This handbook describes how the network is run at every site. Staff will find the most important rules for ' +
  'access, the care of devices and the reporting of faults. Every department is required to follow these rules ' +
  'and to report changes in good time.'

describe('detectLang', () => {
  it('detects German text', () => {
    expect(detectLang(GERMAN)).toBe('de')
  })

  it('detects English text', () => {
    expect(detectLang(ENGLISH)).toBe('en')
  })

  it('gives null for text too short to tell', () => {
    expect(detectLang('Slide')).toBeNull()
    expect(detectLang('   \n\t  ')).toBeNull()
  })

  it('collapses whitespace before measuring', () => {
    expect(detectLang(GERMAN.replace(/ /g, '\n\n   '))).toBe('de')
  })
})
