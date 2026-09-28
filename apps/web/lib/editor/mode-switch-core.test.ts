import { describe, expect, it } from 'vitest'
import { evaluateModeSwitch } from './mode-switch-core.js'

describe('evaluateModeSwitch', () => {
  it('verweigert den Wechsel bei rohem HTML — mit Zeile im Befund', () => {
    const result = evaluateModeSwitch('# Titel\n\n<div>raw html</div>\n')

    expect(result.allowed).toBe(false)
    if (result.allowed) throw new Error('unreachable')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ kind: 'unsupported', line: 3 })
  })

  it('*-Bullets brauchen eine Bestätigung; ein zweiter Aufruf auf canonicalBody ist ohne Bestätigung erlaubt', () => {
    const result = evaluateModeSwitch('# Titel\n\n* Punkt eins\n* Punkt zwei\n')

    expect(result.allowed).toBe(true)
    if (!result.allowed) throw new Error('unreachable')
    expect(result.needsConfirmation).toBe(true)
    if (!result.needsConfirmation) throw new Error('unreachable')
    expect(result.canonicalBody).toBe('# Titel\n\n- Punkt eins\n- Punkt zwei\n')

    // canonicalBody ist NUR der Body (ohne Frontmatter) — hier ohnehin keins
    // vorhanden, das volle Dokument für den zweiten Aufruf ist also identisch.
    const second = evaluateModeSwitch(result.canonicalBody)
    expect(second).toEqual({ allowed: true, needsConfirmation: false, findings: [] })
  })

  it('Frontmatter-Schemafehler bleiben erlaubt — als Warnbefund im Ergebnis, keine Bestätigung nötig', () => {
    const result = evaluateModeSwitch('---\ntags: nicht-liste\n---\n# Titel\n\nText.\n')

    expect(result.allowed).toBe(true)
    if (!result.allowed) throw new Error('unreachable')
    expect(result.needsConfirmation).toBe(false)
    expect(result.findings).toEqual([{ kind: 'frontmatter', message: 'tags: muss eine Liste von Strings sein' }])
  })

  it('ein bereits kanonisches Dokument ist direkt erlaubt, ohne jeden Befund', () => {
    const result = evaluateModeSwitch('# Titel\n\nText.\n')

    expect(result).toEqual({ allowed: true, needsConfirmation: false, findings: [] })
  })

  it('crasht nicht am leeren Dokument („wirft nie"-Vertrag von checkEditorSupport)', () => {
    expect(() => evaluateModeSwitch('')).not.toThrow()
    const result = evaluateModeSwitch('')
    expect(result.allowed).toBe(true)
  })
})
