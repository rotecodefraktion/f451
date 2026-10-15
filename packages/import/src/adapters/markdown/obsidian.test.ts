import { describe, expect, it } from 'vitest'
import { obsidianPrepass } from './obsidian.js'

const files: Record<string, string> = {
  'Note.md': 'Note.md',
  'img.png': 'a/img.png',
  'doc.pdf': 'a/doc.pdf',
}
const resolve = (t: string): string | null => files[t] ?? null
const run = (s: string) => obsidianPrepass(s, resolve)

describe('obsidianPrepass', () => {
  it('rewrites wikilinks with alias and heading, and leaves unresolved ones as text', () => {
    expect(run('[[Note]]').text).toBe('[Note](</Note.md>)')
    expect(run('[[Note|Text]]').text).toBe('[Text](</Note.md>)')
    expect(run('[[Note#Head]]').text).toBe('[Note#Head](</Note.md#Head>)')
    expect(run('| [[Note\\|Alias]] |').text).toBe('| [Alias](</Note.md>) |')
    const r = run('see [[Nope]] and [[Nope|shown]]')
    expect(r.text).toBe('see Nope and shown')
    expect(r.unresolved).toEqual(['Nope', 'Nope'])
  })

  it('rewrites each embed form', () => {
    expect(run('![[img.png]]').text).toBe('![img.png](</a/img.png>)')
    expect(run('![[img.png|300]]').text).toBe('![img.png](</a/img.png>)')
    expect(run('![[img.png|300x200]]').text).toBe('![img.png](</a/img.png>)')
    expect(run('![[Note]]').text).toBe('[Note](</Note.md>)')
    expect(run('![[Note#Head]]').text).toBe('[Note](</Note.md#Head>)')
    expect(run('![[Note#^blk]]').text).toBe('[Note](</Note.md>)')
    expect(run('![[doc.pdf]]').text).toBe('[doc.pdf](</a/doc.pdf>)')
    const missing = run('![[gone.png]]')
    expect(missing.text).toBe('gone.png')
    expect(missing.missing).toEqual(['gone.png'])
    const note = run('![[Gone note]]')
    expect(note.unresolved).toEqual(['Gone note'])
  })

  it('turns highlights into strong emphasis', () => {
    expect(run('a ==marked== b').text).toBe('a **marked** b')
    expect(run('==[[Note]]==').text).toBe('**[Note](</Note.md>)**')
    // A setext underline and `a == b` are no highlights.
    expect(run('Title\n===\n').text).toBe('Title\n===\n')
    expect(run('a == b').text).toBe('a == b')
  })

  it('removes inline and multi-line comments', () => {
    expect(run('a %%hidden%% b').text).toBe('a  b')
    expect(run('a\n%%\nhidden\n[[Note]]\n%%\nb').text).toBe('a\n\nb')
  })

  it('removes block ids at line end only', () => {
    expect(run('para ^abc-1\nnext').text).toBe('para\nnext')
    expect(run('- item ^x1').text).toBe('- item')
    expect(run('x^2 and a ^b c').text).toBe('x^2 and a ^b c')
  })

  it('leaves fenced code and code spans untouched', () => {
    const fenced = '```\n[[Note]] ==x== %%c%% para ^id\n```\n'
    expect(run(fenced).text).toBe(fenced)
    const tilde = '~~~dataview\nLIST FROM [[Note]]\n~~~\n'
    expect(run(tilde).text).toBe(tilde)
    const quoted = '> ```\n> [[Note]]\n> ```\n'
    expect(run(quoted).text).toBe(quoted)
    expect(run('`[[Note]]` and ``a ==x== b``').text).toBe('`[[Note]]` and ``a ==x== b``')
    expect(run('after `code` [[Note]]').text).toBe('after `code` [Note](</Note.md>)')
  })

  it('keeps escaped brackets and math as written', () => {
    expect(run('\\[[Note]]').text).toBe('\\[[Note]]')
    expect(run('$x^2 + y$').text).toBe('$x^2 + y$')
  })
})
