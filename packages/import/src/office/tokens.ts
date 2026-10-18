// Markdown that `htmlToMarkdown` cannot produce (footnotes, GFM alerts,
// attachment lists) is put into the HTML as a plain token and swapped in after
// the conversion. Tokens are letters and digits only, so turndown leaves them
// untouched.

const TOKEN = /F451X([BF])(\d+)X/g
/** Marks a heading for in-document links; resolved by the page conversion. */
const HEADING_TOKEN = /F451XH(\d+)X/g

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

/** Marks the Word/ODF Title paragraph; written into the package before the
 *  conversion (`marks.ts`), taken out by the text pre-pass. */
export const TITLE_TOKEN = 'F451XT'
/** Marks a paragraph with outline level `n` past 6; same life cycle. */
const LEVEL_TOKEN = /F451XL(\d+)X/g

export function levelToken(n: number): string {
  return `F451XL${n}X`
}

/** The level of the first level token in `s`, or null. */
export function markedLevel(s: string): number | null {
  const m = new RegExp(LEVEL_TOKEN.source).exec(s)
  return m ? Number(m[1]) : null
}

/** Removes the package marks (title and level tokens) only. */
export function stripMarks(s: string): string {
  return s.replace(LEVEL_TOKEN, '').split(TITLE_TOKEN).join('')
}

/** Removes tokens from text used as a title. */
export function stripTokens(s: string): string {
  return stripMarks(s.replace(TOKEN, '').replace(HEADING_TOKEN, ''))
}

/** The token that marks heading `n` (an index unique in the document). */
export function headingToken(n: number): string {
  return `F451XH${n}X`
}

/** Heading numbers of the tokens in `s`, and `s` without them. */
export function takeHeadingTokens(s: string): { ids: number[]; text: string } {
  const ids: number[] = []
  const text = s.replace(HEADING_TOKEN, (_all, n: string) => {
    ids.push(Number(n))
    return ''
  })
  return { ids, text }
}

/** Link destination for a link to heading `n`. */
export const HEADING_LINK = 'f451-heading:'
