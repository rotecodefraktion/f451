import { describe, expect, it } from 'vitest'
import { generatePageId } from '../src/indexer/page-id.js'
import { draftBranchName } from '../src/drafts/branch-name.js'

/**
 * `generatePageId` (Phase 3.1, „Stabile Seiten-Id + Backfill + Redirect"):
 * reiner Unit-Test ohne Container — deckt Format, Git-Branch-Sicherheit
 * (`draftBranchName` darf für eine generierte Id NIE einen Hash-Suffix
 * anhängen) und Kollisionsarmut über eine große Stichprobe ab.
 */
describe('generatePageId', () => {
  it('liefert das Format `p-<10 Zeichen base36>`', () => {
    const id = generatePageId()
    expect(id).toMatch(/^p-[0-9a-z]{10}$/)
  })

  it('verwendet ausschließlich [a-z0-9-] (git-branch-sicher)', () => {
    for (let i = 0; i < 200; i++) {
      const id = generatePageId()
      expect(id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it(
    'ist git-branch-sicher: `draftBranchName` hängt für eine generierte Id NIE einen ' +
      'Hash-Suffix an (die Id ist bereits vollständig in `draftBranchName`s erlaubter ' +
      'Zeichenmenge [a-z0-9._-] enthalten) — der Draft-Branch bleibt exakt `draft/<id>`',
    () => {
      for (let i = 0; i < 200; i++) {
        const id = generatePageId()
        expect(draftBranchName(id)).toBe(`draft/${id}`)
      }
    },
  )

  it('erzeugt bei vielen Aufrufen keine Kollision (kollisionsarm)', () => {
    const ids = new Set<string>()
    const count = 50_000
    for (let i = 0; i < count; i++) {
      ids.add(generatePageId())
    }
    expect(ids.size).toBe(count)
  })

  it('erzeugt bei zwei aufeinanderfolgenden Aufrufen unterschiedliche Ids', () => {
    expect(generatePageId()).not.toBe(generatePageId())
  })
})
