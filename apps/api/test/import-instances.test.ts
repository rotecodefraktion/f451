import { describe, expect, it } from 'vitest'
import { findInstance, normaliseInstance, parseInstances } from '../src/import/instances.js'

describe('parseInstances (F451_IMPORT_BOOKSTACK_URLS)', () => {
  it('returns [] for unset or blank', () => {
    expect(parseInstances(undefined)).toEqual([])
    expect(parseInstances(' , ')).toEqual([])
  })

  it('normalises: lower-case host, no trailing slash, keeps path prefix', () => {
    expect(parseInstances('https://Wiki.Example.org/, https://ex.org/bookstack/')).toEqual([
      'https://wiki.example.org',
      'https://ex.org/bookstack',
    ])
  })

  it('deduplicates entries that normalise equal', () => {
    expect(parseInstances('https://ex.org, https://EX.org/')).toEqual(['https://ex.org'])
  })

  it('rejects credentials, query, hash and other schemes', () => {
    for (const bad of [
      'https://u:p@ex.org',
      'https://ex.org/?a=1',
      'https://ex.org/#x',
      'ftp://ex.org',
      'not a url',
    ]) {
      expect(() => parseInstances(bad)).toThrow(/F451_IMPORT_BOOKSTACK_URLS/)
    }
  })

  it('names the bad entry in the error', () => {
    expect(() => parseInstances('https://ok.example.org, ftp://bad.example.org')).toThrow(
      /ftp:\/\/bad\.example\.org/,
    )
  })
})

describe('normaliseInstance', () => {
  it('returns null for invalid input', () => {
    expect(normaliseInstance('not a url')).toBeNull()
    expect(normaliseInstance('ftp://ex.org')).toBeNull()
  })
})

describe('findInstance', () => {
  const list = ['https://wiki.example.org']

  it('matches after normalisation only', () => {
    expect(findInstance(list, 'https://WIKI.example.org/')).toBe('https://wiki.example.org')
    expect(findInstance(list, 'https://wiki.example.org.evil.com')).toBeNull()
    expect(findInstance(list, 'http://wiki.example.org')).toBeNull()
  })

  it('returns null for unparseable input and for an empty list', () => {
    expect(findInstance(list, 'nonsense')).toBeNull()
    expect(findInstance([], 'https://wiki.example.org')).toBeNull()
  })
  it('masks user info in the error message', () => {
    expect(() => parseInstances('https://user:secret@ex.org')).toThrow('"https://***@ex.org"')
  })
})
