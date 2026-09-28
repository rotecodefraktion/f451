import { describe, expect, it } from 'vitest'
import { shouldOpenShortcuts, type ShortcutKeyPress, type ShortcutTarget } from './shortcuts.js'

/** Ein Tastendruck auf `?` ohne Modifikator; die Tests ändern jeweils nur den
 *  einen Punkt, um den es ihnen geht. */
function press(overrides: Partial<ShortcutKeyPress> = {}): ShortcutKeyPress {
  return { key: '?', ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides }
}

function target(tagName: string, isContentEditable = false): ShortcutTarget {
  return { tagName, isContentEditable }
}

describe('shouldOpenShortcuts', () => {
  it('greift bei `?` ohne Modifikator', () => {
    expect(shouldOpenShortcuts(press())).toBe(true)
    expect(shouldOpenShortcuts(press({ target: target('BODY') }))).toBe(true)
    expect(shouldOpenShortcuts(press({ target: target('BUTTON') }))).toBe(true)
  })

  it('greift auch mit Shift — ohne Shift gibt es gar kein `?`', () => {
    // `shiftKey` ist deshalb bewusst gar kein Feld von `ShortcutKeyPress`.
    expect(shouldOpenShortcuts(press())).toBe(true)
  })

  it('greift nicht mit Ctrl, Meta oder Alt', () => {
    expect(shouldOpenShortcuts(press({ ctrlKey: true }))).toBe(false)
    expect(shouldOpenShortcuts(press({ metaKey: true }))).toBe(false)
    expect(shouldOpenShortcuts(press({ altKey: true }))).toBe(false)
  })

  it('greift nicht, während jemand in ein Feld schreibt', () => {
    expect(shouldOpenShortcuts(press({ target: target('INPUT') }))).toBe(false)
    expect(shouldOpenShortcuts(press({ target: target('TEXTAREA') }))).toBe(false)
    expect(shouldOpenShortcuts(press({ target: target('SELECT') }))).toBe(false)
  })

  it('greift nicht im Editor (contentEditable)', () => {
    expect(shouldOpenShortcuts(press({ target: target('DIV', true) }))).toBe(false)
  })

  it('greift bei keiner anderen Taste', () => {
    expect(shouldOpenShortcuts(press({ key: 'ß' }))).toBe(false)
    expect(shouldOpenShortcuts(press({ key: '/' }))).toBe(false)
    expect(shouldOpenShortcuts(press({ key: '[' }))).toBe(false)
    expect(shouldOpenShortcuts(press({ key: 'Escape' }))).toBe(false)
  })
})
