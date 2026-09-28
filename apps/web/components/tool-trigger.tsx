'use client'

import type { ReactNode } from 'react'

export interface ToolTriggerProps {
  /**
   * Name des CustomEvent, das der Klick auf `document` feuert — der Empfänger
   * hängt an anderer Stelle im Baum (Suchdialog bzw. Tastenkürzel-Übersicht).
   * Das Ereignis ist die ganze Kopplung: die Werkzeugliste kennt den Dialog
   * nicht und braucht keinen gemeinsamen Elternzustand.
   */
  eventName: string
  className?: string
  /** Zugänglicher Name des Knopfes. Ohne ihn läse ein Screenreader den
   *  gesamten Zeileninhalt vor (Titel + Erklärsatz + Tastenkürzel). */
  'aria-label'?: string
  children: ReactNode
}

/**
 * Winzige Client-Insel für die zwei Werkzeug-Zeilen, die keinen Ort öffnen,
 * sondern einen Dialog: Sie sehen aus wie die fünf Link-Zeilen daneben, sind
 * aber `<button>` und feuern beim Klick ein CustomEvent. Nötig, weil das
 * Space-Layout (`app/wiki/[space]/(shell)/layout.tsx`) eine Server Component
 * ist und dort kein `onClick` entstehen kann — dasselbe Muster wie
 * `components/active-link.tsx`.
 */
export function ToolTrigger({ eventName, className, 'aria-label': ariaLabel, children }: ToolTriggerProps) {
  return (
    <button
      type="button"
      className={className}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      onClick={() => document.dispatchEvent(new CustomEvent(eventName))}
    >
      {children}
    </button>
  )
}
