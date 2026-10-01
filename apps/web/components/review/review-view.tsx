'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { nextVersion, type VersionBump } from '@f451/markdown'
import {
  ClientApiError,
  releasePage,
  requestChanges,
  updateDraft,
  type UpdateDraftStrategy,
} from '../../lib/editor/client-api'
import { useT } from '../../lib/i18n/provider.js'
import { wikiPageHref } from '../../lib/urls'

export interface ReviewViewProps {
  pageId: string
  space: string
  pr: { number: number; url: string; mergeable: boolean | null }
  /** Seitenversionierung Etappe 1 (Task 9): ob der Space versioniert ist —
   *  blendet den Sprunggrößen-Abschnitt im Freigabe-Dialog ein/aus. Kommt aus
   *  `GET .../review` (Befund 3, Final-Review: seit dort mitgeliefert, s.
   *  `apps/api/src/routes/workflow.ts#reviewGetSchema` — vorher ein zweiter,
   *  fehler-toleranter Fetch auf `GET /api/pages/:id`). */
  versioning?: boolean
  /** Version aus main VOR dieser Freigabe — Basis für die Sprung-Vorschau
   *  (`nextVersion`). Fehlt, wenn die Seite noch nie freigegeben wurde. */
  currentVersion?: string
}

const WARN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 3 2 20h20L12 3Z" strokeLinejoin="round" />
    <path d="M12 10v4M12 17v.01" strokeLinecap="round" />
  </svg>
)

const CHECK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} aria-hidden="true">
    <path d="m5 13 4 4 10-11" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const MERGE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5c0 4-6 3-6 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const REQUEST_CHANGES_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 5 5v3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const REBASE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 12a8 8 0 0 1-13.7 5.7L4 16" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4v4h-4M4 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

type UpdateFailure = { message: string; preservedContent?: string }

/**
 * Aktionsbereich der Review-Seite (Phase 2d Task 7) — `'use client'`, weil
 * es der einzige interaktive Teil der Seite ist (Diff-Darstellung selbst ist
 * statisch, s. `diff-view.tsx`-Kopfkommentar). Struktur 1:1 aus
 * `docs/design/mockups/review-diff.html` (`.actions`/`.notice.conflict`),
 * OHNE die dortige Reviewer-Chip-Liste (`.rchip`, Backlog — s.
 * `apps/api/README.md` „Backlog — Reviewer-Liste").
 *
 * Teilschritt H3 des Bausteinsystem-Umbaus hat die Klassen dieser Ansicht auf
 * die Bausteine umgestellt — inklusive der Bedeutungsumkehr aus dem Kopf von
 * `app/styles/40-schaltflaeche.css`: `.btn` ist jetzt die neutrale Grundform,
 * `.btn.primary` die Hauptaktion. „Freigeben" ist damit `btn primary` (vorher
 * `btn merge`), „Entwurf aktualisieren" `btn danger` (vorher `btn rebase`),
 * die zurückgenommenen Schaltflächen sind `btn` (vorher `btn ghost`).
 * Kommentarfeld und Änderungsnotiz tragen `input` (`41-eingabe.css`), das
 * Sprunggrößen-Fieldset `card` (`43-flaeche.css`), die Schaltflächenreihen
 * `btn-row`. Der einzige Inline-Stil dieser Datei (roter Pflicht-Hinweis) ist
 * zur Klasse `act-hint err` geworden.
 *
 * `pr.mergeable` kommt initial vom Server (`GET .../review`), kann sich aber
 * INNERHALB dieser Seite ändern, ohne dass die Server Component neu lädt:
 * ein 409/`reason:'conflict'` von `releasePage` bedeutet „main ist seitdem
 * weitergezogen" — das wird als lokaler Override (`conflictOverride`)
 * nachgeführt, NICHT als eigenständiger `mergeable`-State, damit ein
 * `router.refresh()` (nach „Entwurf aktualisieren") den frischen Server-Stand
 * NIE mit einem stehengebliebenen Client-Override überschreibt: der Effekt
 * unten setzt den Override zurück, sobald neue `pr`-Props hereinkommen.
 */
export function ReviewView({ pageId, space, pr, versioning = false, currentVersion }: ReviewViewProps) {
  const router = useRouter()
  const { t } = useT()
  const [comment, setComment] = useState('')
  const [commentRequiredError, setCommentRequiredError] = useState(false)
  // Sprunggröße/Änderungsnotiz (Task 9) — nur relevant, wenn `versioning`
  // aktiv ist (s. Fieldset unten); Default 'minor' wie im Brief (die
  // häufigste Freigabe-Art: neuer Inhalt, kein Breaking Change).
  const [bump, setBump] = useState<VersionBump>('minor')
  const [versionNote, setVersionNote] = useState('')
  // Release archive (#38): freeze this version as a permanent copy.
  const [archive, setArchive] = useState(false)
  const [mergeSubmitting, setMergeSubmitting] = useState(false)
  const [changesSubmitting, setChangesSubmitting] = useState(false)
  const [changesRequested, setChangesRequested] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [approveWarning, setApproveWarning] = useState<string | null>(null)
  const [mergeSuccessNotice, setMergeSuccessNotice] = useState(false)
  const [conflictOverride, setConflictOverride] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [updateSubmitting, setUpdateSubmitting] = useState(false)
  const [updateFailure, setUpdateFailure] = useState<UpdateFailure | null>(null)
  const [updateWarning, setUpdateWarning] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Frischer Server-Stand (nach `router.refresh()`) schlägt IMMER einen
  // stehengebliebenen Client-Override — s. Kopfkommentar.
  useEffect(() => {
    setConflictOverride(false)
  }, [pr.number, pr.mergeable])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (updateDialogOpen && !dialog.open) dialog.showModal()
    else if (!updateDialogOpen && dialog.open) dialog.close()
  }, [updateDialogOpen])

  const mergeable = pr.mergeable !== false && !conflictOverride

  function handleMerge() {
    setActionError(null)
    setApproveWarning(null)
    setMergeSubmitting(true)
    releasePage(pageId, {
      comment: comment.trim() || undefined,
      // `bump`/`note` nur in versionierten Spaces mitschicken — in
      // unversionierten Spaces ignoriert die API sie zwar ohnehin (s.
      // `ReleaseOptions`-Kommentar in client-api.ts), aber ein leerer
      // `versionNote`-Rest aus einem vorherigen Space-Wechsel soll dort erst
      // gar nicht im Request auftauchen.
      ...(versioning ? { bump, note: versionNote.trim() || undefined, archive } : {}),
    })
      .then((result) => {
        setMergeSubmitting(false)
        if (!result.ok) {
          if (result.status === 409 && result.reason === 'conflict') {
            setConflictOverride(true)
            setActionError(t('review.errors.conflictOnMerge'))
            return
          }
          if (result.status === 422 && result.reason === 'no_changes') {
            setActionError(t('review.errors.reviewNoChanges'))
            return
          }
          setActionError(result.error)
          return
        }
        if (result.result.approveWarning) {
          // KEIN Auto-Navigate: die Warnung darf nicht durch eine sofortige
          // Weiterleitung "verschluckt" werden (kein stiller Verlust, Muster
          // `apps/api/README.md#POST /api/pages/:id/release`) — der Merge
          // selbst war erfolgreich, nur die Freigabe davor evtl. nicht.
          setApproveWarning(result.result.approveWarning)
          return
        }
        setMergeSuccessNotice(true)
        // `router.refresh()` NACH dem `push` (Fix, Task 8 — per E2E gefunden):
        // die Space-Layout-Route (`app/wiki/[space]/(shell)/layout.tsx`, trägt den
        // Seitenbaum) ist zwischen `/review` und der Leseansicht derselbe
        // Next-Router-Segment-Baum — ein reiner `push` behält dessen
        // gecachten Stand bei (Next-App-Router-Soft-Navigation), der
        // Seitenbaum zeigte eine GERADE ERST gemergte neue Seite deshalb
        // nicht, solange derselbe Tab ohne harten Reload weiterlief.
        // `refresh()` invalidiert den Router-Cache der aktuellen Route
        // (inkl. Layout) und erzwingt einen frischen Server-Fetch — wie ein
        // Reload, aber ohne den Soft-Navigation-Vorteil zu verlieren.
        router.push(wikiPageHref(space, pageId))
        router.refresh()
      })
      .catch((err: unknown) => {
        setMergeSubmitting(false)
        setActionError(
          err instanceof ClientApiError ? t('review.errors.mergeFailedRetry') : t('review.errors.mergeFailedOffline'),
        )
      })
  }

  function handleRequestChanges() {
    const trimmed = comment.trim()
    if (trimmed.length === 0) {
      setCommentRequiredError(true)
      return
    }
    setCommentRequiredError(false)
    setActionError(null)
    setChangesSubmitting(true)
    requestChanges(pageId, trimmed)
      .then((result) => {
        setChangesSubmitting(false)
        if (!result.ok) {
          setActionError(result.error)
          return
        }
        setChangesRequested(true)
      })
      .catch(() => {
        setChangesSubmitting(false)
        setActionError(t('review.errors.requestChangesFailed'))
      })
  }

  function handleUpdateStrategy(strategy: UpdateDraftStrategy) {
    setUpdateSubmitting(true)
    updateDraft(pageId, strategy)
      .then((result) => {
        setUpdateSubmitting(false)
        setUpdateDialogOpen(false)
        if (!result.ok) {
          setUpdateFailure({ message: result.message, preservedContent: result.preservedContent })
          return
        }
        setUpdateFailure(null)
        setUpdateWarning(result.info.warning ?? null)
        // Neuer PR/Diff auf dem frischen Draft-Stand — die Server Component
        // (`review/page.tsx`) lädt bei `refresh()` neu, `conflictOverride`
        // wird dabei über den Effekt oben zurückgesetzt.
        router.refresh()
      })
      .catch(() => {
        setUpdateSubmitting(false)
        setUpdateDialogOpen(false)
        setUpdateFailure({ message: t('review.errors.updateFailedRetry') })
      })
  }

  return (
    <>
      {!mergeable ? (
        <div className="notice conflict" role="status">
          <span className="ic">{WARN_ICON}</span>
          <span className="txt">
            <b>{t('review.notices.conflictTitle')}</b> {t('review.notices.conflictBody')}
          </span>
          <span className="grow" />
          <button type="button" className="btn danger" onClick={() => setUpdateDialogOpen(true)}>
            {REBASE_ICON}
            {t('review.notices.rebase')}
          </button>
        </div>
      ) : null}

      {updateWarning ? (
        <div className="notice warn" role="status">
          <span className="ic">{WARN_ICON}</span>
          <div className="txt">
            <b>{t('review.notices.updatedTitle')}</b>
            {updateWarning}
          </div>
        </div>
      ) : null}

      {updateFailure ? (
        <div className="notice broken notice-stack" role="alert">
          <div className="notice-row">
            <span className="ic">{WARN_ICON}</span>
            <div className="txt">
              <b>{t('review.notices.updateFailedTitle')}</b>
              {updateFailure.message}
            </div>
          </div>
          {updateFailure.preservedContent !== undefined ? (
            <>
              <p>{t('review.notices.preservedContentHint')}</p>
              <pre className="recovery-pre">{updateFailure.preservedContent}</pre>
            </>
          ) : null}
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setUpdateFailure(null)}>
              {t('review.notices.close')}
            </button>
          </div>
        </div>
      ) : null}

      {approveWarning ? (
        <div className="notice warn" role="status">
          <span className="ic">{WARN_ICON}</span>
          <div className="txt">
            <b>{t('review.notices.mergedApproveFailedTitle')}</b>
            {approveWarning}
          </div>
          <span className="grow" />
          <a href={wikiPageHref(space, pageId)}>{t('review.notices.backToReading')}</a>
        </div>
      ) : null}

      {mergeSuccessNotice ? (
        <div className="notice rel" role="status">
          <span className="ic">{CHECK_ICON}</span>
          <span className="txt">{t('review.notices.mergedSuccess')}</span>
        </div>
      ) : null}

      {actionError ? (
        <div className="notice broken" role="alert">
          <span className="ic">{WARN_ICON}</span>
          <span className="txt">{actionError}</span>
        </div>
      ) : null}

      <div className="actions">
        <h4>{t('review.actions.heading')}</h4>
        <textarea
          className="commentbox input"
          placeholder={t('review.actions.commentPlaceholder')}
          value={comment}
          onChange={(event) => {
            setComment(event.target.value)
            if (commentRequiredError) setCommentRequiredError(false)
          }}
        />
        {commentRequiredError ? (
          <p className="act-hint err">
            {t('review.actions.commentRequiredHint')}
          </p>
        ) : null}
        {/* Sprunggröße + Änderungsnotiz (Task 9) — nur bei aktiver
            Versionierung des Space sichtbar (`versioning`, aus `GET
            /api/pages/:id`, Task 8). `nextVersion` ist dieselbe Funktion, die
            die API beim tatsächlichen Freigeben rechnet (`@f451/markdown`,
            Task 3) — die Vorschau hier kann deshalb NIE von der später
            vergebenen Nummer abweichen, weil keine zweite Implementierung
            existiert, die auseinanderlaufen könnte. */}
        {versioning ? (
          <fieldset className="card version-bump">
            <legend>{t('review.version.legend')}</legend>
            {/* Erstfreigabe (Befund 5, Final-Review): OHNE aktuelle Version
                liefert `nextVersion(undefined, …)` für ALLE drei Sprunggrößen
                dieselbe Nummer (1.0.0, s. `@f451/markdown#nextVersion`) — die
                Auswahl entfällt hier deshalb (keine drei identischen, wie ein
                Fehler wirkenden Radiobuttons), ein klarer Hinweis ersetzt sie.
                `bump` bleibt im State (Default 'minor') und wird beim Freigeben
                trotzdem mitgeschickt — die API rechnet für die erste Freigabe
                ohnehin IMMER 1.0.0, unabhängig vom Wert. */}
            {currentVersion === undefined ? (
              <p className="version-first-release-hint">
                {t('review.version.firstRelease', { version: nextVersion(currentVersion, 'minor') })}
              </p>
            ) : (
              (['patch', 'minor', 'major'] as const).map((option) => (
                <label key={option}>
                  <input
                    type="radio"
                    name="bump"
                    value={option}
                    checked={bump === option}
                    onChange={() => setBump(option)}
                  />
                  <b>{nextVersion(currentVersion, option)}</b>
                  <span>{t(`review.version.${option}`)}</span>
                </label>
              ))
            )}
            <label className="version-note">
              {t('review.version.noteLabel')}
              <input
                type="text"
                className="input"
                value={versionNote}
                onChange={(event) => setVersionNote(event.target.value)}
                placeholder={t('review.version.notePlaceholder')}
              />
            </label>
            <label className="version-archive">
              <input type="checkbox" checked={archive} onChange={(event) => setArchive(event.target.checked)} />
              <span>{t('review.version.archive')}</span>
            </label>
          </fieldset>
        ) : null}
        <div className="act-row btn-row">
          <button
            type="button"
            className="btn primary"
            disabled={mergeSubmitting || changesSubmitting || !mergeable}
            title={!mergeable ? t('review.actions.mergeDisabledTitle') : undefined}
            onClick={handleMerge}
          >
            {MERGE_ICON}
            {t('review.actions.merge')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={mergeSubmitting || changesSubmitting || changesRequested}
            onClick={handleRequestChanges}
          >
            {changesRequested ? CHECK_ICON : REQUEST_CHANGES_ICON}
            {changesRequested ? t('review.actions.requestChangesDone') : t('review.actions.requestChanges')}
          </button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="conflict-dialog update-strategy-dialog"
        aria-label={t('review.updateDialog.ariaLabel')}
      >
        <div className="dialog-head">
          <h2>{t('review.updateDialog.heading')}</h2>
          <p>{t('review.updateDialog.description')}</p>
        </div>
        <div className="strategy-options">
          <div className="strategy-option">
            <h3>{t('review.updateDialog.takeMain.heading')}</h3>
            <p>{t('review.updateDialog.takeMain.body')}</p>
            <button
              type="button"
              className="btn"
              disabled={updateSubmitting}
              onClick={() => handleUpdateStrategy('take-main')}
            >
              {t('review.updateDialog.takeMain.button')}
            </button>
          </div>
          <div className="strategy-option">
            <h3>{t('review.updateDialog.keepMine.heading')}</h3>
            <p>{t('review.updateDialog.keepMine.body')}</p>
            <button
              type="button"
              className="btn primary"
              disabled={updateSubmitting}
              onClick={() => handleUpdateStrategy('keep-mine')}
            >
              {t('review.updateDialog.keepMine.button')}
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
