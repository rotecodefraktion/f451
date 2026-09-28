'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SessionExpiredError, movePage, type MovePageResult } from '../lib/editor/client-api'
import { apiErrorText } from '../lib/i18n/api-error-text.js'
import { useT } from '../lib/i18n/provider.js'
import { wikiPageHref } from '../lib/urls'

/** Minimal-Sicht auf einen Baum-Knoten, die die Dialoge brauchen. */
export interface ActionNode {
  id: string
  title: string
  path: string
}

/** Flache Liste ALLER Seiten des Space (aus demselben Baum, den `Tree`
 *  ohnehin schon rendert) für den Ziel-Parent-Picker im Verschieben-Dialog —
 *  `depth` steuert nur die Einrückung im `<select>` (visuelle Hierarchie),
 *  keine client-seitige Zyklus-Filterung (Design-Vorgabe „einfache Auswahl
 *  reicht" — ein ungültiges Ziel, z. B. der eigene Unterbaum, wird vom Server
 *  mit 400 abgelehnt und im Dialog angezeigt, s. `movePage`). */
export interface FlatNode extends ActionNode {
  depth: number
}

export interface TreeNodeActionsProps {
  space: string
  node: ActionNode
  allNodes: readonly FlatNode[]
}

const RENAME_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const MOVE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M5 9l-3 3 3 3M19 9l3 3-3 3M2 12h20" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Sentinel-Wert des `<select>`-Elements für „Space-Wurzel" — `movePage`
 *  erwartet dafür `parentId: null` (Vertrag `apps/api/src/routes/move-page.ts`),
 *  ein HTML-`<option>`-Wert kann aber kein `null` tragen, nur Strings. */
const ROOT_OPTION_VALUE = '__root__'

/**
 * Der Wert, den der Ziel-Picker beim Öffnen zeigen muss: der Elternteil, unter
 * dem die Seite HEUTE liegt.
 *
 * Bis hierher stand dort immer „Space-Wurzel". Wer den Dialog öffnete und
 * einfach bestätigte, verschob eine Seite der obersten Ebene damit auf ihren
 * eigenen Platz — der Server erkennt das als „nichts zu tun" und meldet
 * Erfolg, der Dialog schloss sich, und nichts war passiert. Diagnostiziert am
 * 2026-07-28 an „UID/GID-Register": HTTP 200 in siebeneinhalb Millisekunden,
 * `movedCount: 0`.
 *
 * Der Elternteil wird über den Pfad gesucht, nicht über eine Kind-Beziehung:
 * Eine Seite liegt unter `<eltern>/<eigenes>/index.md`, ihr Elternteil ist
 * also die Seite unter `<eltern>/index.md`. Findet sich dort keine (die Seite
 * liegt direkt im Space), ist die Space-Wurzel richtig.
 */
function currentParentValue(node: ActionNode, allNodes: readonly FlatNode[]): string {
  const ownDir = node.path.includes('/') ? node.path.replace(/\/[^/]*$/, '') : ''
  const parentDir = ownDir.includes('/') ? ownDir.replace(/\/[^/]*$/, '') : ''
  if (parentDir === '') return ROOT_OPTION_VALUE
  return allNodes.find((n) => n.path === `${parentDir}/index.md`)?.id ?? ROOT_OPTION_VALUE
}

/** `httpStatus` ist der NUMERISCHE HTTP-Status aus `MovePageResult` — die UI
 *  zeigt daraus nur noch den lokalisierten Text zum Status-Code (`errors.*`
 *  via {@link apiErrorText}), NICHT mehr den rohen deutschen `result.error`
 *  aus der API (Phase 4, „API-Fehler-Mapping"). `networkError` ist der
 *  gefangene {@link ClientApiError}-Fall (kein Vertragsfall, kein
 *  HTTP-Status aus einer Antwort). */
type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'collision'; httpStatus: number; existingPageId: string }
  | { status: 'blocked'; httpStatus: number }
  | { status: 'error'; httpStatus: number }
  | { status: 'networkError' }
  /** Erfolg, aber nichts bewegt (`movedCount: 0`) — s. {@link currentParentValue}. */
  | { status: 'unchanged' }

function errorMessageFrom(result: Extract<MovePageResult, { ok: false }>): SubmitState {
  if (result.status === 409 && result.pageId) {
    return { status: 'collision', httpStatus: result.status, existingPageId: result.pageId }
  }
  if (result.status === 409 && result.blockedPageIds) {
    return { status: 'blocked', httpStatus: result.status }
  }
  return { status: 'error', httpStatus: result.status }
}

/**
 * Kontextmenü-Einstieg „Umbenennen"/„Verschieben" je Baum-Knoten (Phase 3.2) —
 * Muster `new-page-button.tsx`: zwei kleine, per Hover sichtbare Trigger-
 * Buttons (`.node-actions`, `app/globals.css`) im Seitenbaum, je EIN natives
 * `<dialog>` für Titel- bzw. Ziel-Parent-Eingabe. Beide Dialoge teilen sich
 * dieselbe Submit-/Fehlerbehandlung ({@link movePage}s diskriminiertes
 * Ergebnis: 409-Kollision mit Link zur bestehenden Seite, 409-Blockade bei
 * offenem Draft/Review, generische Fehlermeldung sonst). Nach Erfolg wird der
 * Dialog geschlossen und `router.refresh()` aufgerufen (Server-Component-Baum
 * neu laden) — die URL selbst bleibt unverändert (stabile Id, Phase 3.1).
 */
export function TreeNodeActions({ space, node, allNodes }: TreeNodeActionsProps) {
  const { t } = useT()
  const router = useRouter()
  const [openDialog, setOpenDialog] = useState<'rename' | 'move' | null>(null)
  const [title, setTitle] = useState(node.title)
  const [parentChoice, setParentChoice] = useState<string>(() => currentParentValue(node, allNodes))
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const renameDialogRef = useRef<HTMLDialogElement>(null)
  const moveDialogRef = useRef<HTMLDialogElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const dialog = openDialog === 'rename' ? renameDialogRef.current : openDialog === 'move' ? moveDialogRef.current : null
    if (openDialog && dialog && !dialog.open) {
      dialog.showModal()
      requestAnimationFrame(() => titleInputRef.current?.focus())
    }
  }, [openDialog])

  function closeAndReset(dialog: HTMLDialogElement | null) {
    dialog?.close()
    setOpenDialog(null)
    setTitle(node.title)
    setParentChoice(currentParentValue(node, allNodes))
    setState({ status: 'idle' })
  }

  function onBackdropClick(dialog: HTMLDialogElement | null) {
    return (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === dialog) closeAndReset(dialog)
    }
  }

  async function submitMove(input: { title?: string; parentId?: string | null }) {
    setState({ status: 'submitting' })
    try {
      const result = await movePage(node.id, input)
      if (result.ok) {
        // `movedCount: 0` heißt: Der Server hat den Auftrag angenommen und
        // festgestellt, dass Ziel und Quelle dasselbe sind. Das ist kein
        // Fehler, aber auch kein Erfolg, den man wortlos wegklicken darf —
        // der Dialog bleibt offen und sagt es.
        if (result.page.movedCount === 0) {
          setState({ status: 'unchanged' })
          return
        }
        closeAndReset(openDialog === 'rename' ? renameDialogRef.current : moveDialogRef.current)
        router.refresh()
        return
      }
      setState(errorMessageFrom(result))
    } catch (err) {
      // Eine abgelaufene Sitzung leitet bereits zur Anmeldung um (s.
      // `movePage`) — dort eine Fehlerkarte einzublenden, hieße dem Anwender
      // im Weggehen noch etwas zuzurufen.
      if (err instanceof SessionExpiredError) return
      // Alles Übrige landet in derselben Karte, auch ein abgerissener
      // fetch-Aufruf. Zuvor stand hier nur ein Zweig für `ClientApiError`:
      // Bei einem echten Netzwerkabbruch blieb der Zustand auf „wird
      // gesendet" stehen — ein Dialog, der bis zum Neuladen wartet, ohne je
      // etwas zu sagen.
      setState({ status: 'networkError' })
    }
  }

  async function onRenameSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length === 0 || trimmed === node.title) return
    await submitMove({ title: trimmed })
  }

  async function onMoveSubmit(event: React.FormEvent) {
    event.preventDefault()
    const parentId = parentChoice === ROOT_OPTION_VALUE ? null : parentChoice
    await submitMove({ parentId })
  }

  // Hinweisblock-Baustein (43-flaeche.css), gleiches Muster wie in
  // `new-page-button.tsx`: Meldung als `<p>`, Aktion in `.btn-row`, weil
  // `.callout` bewusst kein Flex-Kasten ist. Die drei Inline-Stile
  // `padding: 0, textAlign: 'left'` entfallen mit der zweckentfremdeten
  // Klasse `.search-dialog-status`, deren Werte sie zurücknahmen.
  const statusMessage =
    state.status === 'collision' ? (
      <div className="callout error" role="alert">
        <p>{apiErrorText(t, state.httpStatus)}</p>
        <div className="btn-row">
          <a href={wikiPageHref(space, state.existingPageId)}>{t('actions.existingPageLink')}</a>
        </div>
      </div>
    ) : state.status === 'blocked' || state.status === 'error' ? (
      <div className="callout error" role="alert">
        <p>{apiErrorText(t, state.httpStatus)}</p>
      </div>
    ) : state.status === 'networkError' ? (
      <div className="callout error" role="alert">
        <p>{t('actions.moveRename.genericError')}</p>
      </div>
    ) : state.status === 'unchanged' ? (
      // Kein Fehler: Der Auftrag war widerspruchsfrei, er lief nur ins Leere.
      // `status` statt `alert`, weil hier nichts schiefging.
      <div className="callout" role="status">
        <p>{t('actions.moveRename.unchanged')}</p>
      </div>
    ) : state.status === 'submitting' ? (
      <div className="callout" role="status">
        <p>{t('actions.moveRename.submitting')}</p>
      </div>
    ) : null

  // Ziel-Parent-Auswahl im Verschieben-Dialog schließt den Knoten selbst aus
  // (keine Selbst-Elternschaft) — jede weitere Zyklus-Prüfung (Verschieben in
  // den eigenen Unterbaum) übernimmt der Server (400, s. Modul-Kommentar).
  const parentOptions = allNodes.filter((n) => n.id !== node.id)

  return (
    <span className="node-actions">
      <button
        type="button"
        className="btn quiet small"
        title={t('actions.rename.triggerTitle')}
        aria-label={t('actions.rename.triggerAriaLabel', { title: node.title })}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpenDialog('rename')
        }}
      >
        {RENAME_ICON}
      </button>
      <button
        type="button"
        className="btn quiet small"
        title={t('actions.move.triggerTitle')}
        aria-label={t('actions.move.triggerAriaLabel', { title: node.title })}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpenDialog('move')
        }}
      >
        {MOVE_ICON}
      </button>

      <dialog
        ref={renameDialogRef}
        className="newpage-dialog"
        aria-label={t('actions.rename.dialogAriaLabel')}
        onClick={onBackdropClick(renameDialogRef.current)}
        onClose={() => closeAndReset(renameDialogRef.current)}
      >
        <div className="dialog-head">
          <h2>{t('actions.rename.heading', { title: node.title })}</h2>
        </div>
        <form onSubmit={onRenameSubmit}>
          <div className="newpage-body">
            <label>
              {t('actions.rename.fieldLabel')}
              <input
                ref={openDialog === 'rename' ? titleInputRef : undefined}
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                autoComplete="off"
              />
            </label>
            {statusMessage}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => closeAndReset(renameDialogRef.current)}>
              {t('actions.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={state.status === 'submitting'}>
              {t('actions.rename.submit')}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={moveDialogRef}
        className="newpage-dialog"
        aria-label={t('actions.move.dialogAriaLabel')}
        onClick={onBackdropClick(moveDialogRef.current)}
        onClose={() => closeAndReset(moveDialogRef.current)}
      >
        <div className="dialog-head">
          <h2>{t('actions.move.heading', { title: node.title })}</h2>
        </div>
        <form onSubmit={onMoveSubmit}>
          <div className="newpage-body">
            <label>
              {t('actions.move.fieldLabel')}
              <select value={parentChoice} onChange={(event) => setParentChoice(event.target.value)}>
                <option value={ROOT_OPTION_VALUE}>{t('actions.move.rootOption')}</option>
                {parentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {'  '.repeat(option.depth)}
                    {option.title}
                  </option>
                ))}
              </select>
            </label>
            {statusMessage}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => closeAndReset(moveDialogRef.current)}>
              {t('actions.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={state.status === 'submitting'}>
              {t('actions.move.submit')}
            </button>
          </div>
        </form>
      </dialog>
    </span>
  )
}
