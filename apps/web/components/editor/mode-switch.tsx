'use client'

// s. slash-menu.tsx: `React` explizit importiert wegen des klassischen JSX-Transforms
// unter Vitest, das modul-level `<svg>`-Konstanten sonst als `React.createElement`-
// Aufruf ohne sichtbares `React` im Scope emittiert.
import React, { useEffect, useRef } from 'react'
import type { SupportFinding } from '@f451/editor'
import type { EditorMode } from '../../lib/editor/mode-switch-core'
import { useT } from '../../lib/i18n/provider'

export interface ModeSwitchProps {
  mode: EditorMode
  /** Tooltip-Text für den WYSIWYG-Tab, wenn der letzte bekannte Stand den
   *  Wechsel verweigern würde (Task 6: „sichtbare Begründung" — Startmodus
   *  UND jeder erneut verweigerte Klick aktualisieren dies). `null`, solange
   *  kein Grund bekannt ist. */
  wysiwygBlockReason: string | null
  onSwitchToWysiwyg: () => void
  onSwitchToRaw: () => void
  /** `null` außerhalb eines laufenden Bestätigungsvorgangs. `canonicalBody`
   *  wird bewusst NICHT hier gehalten (nur `editor-root.tsx` braucht sie für
   *  die eigentliche Übernahme, s. `onConfirmNormalize`) — diese Komponente
   *  zeigt nur die Befundliste. */
  pendingConfirm: { findings: SupportFinding[] } | null
  onConfirmNormalize: () => void
  onCancelConfirm: () => void
}

const WYSIWYG_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 6h16M4 10h10M4 14h16M4 18h8" strokeLinecap="round" />
  </svg>
)

const MARKDOWN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="m9 8-4 4 4 4M15 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * `.editorfoot`-Umschalter „WYSIWYG | Markdown" (segmentierte Auswahl) + der
 * Bestätigungs-`<dialog>` für den Roh→WYSIWYG-Wechsel bei
 * `normalization`-Befunden. Die
 * gesamte Entscheidungslogik (`evaluateModeSwitch`, Content-Transformation,
 * Autosave-Kopplung) lebt bewusst in `editor-root.tsx` (`EditorSession`) —
 * diese Komponente ist reine Anzeige + der eine lokale UI-Zustand, den kein
 * anderer Konsument braucht: Öffnen/Schließen des nativen Dialogs.
 *
 * WYSIWYG→Roh ist laut Spec IMMER erlaubt — `onSwitchToRaw` ruft direkt
 * durch, ohne jede Prüfung hier. Roh→WYSIWYG läuft über `onSwitchToWysiwyg`;
 * bei Ablehnung ändert sich `mode` schlicht nicht (die WYSIWYG-Lasche bleibt
 * dadurch die nicht gedrückte — „bleibt inaktiv" braucht keinen Extra-Zustand),
 * bei nötiger Bestätigung setzt `editor-root.tsx` `pendingConfirm`.
 */
export function ModeSwitch({
  mode,
  wysiwygBlockReason,
  onSwitchToWysiwyg,
  onSwitchToRaw,
  pendingConfirm,
  onConfirmNormalize,
  onCancelConfirm,
}: ModeSwitchProps) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (pendingConfirm && !dialog.open) {
      dialog.showModal()
    } else if (!pendingConfirm && dialog.open) {
      dialog.close()
    }
  }, [pendingConfirm])

  // ESC/Backdrop-Klick dürfen hier schließen (anders als der Konflikt-Dialog)
  // — beides bedeutet schlicht „Abbrechen", der Roh-Modus bleibt unverändert
  // eine gültige Fortsetzung.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    function onClose() {
      onCancelConfirm()
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [onCancelConfirm])

  function onBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close()
    }
  }

  return (
    <>
      {/* Segmentierte Auswahl, kein Reiter (Teilschritt G, s. Kommentarkopf
          von `app/styles/45-auswahl.css`): der Umschalter stellt EINEN
          Bereich um, statt zwischen mehreren umzuschalten — und er darf den
          Wechsel verweigern, was eine Reiterlasche nicht darf. Deshalb
          `role="group"` mit gewöhnlichen Schaltflächen und `aria-pressed`
          statt `role="tablist"`/`aria-selected`.

          Der Zustand hängt an GENAU EINEM Merkmal. Vorher trug der aktive
          Knoten `className="on"` UND `aria-selected` — zwei Regeln stritten
          um dasselbe Element, und die Klassenregel verlor stillschweigend
          (Bestandsaufnahme §6.2). */}
      <div className="segmented" role="group" aria-label={t('editor.modeSwitch.ariaLabel')}>
        <button
          type="button"
          aria-pressed={mode === 'wysiwyg'}
          title={mode === 'raw' ? (wysiwygBlockReason ?? undefined) : undefined}
          onClick={onSwitchToWysiwyg}
        >
          {WYSIWYG_ICON}
          {t('editor.modeSwitch.wysiwyg')}
        </button>
        <button type="button" aria-pressed={mode === 'raw'} onClick={onSwitchToRaw}>
          {MARKDOWN_ICON}
          {t('editor.modeSwitch.markdown')}
        </button>
      </div>

      <dialog
        ref={dialogRef}
        className="mode-confirm-dialog"
        aria-label={t('editor.modeSwitch.confirmAriaLabel')}
        onClick={onBackdropClick}
      >
        <div className="dialog-head">
          <h2>{t('editor.modeSwitch.confirmHeading')}</h2>
          <p>{t('editor.modeSwitch.confirmDescription')}</p>
        </div>
        <ul className="mode-confirm-findings">
          {pendingConfirm?.findings.map((finding, index) => <li key={index}>{finding.message}</li>)}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
            {t('editor.modeSwitch.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={onConfirmNormalize}>
            {t('editor.modeSwitch.confirm')}
          </button>
        </div>
      </dialog>
    </>
  )
}
