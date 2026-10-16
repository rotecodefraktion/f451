// The result of a kind pre-pass: HTML ready for `htmlToMarkdown`, cut into
// the parts a split produces (text: H1 chapters, slides, sheets).

export interface OfficePart {
  title: string
  /** HTML of the part's heading, used when the document stays one page. */
  heading: string
  /** HTML of the part without its heading. */
  html: string
}

export interface OfficeDoc {
  /** Content before the first part (text: before the first H1). */
  intro: string
  parts: OfficePart[]
}

export type Lang = 'de' | 'en'

const LABELS = {
  slide: { de: 'Folie', en: 'Slide' },
  chart: { de: 'Diagramm', en: 'Chart' },
  chapter: { de: 'Kapitel', en: 'Chapter' },
} as const

export function label(key: keyof typeof LABELS, lang: Lang): string {
  return LABELS[key][lang]
}
