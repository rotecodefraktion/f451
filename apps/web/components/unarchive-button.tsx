'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ClientApiError, unarchivePage } from '../lib/editor/client-api'
import { apiErrorText } from '../lib/i18n/api-error-text.js'
import { useT } from '../lib/i18n/provider.js'

export interface UnarchiveButtonProps {
  pageId: string
}

/** `httpStatus` ist der NUMERISCHE HTTP-Status aus `UnarchivePageResult` — die
 *  UI zeigt daraus nur noch den lokalisierten Text zum Status-Code (`errors.*`
 *  via {@link apiErrorText}), NICHT mehr den rohen deutschen `result.error`
 *  aus der API (Phase 4, „API-Fehler-Mapping"). `networkError` ist der
 *  gefangene {@link ClientApiError}-Fall (kein Vertragsfall, kein
 *  HTTP-Status aus einer Antwort). */
type State =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; httpStatus: number }
  | { status: 'networkError' }

/**
 * „Aus Archiv holen"-Button im „Archiviert"-Chip-Block der Leseansicht
 * (Feature „Unarchive", Ergänzung zu `page-view.tsx`): eine archivierte Seite
 * blendet den „Bearbeiten"-Link aus (`page-view.tsx`: `{!data.archived ? <a
 * …>Bearbeiten</a> : null}`) — ohne diesen Weg käme niemand mehr in den
 * Editor, um `archived` aus dem Frontmatter zu entfernen. `POST
 * /api/pages/:id/unarchive` (s. `apps/api/src/routes/unarchive-page.ts`)
 * schreibt DIREKT auf `main`; nach Erfolg lädt `router.refresh()` die Seite
 * server-seitig neu (Muster `TreeNodeActions`), der Chip wechselt dann von
 * „Archiviert" auf „Released".
 *
 * Sichtbar für jeden mit Lesezugriff (kein eigener client-seitiger
 * Rechte-Check — dasselbe Muster wie der „Bearbeiten"-Link nebenan, der auch
 * keinen eigenen Check hat): die Gate-Kette (`resolveWriteContext`)
 * entscheidet server-seitig; fehlt das Schreibrecht, zeigt der Klick eine
 * Fehlermeldung statt eine still ausgeblendete aber irreführende Nicht-Aktion.
 */
export function UnarchiveButton({ pageId }: UnarchiveButtonProps) {
  const { t } = useT()
  const router = useRouter()
  const [state, setState] = useState<State>({ status: 'idle' })

  async function onClick() {
    setState({ status: 'submitting' })
    try {
      const result = await unarchivePage(pageId)
      if (result.ok) {
        router.refresh()
        return
      }
      setState({ status: 'error', httpStatus: result.status })
    } catch (err) {
      if (err instanceof ClientApiError) {
        setState({ status: 'networkError' })
      }
    }
  }

  const button = (
    <button type="button" className="btn" onClick={onClick} disabled={state.status === 'submitting'}>
      {t('actions.unarchive.button')}
    </button>
  )
  const errorMessage =
    state.status === 'error'
      ? apiErrorText(t, state.httpStatus)
      : state.status === 'networkError'
        ? t('actions.unarchive.genericError')
        : null

  // Hinweisblock-Baustein (43-flaeche.css) statt der zweckentfremdeten
  // Suchdialog-Statuszeile. `.callout` ist bewusst KEIN Flex-Kasten: die
  // Meldung als Geschwister NEBEN den Knopf zu setzen, hätte den Kasten in
  // der Werkzeugleiste an den Knopf geklebt (gemessen: Leistenhöhe 52 → 103px,
  // der Kasten rechts vom Knopf). Deshalb dasselbe Muster wie in den
  // Werkzeugseiten aus Teilschritt H4 — Meldung als `<p>`, der Knopf wird im
  // Fehlerfall die Wiederholungs-Aktion in der `.btn-row` des Kastens.
  return (
    <span className="unarchive-action">
      {errorMessage === null ? (
        button
      ) : (
        <div className="callout error" role="alert">
          <p>{errorMessage}</p>
          <div className="btn-row">{button}</div>
        </div>
      )}
    </span>
  )
}
