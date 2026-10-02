import { describe, expect, it } from 'vitest'
import {
  CHANGELOG_LIMIT,
  compareVersions,
  IMPLICIT_VERSION,
  INITIAL_VERSION,
  nextVersion,
  prependChangelogEntry,
} from '../src/version.js'
import type { ChangelogEntry } from '../src/types.js'

const entry = (version: string): ChangelogEntry => ({
  version,
  date: '2026-07-19',
  author: 'D. Krcek',
  note: `Notiz zu ${version}`,
})

describe('nextVersion', () => {
  it('erhöht patch, minor und major korrekt', () => {
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(nextVersion('1.2.3', 'major')).toBe('2.0.0')
  })

  it('setzt niedrigere Stellen bei minor und major zurück', () => {
    expect(nextVersion('1.9.9', 'minor')).toBe('1.10.0')
    expect(nextVersion('1.9.9', 'major')).toBe('2.0.0')
  })

  it('without a version: major gives 1.0.0, everything else 0.1.0 (f451#50)', () => {
    // A draft has no version; its first release is a first version (0.1.0)
    // or, chosen deliberately, the finished page (1.0.0).
    expect(nextVersion(undefined, 'patch')).toBe(IMPLICIT_VERSION)
    expect(nextVersion(undefined, 'minor')).toBe(IMPLICIT_VERSION)
    expect(nextVersion(undefined, 'major')).toBe(INITIAL_VERSION)
  })

  it('behandelt eine unlesbare Bestandsversion wie eine fehlende', () => {
    expect(nextVersion('kaputt', 'patch')).toBe(IMPLICIT_VERSION)
    expect(nextVersion('1.2', 'patch')).toBe(IMPLICIT_VERSION)
  })
})

describe('prependChangelogEntry', () => {
  it('stellt den neuen Eintrag voran', () => {
    const result = prependChangelogEntry([entry('1.0.0')], entry('1.1.0'))
    expect(result.map((e) => e.version)).toEqual(['1.1.0', '1.0.0'])
  })

  it('funktioniert ohne bestehende Historie', () => {
    expect(prependChangelogEntry(undefined, entry('1.0.0'))).toEqual([entry('1.0.0')])
  })

  it('begrenzt die Liste auf CHANGELOG_LIMIT Einträge', () => {
    const existing = Array.from({ length: CHANGELOG_LIMIT }, (_, i) => entry(`1.0.${i}`))
    const result = prependChangelogEntry(existing, entry('2.0.0'))
    expect(result).toHaveLength(CHANGELOG_LIMIT)
    expect(result[0]!.version).toBe('2.0.0')
    // Der älteste Eintrag fällt hinten heraus.
    expect(result.some((e) => e.version === `1.0.${CHANGELOG_LIMIT - 1}`)).toBe(false)
  })
})

describe('compareVersions', () => {
  it('sortiert numerisch, nicht lexikografisch', () => {
    // Als Text wäre '1.10.0' < '1.2.0' — genau der Fehler, den die
    // major/minor/patch-Spalten in page_versions verhindern.
    expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
  })
})
