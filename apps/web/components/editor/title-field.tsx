'use client'

import { useT } from '../../lib/i18n/provider'

export interface TitleFieldProps {
  /** Aktueller Titel, abgeleitet aus `frontmatter.title` (`lib/editor/frontmatter-fields.ts#titleFromFrontmatter`,
   *  EINE Quelle wie beim Metadaten-Formular, s. `editor-root.tsx`). `''`, wenn
   *  kein `title`-Feld gesetzt ist. */
  title: string
  /** Aktueller Archiviert-Status, abgeleitet aus `frontmatter.archived`. */
  archived: boolean
  /** `false` im Roh-Text-Modus UND während eines fremden, noch nicht
   *  übernommenen Soft-Locks — dasselbe Muster wie `MetadataPanel`s
   *  `editable`-Prop (der Roh-Modus bleibt der einzige Frontmatter-EDITOR,
   *  solange er aktiv ist). */
  editable: boolean
  onTitleChange: (value: string) => void
  onArchivedToggle: () => void
}

/**
 * Prominentes, editierbares Titelfeld OBEN im Editor (Feature „Sichtbares
 * Titelfeld") — direkt gefolgt vom „Archivieren"-Toggle (Feature
 * „Archivieren"), da beide denselben Frontmatter-Schreibpfad
 * (`setFrontmatterMetadata`, s. `editor-root.tsx`) und dieselbe
 * `editable`-Bedingung teilen. Reine Anzeige-/Eingabe-Komponente (Muster
 * `MetadataPanel`): die gesamte Zustands-/Schreiblogik lebt in
 * `editor-root.tsx`.
 */
export function TitleField({ title, archived, editable, onTitleChange, onArchivedToggle }: TitleFieldProps) {
  const { t } = useT()
  return (
    <div className="page-title-field">
      <input
        type="text"
        className="input page-title-input"
        value={title}
        placeholder={t('editor.titleField.placeholder')}
        aria-label={t('editor.titleField.ariaLabel')}
        disabled={!editable}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <label className="page-title-archived">
        <input type="checkbox" checked={archived} disabled={!editable} onChange={onArchivedToggle} />
        {archived ? t('editor.titleField.archived') : t('editor.titleField.archive')}
      </label>
    </div>
  )
}
