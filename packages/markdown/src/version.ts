import type { ChangelogEntry } from './types.js'

/** Sprunggröße einer Freigabe, vom Freigebenden gewählt. */
export type VersionBump = 'patch' | 'minor' | 'major'

/** Version der ERSTEN Freigabe. Freigegeben heißt veröffentlicht — deshalb
 *  1.0.0 und nicht 0.1.0. */
export const INITIAL_VERSION = '1.0.0'

/** Version of a page that exists on `main` in a versioned space but carries
 *  no `version` yet: present, but never versioned through a release. Derived,
 *  never written — its first release bumps from here (0.1.1, 0.2.0, 1.0.0). */
export const IMPLICIT_VERSION = '0.1.0'

/** Höchstzahl der Changelog-Einträge IM DOKUMENT. Die vollständige Historie
 *  steht in `page_versions` und ist aus der Git-Historie rekonstruierbar;
 *  ohne Deckel stünde bei gepflegten Seiten mehr Changelog als Inhalt im
 *  Editor. */
export const CHANGELOG_LIMIT = 10

interface SemverParts {
  major: number
  minor: number
  patch: number
}

/** Zerlegt '1.2.3'. Liefert `undefined` für alles, was nicht exakt aus drei
 *  nicht-negativen Ganzzahlen besteht — Aufrufer behandeln das wie eine
 *  fehlende Version (Fail-Soft wie der Frontmatter-Parser). */
export function parseVersion(raw: string | undefined): SemverParts | undefined {
  if (!raw) return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function formatVersion(parts: SemverParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`
}

/**
 * Berechnet die Version der nächsten Freigabe.
 *
 * `current` MUSS die Version aus `main` sein, nicht die aus dem Draft: Nach
 * einem fehlgeschlagenen Merge steht die erhöhte Version bereits im Draft —
 * würde von dort gerechnet, spränge jede Wiederholung eine Version weiter.
 *
 * Without a version (the first release of a new page): `major` gives 1.0.0,
 * the finished page; every other bump gives 0.1.0, a first version (f451#50).
 */
export function nextVersion(current: string | undefined, bump: VersionBump): string {
  const parts = parseVersion(current)
  if (!parts) return bump === 'major' ? INITIAL_VERSION : IMPLICIT_VERSION

  switch (bump) {
    case 'major':
      return formatVersion({ major: parts.major + 1, minor: 0, patch: 0 })
    case 'minor':
      return formatVersion({ major: parts.major, minor: parts.minor + 1, patch: 0 })
    case 'patch':
      return formatVersion({ major: parts.major, minor: parts.minor, patch: parts.patch + 1 })
  }
}

/** Stellt den neuen Eintrag voran und kürzt auf {@link CHANGELOG_LIMIT}. */
export function prependChangelogEntry(
  existing: ChangelogEntry[] | undefined,
  entry: ChangelogEntry,
): ChangelogEntry[] {
  return [entry, ...(existing ?? [])].slice(0, CHANGELOG_LIMIT)
}

/** Numerischer Vergleich zweier Versionen (`a - b`). Unlesbare Versionen
 *  gelten als kleinste. Für Sortierungen, die nicht über die
 *  major/minor/patch-Spalten laufen. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? { major: -1, minor: -1, patch: -1 }
  const pb = parseVersion(b) ?? { major: -1, minor: -1, patch: -1 }
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch
}
