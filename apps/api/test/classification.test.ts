import { describe, expect, it } from 'vitest'
import { EMPTY_METADATA_SCHEMA, type MetadataSchema } from '@f451/markdown'
import {
  classificationFields,
  classificationViolation,
  classificationViolationInMarkdown,
} from '../src/spaces/classification.js'

const classified: MetadataSchema = {
  ...EMPTY_METADATA_SCHEMA,
  classification: { default: 'internal', max: 'confidential' },
}

describe('classification checks', () => {
  it('no block → never a violation, no fields', () => {
    expect(classificationViolation('strictly-confidential', EMPTY_METADATA_SCHEMA)).toBeNull()
    expect(classificationFields('confidential', EMPTY_METADATA_SCHEMA)).toEqual({})
  })

  it('above max → violation, at max → none', () => {
    expect(classificationViolation('strictly-confidential', classified)).toEqual({
      classification: 'strictly-confidential',
      max: 'confidential',
    })
    expect(classificationViolation('confidential', classified)).toBeNull()
    expect(classificationViolation(undefined, classified)).toBeNull()
  })

  it('reads the class from markdown', () => {
    const md = '---\ntitle: X\nclassification: strictly-confidential\n---\n\n# X\n'
    expect(classificationViolationInMarkdown(md, classified)?.classification).toBe('strictly-confidential')
    expect(classificationViolationInMarkdown('# no frontmatter\n', classified)).toBeNull()
  })

  it('fields: effective class falls back to the space default', () => {
    expect(classificationFields(undefined, classified)).toEqual({
      classification: 'internal',
      classificationSettings: { default: 'internal', max: 'confidential' },
    })
    expect(classificationFields('public', classified).classification).toBe('public')
  })
})
