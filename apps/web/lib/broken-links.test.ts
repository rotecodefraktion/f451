import { describe, expect, it } from 'vitest'
import { describeBrokenEntry } from './broken-links.js'

describe('describeBrokenEntry', () => {
  it('link → „Verweis"', () => {
    expect(describeBrokenEntry({ rawTarget: 'x', type: 'link', label: '' })).toBe('Verweis')
  })

  it('relation → Beziehungstyp aus label', () => {
    expect(describeBrokenEntry({ rawTarget: 'x', type: 'relation', label: 'depends_on' })).toBe(
      'Beziehung „depends_on“',
    )
  })
})
