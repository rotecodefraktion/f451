'use client'

// s. mode-switch.tsx: `React` explizit importiert (klassischer JSX-Transform unter Vitest).
import React, { useEffect, useRef } from 'react'
import type { SupportFinding } from '@f451/editor'
import { useT } from '../../lib/i18n/provider'

export interface FindingsPanelProps {
  /** `finding.line` (wo gesetzt) ist hier IMMER die volle Dokumentzeile, nie
   *  body-relativ — diese Komponente rechnet selbst nichts um (Final-Review
   *  Phase 2c Task 6, Critical-Fix). Jeder Aufrufer (`editor-root.tsx`,
   *  `raw-editor.tsx`) wendet den Frontmatter-Offset (`lib/editor/
   *  frontmatter-offset.ts`) bereits an, BEVOR er hierher gereicht wird —
   *  `checkEditorSupport` selbst liefert Zeilen weiterhin body-relativ (s.
   *  dortiger Vertrag), das bleibt unverändert. */
  findings: SupportFinding[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Nur im Roh-Modus sinnvoll — nur `unsupported`-Befunde tragen `line`
   *  (s. `@f451/editor`-README), die ausschließlich dort vorkommen können
   *  (der WYSIWYG-Editor kann per Schema keine nicht abbildbare Syntax
   *  erzeugen). `undefined` deaktiviert das Klick-Verhalten der Zeile. `line`
   *  ist die volle Dokumentzeile (s. `findings` oben) — passt direkt zu
   *  `RawEditorHandle#scrollToLine`s Erwartung. */
  onLineClick?: (line: number) => void
}

const ICONS: Record<SupportFinding['kind'], React.ReactNode> = {
  unsupported: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M12 3 2 20h20L12 3Z" strokeLinejoin="round" />
      <path d="M12 10v4M12 17v.01" strokeLinecap="round" />
    </svg>
  ),
  normalization: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M3 8a9 9 0 1 1 1 5" strokeLinecap="round" />
      <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  frontmatter: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h5" strokeLinecap="round" />
    </svg>
  ),
}

const VALID_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 3 2 20h20L12 3Z" strokeLinejoin="round" />
    <path d="M12 10v4M12 17v.01" strokeLinecap="round" />
  </svg>
)

/**
 * Der `.valid`-Button im Editor-Footer (Mockup) + sein Popover mit der
 * vollständigen Befundliste (Task 6). Quelle: `findings` — der jeweils
 * letzte `checkEditorSupport`-Report, den `editor-root.tsx` zusammenträgt
 * (WYSIWYG: bei Moduswechsel/Save; Roh: aus dem Lint-Lauf von `raw-editor.tsx`)
 * — dadurch aus BEIDEN Editor-Modi erreichbar, ohne dass diese Komponente
 * selbst wissen muss, in welchem Modus sie gerade läuft.
 */
export function FindingsPanel({ findings, open, onOpenChange, onLineClick }: FindingsPanelProps) {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)

  // Klick außerhalb ODER Escape schließt das Popover — kein natives <dialog>
  // hier (kein Fokus-Trap gewünscht: das Popover ist ein Nachschlage-Werkzeug
  // neben dem eigentlichen Editor, kein modaler Vorgang).
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  const ok = findings.length === 0

  return (
    <div className="findings-trigger" ref={containerRef}>
      {/* Statusmarke des Bausteinsystems (`styles/42-marke.css`) statt der
          früheren Eigenklasse `.valid`. Der Zustand steckt jetzt in der
          Variante, nicht mehr in einem eingefärbten Wort innerhalb einer
          immer bernsteinfarbenen Marke: Zeichen, Wort UND Fläche sagen
          dasselbe (Spec „Zugesicherte Eigenschaften", Punkt 3). */}
      <button
        type="button"
        className={ok ? 'chip released' : 'chip review'}
        title={t('editor.findingsPanel.openTitle')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {VALID_ICON}
        {ok ? t('editor.findingsPanel.ok') : t('editor.findingsPanel.count', { count: findings.length })}
      </button>
      {open ? (
        <div className="menu findings-pop" role="dialog" aria-label={t('editor.findingsPanel.ariaLabel')}>
          {ok ? (
            <p className="findings-empty">{t('editor.findingsPanel.empty')}</p>
          ) : (
            <ul className="findings-list">
              {findings.map((finding, index) => (
                <li
                  key={index}
                  className={`finding${finding.line !== undefined && onLineClick ? ' clickable' : ''}`}
                  onClick={finding.line !== undefined && onLineClick ? () => onLineClick(finding.line!) : undefined}
                >
                  <span className={`fi-icon ${finding.kind}`}>{ICONS[finding.kind]}</span>
                  <span className="fi-text">{finding.message}</span>
                  {finding.line !== undefined ? (
                    <span className="fi-line">{t('editor.findingsPanel.line', { line: finding.line })}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
