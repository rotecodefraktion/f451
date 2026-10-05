import { describe, expect, it } from 'vitest'
import { dropDuplicateTitle } from './drop-duplicate-title.js'

describe('dropDuplicateTitle', () => {
  it('removes a leading h1 equal to the title', () => {
    expect(dropDuplicateTitle('<h1>Backup</h1><p>Text</p>', 'Backup')).toBe('<p>Text</p>')
  })

  it('removes it when preceded by whitespace and with differing inner whitespace', () => {
    expect(dropDuplicateTitle('\n  <h1>  Backup \n &amp;  Restore </h1><p>x</p>', 'Backup & Restore')).toBe(
      '<p>x</p>',
    )
  })

  it('keeps a leading h1 that differs from the title', () => {
    const html = '<h1>Overview</h1><p>Text</p>'
    expect(dropDuplicateTitle(html, 'Backup')).toBe(html)
  })

  it('keeps an h1 that is not the first element', () => {
    const html = '<p>Intro</p><h1>Backup</h1>'
    expect(dropDuplicateTitle(html, 'Backup')).toBe(html)
  })

  it('handles attributes and an id on the h1', () => {
    expect(dropDuplicateTitle('<h1 id="backup" class="x">Backup</h1><p>Text</p>', 'Backup')).toBe('<p>Text</p>')
  })

  it('handles inline markup inside the h1', () => {
    expect(
      dropDuplicateTitle('<h1 id="a"><em>Backup</em> of <code>&lt;db&gt;</code></h1><p>Text</p>', 'Backup of <db>'),
    ).toBe('<p>Text</p>')
  })

  it('does not take an h2 for the title', () => {
    const html = '<h2>Backup</h2><p>Text</p>'
    expect(dropDuplicateTitle(html, 'Backup')).toBe(html)
  })

  it('does not take an <h1x> lookalike tag for an h1', () => {
    const html = '<h1x>Backup</h1x>'
    expect(dropDuplicateTitle(html, 'Backup')).toBe(html)
  })
})
