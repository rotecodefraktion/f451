import { describe, expect, it } from 'vitest'
import {
  compareClassifications,
  effectiveClassification,
  parseFrontmatterBlock,
  parseMetadataSchema,
  stringifyMetadataSchema,
} from '../src/index.js'

describe('classification ordering', () => {
  it('orders public < internal < confidential < strictly-confidential', () => {
    expect(compareClassifications('public', 'internal')).toBeLessThan(0)
    expect(compareClassifications('strictly-confidential', 'confidential')).toBeGreaterThan(0)
    expect(compareClassifications('internal', 'internal')).toBe(0)
  })
})

describe('frontmatter field', () => {
  it('accepts the four values', () => {
    for (const value of ['public', 'internal', 'confidential', 'strictly-confidential']) {
      const { frontmatter, errors } = parseFrontmatterBlock(`classification: ${value}`)
      expect(errors).toEqual([])
      expect(frontmatter.classification).toBe(value)
    }
  })

  it('rejects other values and leaves the field unset', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('classification: secret')
    expect(frontmatter.classification).toBeUndefined()
    expect(errors[0]).toMatch(/^classification:/)
  })

  it('is a known field, not metadata', () => {
    const { frontmatter } = parseFrontmatterBlock('classification: public')
    expect(frontmatter.metadata).toBeUndefined()
  })
})

describe('space settings', () => {
  it('missing block = feature off', () => {
    const { schema, errors } = parseMetadataSchema('versioning: true')
    expect(errors).toEqual([])
    expect(schema.classification).toBeUndefined()
  })

  it('empty block enables with defaults', () => {
    expect(parseMetadataSchema('classification:').schema.classification).toEqual({
      default: 'internal',
      max: 'strictly-confidential',
    })
    expect(parseMetadataSchema('classification: {}').schema.classification).toEqual({
      default: 'internal',
      max: 'strictly-confidential',
    })
  })

  it('reads default and max, also without fields', () => {
    const { schema } = parseMetadataSchema('classification:\n  default: public\n  max: confidential\n')
    expect(schema.classification).toEqual({ default: 'public', max: 'confidential' })
  })

  it('default stricter than max is an error and disables the block', () => {
    const { schema, errors } = parseMetadataSchema('classification:\n  default: confidential\n  max: internal\n')
    expect(schema.classification).toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('unknown value is an error and disables the block', () => {
    const { schema, errors } = parseMetadataSchema('classification:\n  max: top-secret\n')
    expect(schema.classification).toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('survives a stringify roundtrip', () => {
    const { schema } = parseMetadataSchema('classification:\n  default: public\n  max: internal\nfields: []\n')
    expect(parseMetadataSchema(stringifyMetadataSchema(schema)).schema).toEqual(schema)
  })
})

describe('effective class', () => {
  const settings = { default: 'internal', max: 'confidential' } as const
  it('page value before space default', () => {
    expect(effectiveClassification('confidential', settings)).toBe('confidential')
    expect(effectiveClassification(null, settings)).toBe('internal')
  })
  it('feature off = null', () => {
    expect(effectiveClassification('confidential', undefined)).toBeNull()
  })
})
