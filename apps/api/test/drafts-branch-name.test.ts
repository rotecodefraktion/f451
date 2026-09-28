import { describe, expect, it } from 'vitest'
import { draftBranchName } from '../src/drafts/branch-name.js'

/**
 * Branch-Namensmapping (Phase 2a Task 2): deterministische, git-sichere
 * Slugifizierung von Seiten-Ids zu `draft/<slug>` — inkl. Kollisionsschutz
 * per Hash-Suffix, sobald die Id Zeichen außerhalb von `[a-z0-9._-]` enthält.
 */
describe('draftBranchName', () => {
  it('lässt bereits git-sichere Ids unverändert (kein Hash-Suffix)', () => {
    expect(draftBranchName('home')).toBe('draft/home')
    expect(draftBranchName('betrieb-monitoring_v2.1')).toBe('draft/betrieb-monitoring_v2.1')
  })

  it('ist deterministisch (gleiche Id → gleicher Branch-Name bei wiederholtem Aufruf)', () => {
    const id = 'path:demo/a b/ü.md'
    expect(draftBranchName(id)).toBe(draftBranchName(id))
  })

  it('sanitiziert Fallback-Ids mit Space, ":", "/" und Unicode und hängt einen Hash-Suffix an', () => {
    const branch = draftBranchName('path:demo/a b/ü.md')
    expect(branch.startsWith('draft/')).toBe(true)
    // Nur git-sichere Zeichen im gesamten Branch-Namen (inkl. "draft/"-Präfix).
    expect(branch).toMatch(/^draft\/[a-z0-9._-]+$/)
    // Hash-Suffix: 8 Hex-Zeichen am Ende, durch '-' abgetrennt.
    expect(branch).toMatch(/-[0-9a-f]{8}$/)
  })

  it('Kollisionspaar: zwei verschiedene Ids, die auf denselben Slug abbilden, erhalten unterschiedliche Branch-Namen', () => {
    // Beide Ids haben genau ein nicht erlaubtes Zeichen an derselben Stelle
    // ('a b' und 'a:b') → ohne Hash-Suffix würden beide zu "draft/a-b"
    // kollabieren.
    const a = draftBranchName('a b')
    const b = draftBranchName('a:b')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^draft\/a-b-[0-9a-f]{8}$/)
    expect(b).toMatch(/^draft\/a-b-[0-9a-f]{8}$/)
  })

  it('kollabiert mehrfache Ersatzzeichen zu einem einzelnen Bindestrich', () => {
    const branch = draftBranchName('a   b')
    expect(branch).toMatch(/^draft\/a-b-[0-9a-f]{8}$/)
  })

  it('kappt führende/folgende Trennzeichen nach dem Sanitizing', () => {
    const branch = draftBranchName(':leading-and-trailing:')
    expect(branch).toMatch(/^draft\/leading-and-trailing-[0-9a-f]{8}$/)
  })

  it('liefert einen Fallback-Slug, wenn nach dem Sanitizing nichts übrig bleibt', () => {
    const branch = draftBranchName(':::')
    expect(branch).toMatch(/^draft\/page-[0-9a-f]{8}$/)
  })

  it('wirft für eine leere pageId', () => {
    expect(() => draftBranchName('')).toThrow()
  })

  it('unterscheidet Groß-/Kleinschreibung sicher (Großbuchstaben lösen den Hash-Suffix aus)', () => {
    const lower = draftBranchName('home')
    const upper = draftBranchName('Home')
    expect(lower).toBe('draft/home')
    expect(upper).not.toBe(lower)
    expect(upper).toMatch(/^draft\/[a-z0-9._-]+$/)
  })
})
