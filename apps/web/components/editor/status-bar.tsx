'use client'

import { useEffect, useRef, useState } from 'react'
import type { AutosaveStatus } from '../../lib/editor/autosave'
import { wikiSpaceHref } from '../../lib/urls'
import { useT } from '../../lib/i18n/provider'
import type { T } from '../../lib/i18n/types'

export interface StatusBarProps {
  space: string
  title: string
  /** Ziel von „Zur Leseansicht" UND dem Titel-Breadcrumb — die Leseansicht
   *  GENAU dieser Seite (`wikiPageHref(space, pageId)`), nicht die Space-Startseite. */
  backHref: string
  saveStatus: AutosaveStatus
  /** ISO-Zeitstempel des letzten erfolgreichen Saves, oder `null` vor dem ersten Save. */
  savedAt: string | null
  /** „Entwurf verwerfen" — Aufrufer zeigt den bestätigenden confirm-Dialog NICHT
   *  selbst; diese Komponente fragt bereits nach, bevor sie ruft (kein stilles
   *  Verwerfen bei einem Fehlklick). */
  onDiscard: () => void
  /** „Zur Leseansicht" — Aufrufer ist verantwortlich für `flushNow` + Navigation. */
  onBackToReading: () => void
  /** „Speichern"-Button (sichtbarer Sofort-Save neben ⌘S) — Aufrufer nutzt
   *  DENSELBEN Sofort-Save-Pfad wie der bestehende ⌘S-Handler
   *  (`editor-root.tsx#handleImmediateSave`, inkl. dessen Konflikt-Guard;
   *  diese Komponente ruft nur auf, das Blocken bei offenem Konflikt läuft
   *  dort). */
  onSave: () => void
  /** „Review anfordern" (Phase 2d Task 6) — Aufrufer ist verantwortlich für
   *  `flushNow` (Muster Moduswechsel), den `requestReview`-Aufruf und die
   *  Navigation zur Review-Route bei Erfolg. */
  onRequestReview: () => void
  /** Deaktiviert den „Review anfordern"-Button — bei offenem Konflikt-Dialog
   *  ODER während eine Anfrage bereits läuft (kein Doppel-Request). */
  requestReviewDisabled?: boolean
  /** „Auf letzte Freigabe zurücksetzen" (Phase 2d Task 6, Undo-Semantik) —
   *  diese Komponente fragt bereits nach (Muster `onDiscard`), bevor sie
   *  ruft; der Aufrufer führt `updateDraft({strategy:'take-main'})` aus und
   *  remountet den Editor mit dem frischen Draft-Stand. */
  onResetToLastRelease: () => void
  /** „Als Vorlage speichern …" (Phase 3c Task 6) — öffnet den
   *  `SaveTemplateDialog` in der aufrufenden Session-Komponente; diese
   *  Komponente fragt hierfür bewusst NICHT nach (anders als `onDiscard`/
   *  `onResetToLastRelease` — kein destruktiver Vorgang, der Dialog selbst
   *  ist die einzige weitere Bestätigungsstufe). */
  onSaveAsTemplate: () => void
  /** „Als Markdown exportieren" — löst den Download des rohen Markdowns aus
   *  (`GET /api/pages/:id/raw?download=1`). Kein destruktiver Vorgang, diese
   *  Komponente fragt daher NICHT nach (Muster `onSaveAsTemplate`). */
  onExportMarkdown: () => void
  /** „Seite löschen" — diese Komponente zeigt bereits den bestätigenden
   *  confirm-Dialog (Muster `onDiscard`), bevor sie ruft: kein stilles
   *  Löschen bei einem Fehlklick. Der Aufrufer (`editor-root.tsx`) ruft
   *  `deletePage` und navigiert bei Erfolg zur Space-Startseite. */
  onDeletePage: () => void
}

const EDIT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" />
    <path d="m13 5 3 3" strokeLinecap="round" />
  </svg>
)

const CHEVRON_ICON = (
  <svg className="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const BACK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M3 8a9 9 0 1 1 1 5" strokeLinecap="round" />
    <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const TRASH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const WARN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 3 2 20h20L12 3Z" strokeLinejoin="round" />
    <path d="M12 10v4M12 17v.01" strokeLinecap="round" />
  </svg>
)

/** „Speichern" — Diskette, kein Mockup-Vorbild (der sichtbare Sofort-Save-
 *  Button ist ein Post-1-Zusatz, s. Docblock-Historie oben); gleiche Form wie
 *  {@link TEMPLATE_ICON} (beide sind Disketten-Glyphen), bewusst als eigene
 *  Konstante gehalten statt geteilt, damit ein künftiger Icon-Wechsel für nur
 *  einen der beiden Buttons nicht versehentlich den anderen mitändert. */
const SAVE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M5 4h11l3 3v13H5V4Z" strokeLinejoin="round" />
    <path d="M8 4v5h8V4" strokeLinejoin="round" />
    <path d="M8 13h8v7H8v-7Z" strokeLinejoin="round" />
  </svg>
)

/** „Review anfordern" — identisch zu `docs/design/mockups/editor.html` (Zeile ~468). */
const REVIEW_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 3v12" strokeLinecap="round" />
    <path d="m8 11 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 19h14" strokeLinecap="round" />
  </svg>
)

/** „Auf letzte Freigabe zurücksetzen" — identisch zu
 *  `docs/design/mockups/editor.html` (Zeile ~476, dortselbst dieselbe
 *  Glyphe wie {@link BACK_ICON} — im Mockup gibt es kein separates
 *  „Zur Leseansicht"-Menüeintrag, der hier ergänzte 2c-Eintrag verwendet
 *  dieselbe Form bereits für einen anderen Zweck). */
const RESET_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M3 8a9 9 0 1 1 1 5" strokeLinecap="round" />
    <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** „Als Vorlage speichern …" (Phase 3c Task 6) — Diskette, kein Mockup-Vorbild
 *  (die Vorlagen-Funktion ist Phase-3c-Neuzugang, s. `save-template-dialog.tsx`). */
const TEMPLATE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M5 4h11l3 3v13H5V4Z" strokeLinejoin="round" />
    <path d="M8 4v5h8V4" strokeLinejoin="round" />
    <path d="M8 13h8v7H8v-7Z" strokeLinejoin="round" />
  </svg>
)

/** „Als Markdown exportieren" — Download-Pfeil, kein Mockup-Vorbild (Post-1-Zusatz
 *  wie {@link TEMPLATE_ICON}/{@link RESET_ICON}). */
const EXPORT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 4v11" strokeLinecap="round" />
    <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 20h14" strokeLinecap="round" />
  </svg>
)

/** „vor Xs"/„vor X Min" — reine Anzeige-Rundung, kein Ersatz für `page-view.ts#formatUpdatedAt`
 *  (das ist ein Datum, hier ist es eine Live-Distanz zu jetzt in Sekunden/Minuten). */
function relativeLabel(savedAtIso: string, now: number, t: T): string {
  const savedMs = new Date(savedAtIso).getTime()
  if (Number.isNaN(savedMs)) return savedAtIso
  const diffSec = Math.max(0, Math.round((now - savedMs) / 1000))
  if (diffSec < 60) return t('editor.statusBar.savedSecondsAgo', { count: diffSec })
  const diffMin = Math.round(diffSec / 60)
  return t('editor.statusBar.savedMinutesAgo', { count: diffMin })
}

/**
 * Statuszeile des Editors (`.statusbar`, Mockup `docs/design/mockups/editor.html`).
 * Seit Phase 2d Task 6 MIT „Review anfordern" (zwischen `.saved` und `.discard`,
 * Mockup-Position) und dem „Auf letzte Freigabe zurücksetzen"-Menüeintrag —
 * beide waren in 2c bewusst weggelassen (Docblock-Historie). Das
 * „Versionsverlauf öffnen"-Menüeintrag aus dem Mockup bleibt weiterhin WEG
 * (Nicht-Ziel, Task-6-Brief). Das „Verwerfen"-Dropdown folgt dem
 * Outside-Click/Escape-Muster aus `account-menu.tsx`.
 *
 * Post-1-Zusatz: sichtbarer „Speichern"-Button zwischen `.saved` und „Review
 * anfordern" — der 30s-Autosave-Debounce (`AUTOSAVE_DEBOUNCE_MS`,
 * `editor-root.tsx`) war ohne ihn nur über das unsichtbare ⌘S sofort
 * auslösbar. Ruft denselben Sofort-Save-Pfad wie ⌘S auf (kein eigener,
 * zweiter Save-Mechanismus), s. `onSave`-Docblock oben.
 */
export function StatusBar({
  space,
  title,
  backHref,
  saveStatus,
  savedAt,
  onDiscard,
  onBackToReading,
  onSave,
  onRequestReview,
  requestReviewDisabled,
  onResetToLastRelease,
  onSaveAsTemplate,
  onExportMarkdown,
  onDeletePage,
}: StatusBarProps) {
  const { t } = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [, setTick] = useState(0)
  const rootRef = useRef<HTMLSpanElement>(null)

  // Die relative Zeitangabe („vor Xs") muss auch ohne neue Save-Events weiterlaufen.
  useEffect(() => {
    if (!savedAt) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [savedAt])

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  function handleDiscardClick() {
    setMenuOpen(false)
    if (window.confirm(t('editor.confirm.discardDraft'))) {
      onDiscard()
    }
  }

  function handleBackClick() {
    setMenuOpen(false)
    onBackToReading()
  }

  function handleSaveAsTemplateClick() {
    setMenuOpen(false)
    onSaveAsTemplate()
  }

  function handleExportMarkdownClick() {
    setMenuOpen(false)
    onExportMarkdown()
  }

  function handleDeletePageClick() {
    setMenuOpen(false)
    if (window.confirm(t('editor.confirm.deletePage'))) {
      onDeletePage()
    }
  }

  function handleResetClick() {
    setMenuOpen(false)
    if (window.confirm(t('editor.confirm.resetToLastRelease'))) {
      onResetToLastRelease()
    }
  }

  // Phase 4b Task 2 (Spec §9): Wortlaut für den selbstheilenden `offline`-
  // Zustand ist VERBINDLICH exakt („—" ist der Gedankenstrich U+2014, kein
  // Bindestrich) — der Autosave puffert lokal weiter und schiebt automatisch
  // nach, sobald der Server wieder erreichbar ist (kein Nutzer-Handeln nötig,
  // anders als beim `error`-Endzustand unten).
  const savedLabel =
    saveStatus === 'saving'
      ? t('editor.statusBar.saving')
      : saveStatus === 'offline'
        ? t('editor.statusBar.offline')
        : saveStatus === 'error'
          ? t('editor.statusBar.error')
          : savedAt
            ? t('editor.statusBar.savedAt', { relative: relativeLabel(savedAt, Date.now(), t) })
            : t('editor.statusBar.notSavedYet')
  const isWarn = saveStatus === 'error' || saveStatus === 'offline'
  // Deaktiviert, während bereits gespeichert wird (kein Doppel-Save) ODER
  // nichts zu speichern ansteht (`idle` — pristine bzw. gerade erst
  // erfolgreich gespeichert). `error`/`offline`/`dirty` bleiben aktiv (dort
  // gibt es entweder einen Fehlversuch zum erneuten Anstoßen oder eine
  // ungesicherte Änderung); `conflict` bleibt ebenfalls aktiv — der Klick
  // läuft über denselben Pfad wie ⌘S, dessen Guard ihn dort bereits
  // wirkungslos macht (s. `onSave`-Docblock oben), kein Crash, kein
  // Doppel-Save.
  const saveDisabled = saveStatus === 'saving' || saveStatus === 'idle'

  return (
    <div className="statusbar">
      <nav className="crumbs" aria-label={t('editor.statusBar.breadcrumbAriaLabel')}>
        <a href={wikiSpaceHref(space)}>{space}</a>
        <span className="sep">/</span>
        <a href={backHref} title={t('editor.statusBar.backToReadingTitle')}>
          {title}
        </a>
      </nav>
      <span className="grow" />
      {/* Statusmarke des Bausteinsystems (`styles/42-marke.css`) statt der
          früheren Eigenklasse `.dbadge`. Zeichen (Symbol) und Wort stehen
          beide im Markup — Farbe allein trägt die Bedeutung nicht. */}
      <span className="chip working">
        {EDIT_ICON}
        {t('editor.statusBar.draftBadge')}
      </span>
      <span className={saveStatus === 'error' ? 'saved error' : saveStatus === 'offline' ? 'saved offline' : 'saved'}>
        {isWarn ? WARN_ICON : <span className="sdot" />}
        {savedLabel}
      </span>
      {/* Sekundäre Aktion (Muster „Verwerfen" unten, die Grundform `.btn`): „Review
          anfordern" bleibt die einzige `.btn.primary` der Statuszeile —
          „Speichern" ist ein Post-1-Komfort-Zusatz neben dem ohnehin
          laufenden Autosave/⌘S, kein gleichrangiger Haupt-CTA. */}
      <button
        type="button"
        className="btn"
        disabled={saveDisabled}
        onClick={onSave}
        title={t('editor.statusBar.saveTitle')}
      >
        {SAVE_ICON}
        {t('editor.statusBar.save')}
      </button>
      <button type="button" className="btn primary" disabled={requestReviewDisabled} onClick={onRequestReview}>
        {REVIEW_ICON}
        {t('editor.statusBar.requestReview')}
      </button>
      <span className="discard" ref={rootRef}>
        <button
          type="button"
          className="btn"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {t('editor.statusBar.discard')}
          {CHEVRON_ICON}
        </button>
        {menuOpen ? (
          <div className="dmenu" role="menu">
            <a
              href="#"
              className="menu-item"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault()
                handleResetClick()
              }}
            >
              {RESET_ICON}
              {t('editor.statusBar.resetToLastRelease')}
            </a>
            <a
              href={backHref}
              className="menu-item"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault()
                handleBackClick()
              }}
            >
              {BACK_ICON}
              {t('editor.statusBar.backToReading')}
            </a>
            <a
              href="#"
              className="menu-item"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault()
                handleSaveAsTemplateClick()
              }}
            >
              {TEMPLATE_ICON}
              {t('editor.statusBar.saveAsTemplate')}
            </a>
            <a
              href="#"
              className="menu-item"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault()
                handleExportMarkdownClick()
              }}
            >
              {EXPORT_ICON}
              {t('editor.statusBar.exportMarkdown')}
            </a>
            <div className="menu-sep" />
            <a
              href="#"
              className="menu-item danger"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault()
                handleDiscardClick()
              }}
            >
              {TRASH_ICON}
              {t('editor.statusBar.discardDraft')}
            </a>
            <a
              href="#"
              className="menu-item danger"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault()
                handleDeletePageClick()
              }}
            >
              {TRASH_ICON}
              {t('editor.statusBar.deletePage')}
            </a>
          </div>
        ) : null}
      </span>
    </div>
  )
}
