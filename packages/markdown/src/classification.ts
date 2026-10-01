/**
 * Security classifications (spec `2026-10-01-security-klassen-und-release-archiv-design.md`,
 * part A). One ordered list shared by API, web and MCP, so nobody keeps a
 * second ordering that could drift.
 *
 * A class labels a page and changes what search, graph and agent tokens reveal
 * about it. It never grants or denies read access — that stays with the
 * repository.
 */

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'strictly-confidential'] as const

export type Classification = (typeof CLASSIFICATIONS)[number]

/** Space default when the `classification:` block omits `default`. */
export const DEFAULT_CLASSIFICATION: Classification = 'internal'

/** Space maximum when the `classification:` block omits `max`. */
export const MAX_CLASSIFICATION: Classification = 'strictly-confidential'

export function isClassification(value: unknown): value is Classification {
  return typeof value === 'string' && (CLASSIFICATIONS as readonly string[]).includes(value)
}

/** Negative if `a` is less strict than `b`, 0 if equal, positive if stricter. */
export function compareClassifications(a: Classification, b: Classification): number {
  return CLASSIFICATIONS.indexOf(a) - CLASSIFICATIONS.indexOf(b)
}

/** Per-space settings from `_meta/schema.yaml`. Absent block = feature off. */
export interface ClassificationSettings {
  default: Classification
  max: Classification
}

/**
 * The class that applies to a page: its own field, else the space default.
 * `null` when the space has no `classification:` block (feature off) — callers
 * then behave exactly as before classifications existed.
 */
export function effectiveClassification(
  pageValue: string | null | undefined,
  settings: ClassificationSettings | undefined,
): Classification | null {
  if (!settings) return null
  return isClassification(pageValue) ? pageValue : settings.default
}
