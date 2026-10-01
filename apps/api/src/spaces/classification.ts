import {
  compareClassifications,
  effectiveClassification,
  isClassification,
  parsePage,
  type Classification,
  type MetadataSchema,
} from '@f451/markdown'

/**
 * Security classifications, API side (spec `2026-10-01-security-klassen-und-release-archiv-design.md`,
 * part A). The class of a page lives in its frontmatter; `pages.frontmatter`
 * already holds it, so no extra column is needed.
 */

export interface ClassificationViolation {
  classification: Classification
  max: Classification
}

/**
 * Checks a page's raw class against the space maximum. `null` when the space
 * has no `classification:` block, the page has no (valid) class, or the class
 * is within the limit.
 */
export function classificationViolation(
  pageValue: unknown,
  schema: MetadataSchema,
): ClassificationViolation | null {
  const settings = schema.classification
  if (!settings || !isClassification(pageValue)) return null
  if (compareClassifications(pageValue, settings.max) <= 0) return null
  return { classification: pageValue, max: settings.max }
}

/** Same check on full markdown (draft save, release). */
export function classificationViolationInMarkdown(
  markdown: string,
  schema: MetadataSchema,
): ClassificationViolation | null {
  if (!schema.classification) return null
  return classificationViolation(parsePage(markdown).frontmatter.classification, schema)
}

/** Fields `GET /api/pages/:id` adds when the space enables classifications. */
export function classificationFields(
  pageValue: unknown,
  schema: MetadataSchema,
): { classification?: Classification; classificationSettings?: { default: Classification; max: Classification } } {
  const settings = schema.classification
  if (!settings) return {}
  const effective = effectiveClassification(typeof pageValue === 'string' ? pageValue : undefined, settings)
  return { classification: effective ?? settings.default, classificationSettings: { ...settings } }
}

/** Error text appended to `frontmatterErrors` at read time for an existing page over the limit. */
export function classificationViolationMessage(v: ClassificationViolation): string {
  return `classification: "${v.classification}" exceeds the maximum "${v.max}" of this space`
}

/**
 * 422 body for write routes. 422, not 409: the editor reads a 409 on save as a
 * SHA conflict and would offer to merge instead of showing the reason.
 */
export function classificationViolationReply(v: ClassificationViolation): { error: string; reason: string } {
  return { error: classificationViolationMessage(v), reason: 'classification_exceeds_space_max' }
}
