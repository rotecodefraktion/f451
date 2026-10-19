// The result of a kind pre-pass: HTML ready for `htmlToMarkdown`, cut into
// the parts a split produces (text: H1 chapters, slides, sheets).

export interface OfficePart {
  title: string
  /** HTML of the part's heading, used when the document stays one page. */
  heading: string
  /** HTML of the part without its heading. */
  html: string
  /** Text documents: Word level of the heading that starts the part. */
  level?: number
  /** Text documents: the heading's outline number ("7.6"), also when numbering is off. */
  number?: string | null
  /** Text documents: the heading text without its outline number. */
  text?: string
  /** Text documents split below level 1: the parts one level deeper. */
  children?: OfficePart[]
}

export interface OfficeDoc {
  /** Text of the document's Title paragraph (text documents), removed from the body. */
  title?: string
  /** Content before the first part (text: before the first H1). */
  intro: string
  parts: OfficePart[]
}

export type Lang = 'de' | 'en'

const LABELS = {
  slide: { de: 'Folie', en: 'Slide' },
  chart: { de: 'Diagramm', en: 'Chart' },
  chapter: { de: 'Kapitel', en: 'Chapter' },
  toc: { de: 'Inhalt', en: 'Contents' },
} as const

export function label(key: keyof typeof LABELS, lang: Lang): string {
  return LABELS[key][lang]
}
