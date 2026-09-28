'use client'

import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n/provider'

export interface ResetRecoveryDialogProps {
  open: boolean
  /** Der von `POST /draft/update` gerettete Inhalt (Finding 1, Fix-Runde 1) —
   *  s. `lib/editor/reset-recovery.ts`-Modulkommentar für den vollen Vertrag. */
  preservedContent: string
  /** Übernimmt `preservedContent` in den Editor (dirty, Autosave sichert ihn
   *  in den — ggf. neu angelegten — Draft). */
  onApply: () => void
  /** Verwirft den geretteten Inhalt endgültig — fragt selbst nach (Muster
   *  `status-bar.tsx#handleDiscardClick`), der Aufrufer bekommt nur den
   *  bereits bestätigten Klick. */
  onDiscard: () => void
}

/**
 * Wiederherstellungs-Dialog für den Reset-Fehlerpfad (Phase 2d Task 6,
 * Fix-Runde 1 — Finding 1: `handleResetToLastRelease` warf `preservedContent`
 * bislang stillschweigend weg). Natives `<dialog>`, Muster `conflict-dialog.tsx`
 * (EINZIGE Fortsetzung aus diesem Zustand — kein Escape-/Backdrop-Schließen,
 * damit der gerettete Inhalt nicht versehentlich wegkommt, ohne dass sich der
 * Nutzer für „übernehmen" oder „verwerfen" entschieden hat).
 */
export function ResetRecoveryDialog({ open, preservedContent, onApply, onDiscard }: ResetRecoveryDialogProps) {
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
    <dialog ref={dialogRef} className="conflict-dialog reset-recovery-dialog" aria-label={t('editor.resetRecoveryDialog.ariaLabel')}>
      <div className="dialog-head">
        <h2>{t('editor.resetRecoveryDialog.heading')}</h2>
        <p>{t('editor.resetRecoveryDialog.description')}</p>
      </div>
      <div className="conflict-col reset-recovery-col">
        <h3>{t('editor.resetRecoveryDialog.contentHeading')}</h3>
        <pre>{preservedContent}</pre>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onDiscard}>
          {t('editor.resetRecoveryDialog.discard')}
        </button>
        <button type="button" className="btn primary" onClick={onApply}>
          {t('editor.resetRecoveryDialog.apply')}
        </button>
      </div>
    </dialog>
  )
}
