import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render.js'

const resolve = { resolveLink: () => null }

describe('GFM-Alerts', () => {
  it('rendert [!NOTE] als Hinweisbox mit deutschem Titel', () => {
    const html = renderHtml('> [!NOTE]\n> Wichtiger Hinweis im Text.', resolve)
    expect(html).toContain('class="alert alert-note"')
    expect(html).toContain('class="alert-title"')
    expect(html).toContain('Hinweis')
    expect(html).toContain('Wichtiger Hinweis im Text.')
    expect(html).not.toContain('[!NOTE]')
  })

  it.each([
    ['TIP', 'alert-tip', 'Tipp'],
    ['IMPORTANT', 'alert-important', 'Wichtig'],
    ['WARNING', 'alert-warning', 'Warnung'],
    ['CAUTION', 'alert-caution', 'Achtung'],
  ])('rendert [!%s]', (marker, cls, title) => {
    const html = renderHtml(`> [!${marker}]\n> Text.`, resolve)
    expect(html).toContain(cls)
    expect(html).toContain(title)
  })

  it('normale Blockquotes bleiben Blockquotes', () => {
    const html = renderHtml('> Ein ganz normales Zitat.', resolve)
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('alert')
  })

  it('Marker-only-Absatz hinterlässt kein leeres <p></p>', () => {
    const html = renderHtml('> [!NOTE]\n>\n> Text', resolve)
    expect(html).not.toContain('<p></p>')
    expect(html).toContain('class="alert alert-note"')
    expect(html).toContain('class="alert-title"')
    expect(html).toContain('Text')
  })
})
