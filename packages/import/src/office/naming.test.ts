import { describe, expect, it } from 'vitest'
import { assignIds, formatId, mainTitle, nextIdNumber, parseIdPattern, subTitle } from './naming.js'

describe('parseIdPattern', () => {
  it('finds the counter run, its width and the text around it', () => {
    expect(parseIdPattern('DOC-###')).toEqual({ prefix: 'DOC-', width: 3, suffix: '' })
    expect(parseIdPattern('GD-##-A')).toEqual({ prefix: 'GD-', width: 2, suffix: '-A' })
  })

  it('has no counter without a # run', () => {
    expect(parseIdPattern('DOC-FIXED')).toBeNull()
  })
})

describe('nextIdNumber', () => {
  it('continues after the highest number of titles following the pattern, anchored at the start', () => {
    expect(nextIdNumber('DOC-AB-###', ['DOC-AB-002', 'DOC-AB-010 x', 'DOC-ABX-050', 'x DOC-AB-900'])).toBe(11)
  })

  it('starts at 1 and treats the width as a minimum', () => {
    expect(nextIdNumber('DOC-###', [])).toBe(1)
    expect(nextIdNumber('DOC-###', ['DOC-1000'])).toBe(1001)
    expect(formatId('DOC-###', 1001)).toBe('DOC-1001')
    expect(formatId('DOC-###', 7)).toBe('DOC-007')
  })

  it('respects the suffix', () => {
    expect(nextIdNumber('R#-A', ['R4-A', 'R9-B'])).toBe(5)
  })
})

describe('assignIds', () => {
  const titles = ['DOC-AB-002', 'DOC-AB-010 x', 'DOC-ABX-050']

  it('gives the files of one run consecutive numbers in the given order', () => {
    const ids = assignIds('DOC-AB-###', ['office:a.docx', 'office:b.docx'], titles, new Map())
    expect([...ids.entries()].sort()).toEqual([
      ['office:a.docx', 'DOC-AB-011'],
      ['office:b.docx', 'DOC-AB-012'],
    ])
  })

  it('keeps the number of a page matched by its source id; only new pages draw one', () => {
    const existing = new Map([['office:a.docx', 'DOC-AB-011 Network Guide']])
    const ids = assignIds('DOC-AB-###', ['office:a.docx', 'office:c.docx'], [...titles, 'DOC-AB-011 Network Guide'], existing)
    expect(ids.get('office:a.docx')).toBe('DOC-AB-011')
    expect(ids.get('office:c.docx')).toBe('DOC-AB-012')
  })

  it('draws a new number when the current title no longer follows the pattern', () => {
    const ids = assignIds('DOC-###', ['office:a.docx'], [], new Map([['office:a.docx', 'Network Guide']]))
    expect(ids.get('office:a.docx')).toBe('DOC-001')
  })

  it('uses a pattern without # as a fixed prefix', () => {
    const ids = assignIds('DOC-FIXED', ['office:a.docx', 'office:b.docx'], ['DOC-FIXED'], new Map())
    expect([...ids.values()]).toEqual(['DOC-FIXED', 'DOC-FIXED'])
  })
})

describe('mainTitle', () => {
  const base = { title: 'Network Guide', fileName: 'net_guide_1', id: 'DOC-001' }

  it('names the main page by title, file name or ID', () => {
    expect(mainTitle({ ...base, mainName: 'title', idDisplay: 'id-title' })).toBe('Network Guide')
    expect(mainTitle({ ...base, mainName: 'file', idDisplay: 'id-title' })).toBe('net_guide_1')
    expect(mainTitle({ ...base, mainName: 'id', idDisplay: 'id' })).toBe('DOC-001')
    expect(mainTitle({ ...base, mainName: 'id', idDisplay: 'id-title' })).toBe('DOC-001 Network Guide')
  })

  it('keeps the title when there is no ID', () => {
    expect(mainTitle({ ...base, id: undefined, mainName: 'id', idDisplay: 'id' })).toBe('Network Guide')
  })
})

describe('subTitle', () => {
  const base = { chapter: '7 Network Access', text: 'Network Access', number: '7', position: '7', docTitle: 'Network Guide', key: 'DOC-001' }

  it('names a subpage by each pattern', () => {
    expect(subTitle({ ...base, subName: 'chapter' })).toBe('7 Network Access')
    expect(subTitle({ ...base, subName: 'title-chapter' })).toBe('Network Guide – 7 Network Access')
    expect(subTitle({ ...base, subName: 'key-chapter' })).toBe('DOC-001 – 7 Network Access')
    expect(subTitle({ ...base, subName: 'key-number' })).toBe('DOC-001.7 Network Access')
  })

  it('uses the number with numbering off and the position for a heading without one', () => {
    expect(subTitle({ ...base, chapter: 'Network Access', subName: 'key-number' })).toBe('DOC-001.7 Network Access')
    expect(subTitle({ ...base, chapter: 'Annex', text: 'Annex', number: null, position: '9', subName: 'key-number' })).toBe('DOC-001.9 Annex')
  })
})
