import { fromHtml } from 'hast-util-from-html'
import { describe, expect, it } from 'vitest'
import { takeLeadHeading } from './lead-heading.js'

/** All element tag names of an HTML fragment, as a browser would parse it. */
function tagNames(html: string): string[] {
  const names: string[] = []
  const walk = (node: { type: string; tagName?: string; children?: unknown[] }): void => {
    if (node.type === 'element' && node.tagName) names.push(node.tagName)
    for (const child of node.children ?? []) walk(child as typeof node)
  }
  walk(fromHtml(html, { fragment: true }))
  return names
}

describe('takeLeadHeading', () => {
  it('takes a leading h1 with attributes and keeps its inline markup', () => {
    // The parts are re-serialized from the parsed tree, so `<` in text comes
    // back as the serializer's character reference (same rendered text).
    expect(
      takeLeadHeading('<h1 id="a" class="x"><em>Backup</em> of <code>&lt;db&gt;</code></h1><p>Text</p>'),
    ).toEqual({ headingHtml: '<em>Backup</em> of <code>&#x3C;db></code>', rest: '<p>Text</p>' })
  })

  it('takes a leading h1 with nested markup', () => {
    expect(
      takeLeadHeading('<h1 id="x"><a href="/a"><strong>Big <em>deal</em></strong></a> now</h1><ul><li>y</li></ul>'),
    ).toEqual({
      headingHtml: '<a href="/a"><strong>Big <em>deal</em></strong></a> now',
      rest: '<ul><li>y</li></ul>',
    })
  })

  it('takes a leading h1 preceded by whitespace', () => {
    expect(takeLeadHeading('\n  <h1>Backup</h1>\n<p>x</p><h2>More</h2>')).toEqual({
      headingHtml: 'Backup',
      rest: '\n<p>x</p><h2>More</h2>',
    })
  })

  it('returns null and the body unchanged when a comment precedes the h1', () => {
    const html = '<!-- note --><h1>Backup</h1><p>x</p>'
    expect(takeLeadHeading(html)).toEqual({ headingHtml: null, rest: html })
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

  it('does not end the heading at a </h1> inside an attribute value (F-01)', () => {
    // Sanitized pipeline output for
    // `# [Start](https://example.org "</h1><img …><meta …>")`: the serializer
    // leaves `<`/`>` in attribute values unescaped.
    const title =
      '</h1><img src=x onerror=alert(document.domain)><meta http-equiv=refresh content=0;url=https://evil.example>'
    const anchor = `<a href="https://example.org" title="${title}">Start</a>`
    const { headingHtml, rest } = takeLeadHeading(`<h1 id="start">${anchor}</h1><p>Text</p>`)

    expect(headingHtml).toBe(anchor)
    expect(tagNames(headingHtml!)).toEqual(['a'])
    expect(rest).toBe('<p>Text</p>')
    expect(tagNames(rest)).not.toContain('img')
    expect(tagNames(rest)).not.toContain('meta')
  })
})
