// Markdown that `htmlToMarkdown` cannot produce (footnotes, GFM alerts,
// attachment lists) is put into the HTML as a plain token and swapped in after
// the conversion. Tokens are letters and digits only, so turndown leaves them
// untouched.

const TOKEN = /F451X([BF])(\d+)X/g

export class Tokens {
  private readonly blocks: string[] = []
  private readonly footnotes: Array<{ label: string; markdown: string }> = []

  /** A token for a block of Markdown; put it alone in a paragraph. */
  block(markdown: string): string {
    this.blocks.push(markdown)
    return `F451XB${this.blocks.length}X`
  }

  /** A token for a footnote reference; its definition is appended to every
   *  page whose Markdown contains the reference. */
  footnote(label: string, markdown: string): string {
    this.footnotes.push({ label, markdown })
    return `F451XF${this.footnotes.length}X`
  }

  /** Replaces the tokens in converted Markdown and appends the definitions
   *  of the footnotes it references. */
  resolve(markdown: string): string {
    const used: number[] = []
    const out = markdown.replace(TOKEN, (_all, kind: string, n: string) => {
      const i = Number(n) - 1
      if (kind === 'B') return this.blocks[i] ?? ''
      const note = this.footnotes[i]
      if (!note) return ''
      if (!used.includes(i)) used.push(i)
      return `[^${note.label}]`
    })
    if (used.length === 0) return out
    const defs = used.map((i) => {
      const { label, markdown: md } = this.footnotes[i]
      const lines = (md.trim() || ' ').split('\n')
      return `[^${label}]: ${lines.map((l, k) => (k === 0 || l.trim() === '' ? l : `    ${l}`)).join('\n')}`
    })
    return `${out.trimEnd()}\n\n${defs.join('\n\n')}\n`
  }
}

/** Removes tokens from text used as a title. */
export function stripTokens(s: string): string {
  return s.replace(TOKEN, '')
}
