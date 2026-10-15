import { describe, expect, it } from 'vitest'
import { readHtmlNote } from './html.js'

const enc = new TextEncoder()

/** Strings as UTF-8 (ASCII here), numbers as raw bytes. */
function bytes(...parts: Array<string | number>): Uint8Array {
  return new Uint8Array(parts.flatMap((p) => (typeof p === 'number' ? [p] : [...enc.encode(p)])))
}

const read = (html: string, fallback = 'file') => readHtmlNote(enc.encode(html), fallback)

describe('readHtmlNote', () => {
  it('takes the title from <title>, else the first <h1>, else the file name', () => {
    expect(read('<html><head><title>  My\n  Page </title></head><body><h1>Other</h1></body></html>').title).toBe('My Page')
    expect(read('<body><p>x</p><h1>Head <b>One</b></h1><h1>Two</h1></body>').title).toBe('Head One')
    expect(read('<head><title> </title></head><body><p>x</p></body>', 'page').title).toBe('page')
  })

  it('takes the content from <main>, else <article>, else <body>', () => {
    const main = read('<body><p>outside</p><article><p>art</p></article><main><p>main</p></main></body>').html
    expect(main).toBe('<p>main</p>')
    const article = read('<body><p>outside</p><article><p>art</p></article><article><p>second</p></article></body>').html
    expect(article).toBe('<p>art</p>')
    const body = read('<html><head><title>T</title></head><body><div><p>plain</p></div></body></html>').html
    expect(body).toBe('<div><p>plain</p></div>')
  })

  it('removes page chrome, form controls and hidden elements', () => {
    const html = read(
      [
        '<body>',
        '<nav>X-nav</nav><header>X-header</header><footer>X-footer</footer><aside>X-aside</aside>',
        '<script>X-script</script><style>X-style</style><noscript>X-noscript</noscript>',
        '<template>X-template</template><form>X-form</form><button>X-button</button>',
        '<input value="X-input"><select><option>X-select</option></select><textarea>X-textarea</textarea>',
        '<iframe src="X-iframe"></iframe>',
        '<div hidden>X-hidden</div><div aria-hidden="true">X-aria</div>',
        '<p>keep <span aria-hidden="false">visible</span></p>',
        '</body>',
      ].join(''),
    ).html
    expect(html).not.toMatch(/X-/)
    expect(html).toBe('<p>keep <span aria-hidden="false">visible</span></p>')
  })

  // Review focus 4: `iso-8859-1` decodes as windows-1252 (WHATWG), so curly quotes survive.
  it('decodes the declared charset', () => {
    const latin = readHtmlNote(
      bytes('<html><head><meta charset="iso-8859-1"><title>Gr', 0xfc, 'n</title></head><body><p>', 0x93, 'Hi', 0x94, '</p></body></html>'),
      'f',
    )
    expect(latin.title).toBe('Grün')
    expect(latin.html).toBe('<p>“Hi”</p>')

    const equiv = readHtmlNote(
      bytes('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>caf', 0xe9, '</p>'),
      'f',
    )
    expect(equiv.html).toBe('<p>café</p>')
  })

  it('falls back to UTF-8 for an unknown charset and strips a BOM', () => {
    expect(read('<meta charset="x-unknown"><p>Über</p>').html).toBe('<p>Über</p>')
    const bom = readHtmlNote(bytes(0xef, 0xbb, 0xbf, '<title>With BOM</title><p>x</p>'), 'f')
    expect(bom.title).toBe('With BOM')
    expect(bom.html).toBe('<p>x</p>')
  })

  it('throws on bytes the charset cannot decode', () => {
    expect(() => readHtmlNote(bytes('<p>', 0xff, 0xfe, '</p>'), 'f')).toThrow('not decodable as utf-8')
  })
})
