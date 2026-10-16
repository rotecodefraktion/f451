// Office file kinds by extension (spec 2026-10-16-office-import §2).

export const OFFICE_EXTENSIONS = {
  text: ['docx', 'doc', 'odt', 'rtf'],
  slides: ['pptx', 'ppt', 'odp'],
  sheets: ['xlsx', 'xls', 'ods'],
} as const

export type OfficeKind = keyof typeof OFFICE_EXTENSIONS

/** The ODF format LibreOffice writes for each kind (`document.<ext>` in the bundle). */
export const ODF_EXTENSION: Record<OfficeKind, 'odt' | 'odp' | 'ods'> = {
  text: 'odt',
  slides: 'odp',
  sheets: 'ods',
}

/** Lower-case extension without the dot, or '' if the name has none. */
export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function officeKind(name: string): OfficeKind | null {
  const ext = extensionOf(name)
  for (const kind of Object.keys(OFFICE_EXTENSIONS) as OfficeKind[]) {
    if ((OFFICE_EXTENSIONS[kind] as readonly string[]).includes(ext)) return kind
  }
  return null
}
