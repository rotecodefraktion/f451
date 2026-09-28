'use client'

import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n/provider'
import type { Locale } from '../../lib/i18n/types'

/** ISO-Zeitstempel → lokalisiertes Datum+Uhrzeit („TT.MM.JJJJ, HH:MM" bzw.
 *  locale-abhängiges Äquivalent). Ungültiger Wert → Rohwert (Muster
 *  `page-view.ts#formatUpdatedAt`, hier lokal statt dort, weil Datum UND
 *  Uhrzeit gebraucht werden — `formatUpdatedAt` liefert nur das Datum). */
function formatSavedAt(iso: string, locale: Locale): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

export interface OfflineRecoveryDialogProps {
  open: boolean
  /** Zeitpunkt der Pufferung (`OfflineDraft.savedAt`, s. `lib/editor/offline-buffer.ts`). */
  savedAt: string
  /** `true`, wenn der Puffer von einem anderen Draft-Branch stammt als der
   *  gerade geladene (s. `evaluateOfflineRecovery`-Regel 4 in
   *  `lib/editor/offline-recovery.ts`) — zeigt einen zusätzlichen Hinweis,
   *  dass der Puffer von einem älteren Entwurf stammt. */
  foreignBranch: boolean
  /** Übernimmt den gepufferten Inhalt in den Editor (dirty, nächster Autosave
   *  sichert ihn). Der Puffer selbst bleibt bis zum Save-Erfolg bestehen —
   *  den räumt Task 2 (`saveContent`s Erfolgspfad). */
  onApply: () => void
  /** Verwirft den Puffer endgültig (`clearOfflineDraft`) — normaler Mount
   *  mit dem Server-Stand. */
  onDiscard: () => void
}

/**
 * Mount-Recovery-Dialog (Phase 4b Task 3, Spec §9): bietet einen von Task 2
 * gepufferten Entwurf beim Editor-Start an, statt ihn still einzuspielen —
 * der Nutzer könnte ihn bewusst verworfen haben (z. B. „Serverstand
 * übernehmen" im Konflikt-Dialog). Natives `<dialog>`, Struktur-/CSS-/
 * Inertness-/Fokus-/Escape-Muster 1:1 aus `reset-recovery-dialog.tsx`
 * übernommen (selbst kein Mockup-Vorbild): bewusst OHNE Escape-/Backdrop-
 * Schließen — der Dialog ist die einzige Fortsetzung aus diesem Zustand,
 * „Übernehmen"/„Verwerfen" sind die einzigen beiden Wege heraus (kein
 * drittes Wegklicken, das den Puffer unentschieden weiter bestehen lässt).
 */
export function OfflineRecoveryDialog({ open, savedAt, foreignBranch, onApply, onDiscard }: OfflineRecoveryDialogProps) {
  const { t, locale } = useT()
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
    <dialog ref={dialogRef} className="conflict-dialog offline-recovery-dialog" aria-label={t('editor.offlineRecoveryDialog.ariaLabel')}>
      <div className="dialog-head">
        <h2>{t('editor.offlineRecoveryDialog.heading')}</h2>
        <p>{t('editor.offlineRecoveryDialog.description', { date: formatSavedAt(savedAt, locale) })}</p>
        {foreignBranch ? <p>{t('editor.offlineRecoveryDialog.foreignBranchHint')}</p> : null}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onDiscard}>
          {t('editor.offlineRecoveryDialog.discard')}
        </button>
        <button type="button" className="btn primary" onClick={onApply}>
          {t('editor.offlineRecoveryDialog.apply')}
        </button>
      </div>
    </dialog>
  )
}
