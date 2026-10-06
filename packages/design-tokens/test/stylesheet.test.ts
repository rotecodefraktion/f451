import { describe, expect, it } from 'vitest'
import { checkStylesheet, fontRefs, rewriteFontUrls } from '../src/stylesheet.js'

const codes = (css: string): string[] => checkStylesheet(css).problems.map((p) => p.code)

describe('checkStylesheet', () => {
  it('accepts plain CSS', () => {
    expect(checkStylesheet('a { color: red; scroll-behavior: smooth; }\n')).toEqual({ ok: true, problems: [] })
  })

  it('rejects @import in any case', () => {
    expect(codes('@import "x.css";')).toEqual(['css_import'])
    expect(codes('@IMPORT "x.css";')).toEqual(['css_import'])
    expect(codes('@import url(/custom/x.css);')).toContain('css_import')
  })

  it('decodes escapes in @import', () => {
    expect(codes('@\\69mport "x.css";')).toEqual(['css_import'])
    expect(codes('\\40 import "x.css";')).toEqual(['css_import'])
    expect(codes('@\\49 MPORT "x.css";')).toEqual(['css_import'])
  })

  it('ignores @import and other keywords inside comments and strings', () => {
    expect(checkStylesheet('/* @import "x"; expression( */ a {}').ok).toBe(true)
    expect(checkStylesheet('a::before { content: "@import"; }').ok).toBe(true)
    expect(checkStylesheet("a::before { content: 'url(https://x) behavior: javascript:'; }").ok).toBe(true)
  })

  it('accepts data: and fonts/<name>.woff2 urls', () => {
    expect(checkStylesheet('a { src: url(data:font/woff2;base64,AAAA); }').ok).toBe(true)
    expect(checkStylesheet('a { src: url( "fonts/a-b.woff2" ); }').ok).toBe(true)
    expect(checkStylesheet("a { src: url('fonts/a.woff2'); }").ok).toBe(true)
    expect(checkStylesheet('a { src: url(FONTS/a.woff2); }').ok).toBe(true)
    expect(checkStylesheet(`a { src: url(fonts/${'a'.repeat(40)}.woff2); }`).ok).toBe(true)
  })

  it('rejects every other url', () => {
    for (const u of [
      'fonts/A.woff2',
      'fonts/../x.woff2',
      '/api/x',
      'https://x',
      'http://x',
      '//x',
      'x.png',
      'fonts/a.woff2?x',
      'fonts/a.woff',
      `fonts/${'a'.repeat(41)}.woff2`,
      '"https://x"',
      '',
    ]) {
      expect(codes(`a { b: url(${u}); }`), u).toEqual(['css_url'])
    }
    expect(codes('a { b: URL(https://x); }')).toEqual(['css_url'])
  })

  it('decodes escapes in the url name and argument', () => {
    expect(codes('a { b: \\75 rl(https://x); }')).toEqual(['css_url'])
    expect(codes('a { b: \\75rl(https://x); }')).toEqual(['css_url'])
    expect(codes('a { b: url(\\2f\\2fx); }')).toEqual(['css_url'])
  })

  it('treats a bare string inside image-set() as a url', () => {
    expect(codes('a { b: image-set("https://x/a.png" 1x); }')).toEqual(['css_url'])
    expect(codes('a { b: image-set("/api/x" 1x); }')).toEqual(['css_url'])
    expect(codes('a { b: -WEBKIT-\\69mage-set("https://x" 1x); }')).toEqual(['css_url'])
    expect(checkStylesheet('a { b: image-set("data:image/png;base64,AA" 1x type("image/png")); }').ok).toBe(true)
    expect(codes('a { b: -webkit-image-set(url(/x) 1x); }')).toEqual(['css_url'])
    expect(checkStylesheet('a { b: image-set(url(data:x) 1x); content: "https://x"; }').ok).toBe(true)
  })

  it('rejects expression(, behavior:, -moz-binding and javascript:', () => {
    expect(codes('a { width: expression(alert(1)); }')).toEqual(['css_forbidden'])
    expect(codes('a { width: EXPRESSION(1); }')).toEqual(['css_forbidden'])
    expect(codes('a { width: ex\\70ression(1); }')).toEqual(['css_forbidden'])
    expect(codes('a { width: \\65 xpression(1); }')).toEqual(['css_forbidden'])
    expect(codes('a { behavior : x; }')).toEqual(['css_forbidden'])
    expect(codes('a { -moz-binding: none; }')).toEqual(['css_forbidden'])
    expect(codes('a { -MOZ-\\62inding: none; }')).toEqual(['css_forbidden'])
    expect(codes('a { b: javascript:alert(1); }')).toEqual(['css_forbidden'])
    expect(codes('a { b: url(javascript:alert(1)); }')).toEqual(['css_forbidden'])
    expect(codes('a { b: url("JavaScript:alert(1)"); }')).toEqual(['css_forbidden'])
  })

  it('does not flag look-alikes', () => {
    expect(checkStylesheet('a { scroll-behavior: smooth; overscroll-behavior: none; --x-moz-binding: 1; }').ok).toBe(true)
  })

  it('reports correct line numbers across multi-line comments and strings', () => {
    const css = '/* a\n b\n */\na {}\n@import "x";\r\n\r\nb { c: url(/api/x); }\n"s\\\nt" d { e: expression(1) }'
    expect(checkStylesheet(css).problems.map((p) => [p.code, p.line])).toEqual([
      ['css_import', 5],
      ['css_url', 7],
      ['css_forbidden', 9],
    ])
  })
})

describe('fontRefs', () => {
  it('lists distinct valid font names in order', () => {
    const css =
      'a { src: url(fonts/a.woff2), url("fonts/a.woff2"), url(fonts/b.woff2), url(https://x), url(fonts/C.woff2); }\n' +
      '/* url(fonts/z.woff2) */'
    expect(fontRefs(css)).toEqual(['a', 'b'])
  })
})

describe('rewriteFontUrls', () => {
  it('rewrites valid font urls and keeps all other text intact', () => {
    const css =
      '@font-face { src: url( "fonts/a-b.woff2" ) format("woff2"); }\n' +
      "/* url(fonts/c.woff2) */ b { background: url(data:image/png;base64,AA); }\n" +
      "c { src: url('FONTS/d.WOFF2'), url(fonts/../x.woff2), url(fonts/e.woff2) }"
    expect(rewriteFontUrls(css, '/api/theme/fonts/')).toBe(
      '@font-face { src: url("/api/theme/fonts/a-b.woff2") format("woff2"); }\n' +
        '/* url(fonts/c.woff2) */ b { background: url(data:image/png;base64,AA); }\n' +
        'c { src: url("/api/theme/fonts/d.woff2"), url(fonts/../x.woff2), url("/api/theme/fonts/e.woff2") }',
    )
  })

  it('returns text without font urls unchanged', () => {
    const css = 'a { color: red; } /* ü */ b::before { content: "x" }'
    expect(rewriteFontUrls(css, '/b/')).toBe(css)
  })
})
