import { describe, expect, it } from 'vitest'
import { takeLeadHeading } from './lead-heading.js'

describe('takeLeadHeading', () => {
  it('takes a leading h1 with attributes and keeps its inline markup', () => {
    expect(
      takeLeadHeading('<h1 id="a" class="x"><em>Backup</em> of <code>&lt;db&gt;</code></h1><p>Text</p>'),
    ).toEqual({ headingHtml: '<em>Backup</em> of <code>&lt;db&gt;</code>', rest: '<p>Text</p>' })
  })

  it('takes a leading h1 preceded by whitespace', () => {
    expect(takeLeadHeading('\n  <h1>Backup</h1>\n<p>x</p><h2>More</h2>')).toEqual({
      headingHtml: 'Backup',
      rest: '\n<p>x</p><h2>More</h2>',
    })
  })

  it('returns null and the body unchanged when an h2 comes first', () => {
    const html = '<h2>Backup</h2><p>Text</p>'
    expect(takeLeadHeading(html)).toEqual({ headingHtml: null, rest: html })
  })

  it('returns null and the body unchanged when text precedes the h1', () => {
    const html = '<p>Intro</p><h1>Backup</h1>'
    expect(takeLeadHeading(html)).toEqual({ headingHtml: null, rest: html })
  })

  it('does not take an <h1x> lookalike tag for an h1', () => {
    const html = '<h1x>Backup</h1x>'
    expect(takeLeadHeading(html)).toEqual({ headingHtml: null, rest: html })
  })
})
