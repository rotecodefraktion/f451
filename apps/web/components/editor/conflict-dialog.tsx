'use client'

import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n/provider'

export interface ConflictDialogProps {
  open: boolean
  /** Lokales Markdown (Frontmatter + Body) im Moment des Konflikts — NICHT live
   *  nachgeführt: der Dialog ist modal (`showModal`, inertes Hintergrund-DOM), der
   *  Nutzer kann während der Anzeige ohnehin nicht weiterschreiben. */
  localContent: string
  /** `currentContent` aus dem 409-Vertrag von `saveDraft` (Task 2). */
  currentContent: string
  onKeepServerVersion: () => void
  onKeepMyVersion: () => void
}

/**
 * Konflikt-Dialog (Phase 2c Task 4, Spec Abschnitt 9): natives `<dialog>`
 * (Muster `search-dialog.tsx`), zeigt beide Fassungen nebeneinander als
 * scrollbare `<pre>`-Spalten. Bewusst OHNE Escape-/Backdrop-Schließen — der
 * Dialog ist laut Spec die EINZIGE Fortsetzung aus dem `conflict`-Zustand der
 * Autosave-State-Machine (kein stilles Überschreiben, keine dritte Möglichkeit,
 * den Konflikt wegzuklicken ohne eine der beiden Entscheidungen zu treffen).
 */
export function ConflictDialog({
  open,
  localContent,
  currentContent,
  onKeepServerVersion,
  onKeepMyVersion,
}: ConflictDialogProps) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Weder ESC noch ein Klick auf den Backdrop schließen den Dialog (kein
  // `onClick`-Handler, der `dialog.close()` aufruft, s. Komponentenkommentar) —
  // `cancel` (ESC) wird zusätzlich explizit unterdrückt, damit der native
  // Default (Schließen) nicht greift.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    function onCancel(event: Event) {
      event.preventDefault()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [])

  return (
    <dialog ref={dialogRef} className="conflict-dialog" aria-label={t('editor.conflictDialog.ariaLabel')}>
      <div className="dialog-head">
        <h2>{t('editor.conflictDialog.heading')}</h2>
        <p>{t('editor.conflictDialog.description')}</p>
      </div>
      <div className="conflict-cols">
        <div className="conflict-col">
          <h3>{t('editor.conflictDialog.localHeading')}</h3>
          <pre>{localContent}</pre>
        </div>
        <div className="conflict-col">
          <h3>{t('editor.conflictDialog.serverHeading')}</h3>
          <pre>{currentContent}</pre>
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onKeepServerVersion}>
          {t('editor.conflictDialog.keepServer')}
        </button>
        <button type="button" className="btn primary" onClick={onKeepMyVersion}>
          {t('editor.conflictDialog.keepMine')}
        </button>
      </div>
    </dialog>
  )
}
