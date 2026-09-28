import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render.js'

const resolve = { resolveLink: () => null }

describe('Sanitizing (XSS)', () => {
  it('entfernt script-Tags', () => {
    expect(renderHtml('hallo <script>alert(1)</script>', resolve)).not.toContain('<script')
  })
  it('entfernt Event-Handler-Attribute', () => {
    expect(renderHtml('<img src="x.png" onerror="alert(1)">', resolve)).not.toContain('onerror')
  })
  it('entfernt javascript:-URLs', () => {
    const html = renderHtml('[klick](javascript:alert(1))', resolve)
    expect(html).not.toContain('javascript:')
  })
  it('entfernt iframes und style-Tags', () => {
    const html = renderHtml('<iframe src="https://boese.example"></iframe><style>*{}</style>', resolve)
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<style')
  })
  it('erlaubte Inline-HTML-Basics überleben (Interop): b, em, br', () => {
    const html = renderHtml('a <b>fett</b> und <em>kursiv</em><br>', resolve)
    expect(html).toContain('<b>fett</b>')
    expect(html).toContain('<em>kursiv</em>')
  })
})
