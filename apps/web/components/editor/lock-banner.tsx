'use client'

import { useT } from '../../lib/i18n/provider'

export interface LockBannerProps {
  heldBy: string
  onOverride: () => void
}

const LOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" strokeLinecap="round" />
  </svg>
)

/** Initialen aus dem Anzeigenamen — identisch zu `account-menu.tsx#initials`
 *  (bewusst dupliziert statt einer neuen geteilten Utility für eine einzige
 *  4-Zeilen-Funktion, s. Task-4-Self-Review). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase()
}

/**
 * Soft-Lock-Hinweis (`.notice.lock`, Stil aus `docs/design/mockups/leseansicht.html`).
 * Läuft NIE hart blockierend — dieselbe Komponente deckt zwei Fälle ab, die
 * `editor-root.tsx` beide über `heartbeatLock`-Antworten mit `mine:false` erkennt:
 * 1. Einstieg: ein anderer hält einen frischen Lock → Editor startet readonly,
 *    „Trotzdem bearbeiten" schaltet bewusst frei (Klick übernimmt den Lock via
 *    erneutem `heartbeatLock`).
 * 2. Laufender Betrieb: der eigene Lock ist an einen anderen gefallen (z. B.
 *    Tab lange im Hintergrund) → Banner erscheint erneut, aber NICHTS wird
 *    gesperrt (Autosave läuft unverändert weiter) — der Klick auf den Button
 *    ist in diesem Fall ein harmloses No-Op (Editor ist schon editierbar).
 */
export function LockBanner({ heldBy, onOverride }: LockBannerProps) {
  const { t } = useT()
  return (
    <div className="notices">
      <div className="notice lock" role="status">
        <span className="who">{initials(heldBy)}</span>
        <span className="ic">{LOCK_ICON}</span>
        <span className="txt">
          <b>{heldBy}</b> {t('editor.lockBanner.messageSuffix')}
        </span>
        <span className="grow" />
        <button type="button" className="btn" onClick={onOverride}>
          {t('editor.lockBanner.override')}
        </button>
      </div>
    </div>
  )
}
