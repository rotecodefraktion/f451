import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render.js'

const resolve = { resolveLink: () => null }

// Der Alert-Titel ist bewusst ein LEERES <p class="alert-title"> (Issue #9): der
// Titeltext ("Note"/"Hinweis" usw.) folgt der UI-Sprache, nicht der Seitensprache,
// und wird erst clientseitig per CSS Custom Property eingeblendet (s.
// apps/web/app/layout.tsx, apps/web/app/styles/61-lese.css). Diese Tests prüfen
// daher nur noch Struktur/Klassen, keinen Titeltext mehr.
describe('GFM-Alerts', () => {
  it('rendert [!NOTE] als Hinweisbox mit leerem Titel-Element', () => {
    const html = renderHtml('> [!NOTE]\n> Wichtiger Hinweis im Text.', resolve)
    expect(html).toContain('class="alert alert-note"')
    expect(html).toContain('<p class="alert-title"></p>')
    expect(html).toContain('Wichtiger Hinweis im Text.')
    expect(html).not.toContain('[!NOTE]')
  })

  it.each([
    ['TIP', 'alert-tip'],
    ['IMPORTANT', 'alert-important'],
    ['WARNING', 'alert-warning'],
    ['CAUTION', 'alert-caution'],
  ])('rendert [!%s]', (marker, cls) => {
    const html = renderHtml(`> [!${marker}]\n> Text.`, resolve)
    expect(html).toContain(cls)
    expect(html).toContain('<p class="alert-title"></p>')
  })

  it('normale Blockquotes bleiben Blockquotes', () => {
    const html = renderHtml('> Ein ganz normales Zitat.', resolve)
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('alert')
  })

  it('Marker-only-Absatz hinterlässt kein leeres <p></p> im Body (nur das Titel-<p>)', () => {
    const html = renderHtml('> [!NOTE]\n>\n> Text', resolve)
    // Genau ein leerer Absatz ist erwartet: das Titel-<p>. Ein zusätzliches
    // leeres <p></p> im Body (Marker-only-Absatz-Bug) wäre ein zweiter Treffer.
    expect(html.match(/<p class="alert-title"><\/p>/g)).toHaveLength(1)
    expect(html.match(/<p><\/p>/g)).toBeNull()
    expect(html).toContain('class="alert alert-note"')
    expect(html).toContain('Text')
  })
})
