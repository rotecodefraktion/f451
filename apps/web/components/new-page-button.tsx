'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ClientApiError, createPage, listTemplates, type TemplateSummary } from '../lib/editor/client-api'
import { apiErrorText } from '../lib/i18n/api-error-text.js'
import { useT } from '../lib/i18n/provider.js'
import { decodeRouteParam, wikiPageEditHref, wikiPageHref } from '../lib/urls'

export interface NewPageButtonProps {
  space: string
}

const PLUS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
)

/**
 * Ermittelt die aktuell offene Seite dieses Space (falls vorhanden) als
 * Default-Parent für eine neue Seite — aus dem Browser-Pfad, NICHT aus
 * Server-Props: dieselbe Client-only-Technik wie `active-link.tsx` (der
 * Baum/`.head` sitzt im Space-Layout, das die konkrete Blattroute — und
 * damit die aktuelle Seiten-Id — nicht kennt). `pathname`-Segmente sind noch
 * URL-kodiert (s. `lib/urls.ts`-Modulkommentar) — Segment 1 (Space) wird zum
 * Vergleich dekodiert, Segment 2 (Seite) über `decodeRouteParam` in die rohe
 * Id zurückübersetzt. Greift auch auf `/edit`-/`/review`-Unterseiten (nur
 * Segment 2 wird gelesen), nicht nur auf die reine Leseansicht-Route.
 */
function currentPageIdFromPathname(pathname: string, space: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length < 3 || segments[0] !== 'wiki') return null
  if (decodeURIComponent(segments[1]!) !== space) return null
  return decodeRouteParam(segments[2]!)
}

/**
 * Dezenter Neue-Seite-Einstieg im Seitenbaum-Kopfbereich (`.tree .head`,
 * Phase 2d Task 6) — KEIN Mockup vorhanden, bewusst minimal im bestehenden
 * Klassenvokabular (`.btn.ghost` + natives `<dialog>`, Muster
 * `search-dialog.tsx`). Trigger + Dialog als EINE Client-Insel, da beide
 * denselben `open`-State teilen (dasselbe Argument wie bei `SearchDialog`).
 *
 * Erster-Run-Entscheidung (im Task-Report dokumentiert): `[space]/layout.tsx`
 * fragt Schreibrecht NICHT zusätzlich ab (das würde den Seitenbaum zu einer
 * zweiten Gate-Kette neben `resolveNewPageWriteContext` machen, nur um einen
 * Button ein-/auszublenden). Der Button ist deshalb IMMER sichtbar — ein
 * Leser bekommt beim Absenden die 403-Meldung im Dialog statt eines vorab
 * ausgeblendeten Buttons.
 *
 * Eltern-Seite (Finding 2, Fix-Runde 1 — der Brief verlangt ein SICHTBARES
 * Feld statt eines still abgeleiteten Defaults): die aktuell geöffnete Seite
 * dieses Space ist — falls vorhanden — der Default-Parent, umschaltbar auf
 * „Space-Wurzel". Bewusst KEIN Seitenbaum-Picker (YAGNI, wie der fehlende
 * Reviewer-Picker bei „Review anfordern") — genau diese zwei Optionen decken
 * den Brief („aktuelle Seite als Default-Parent") ab, ein Mockup dafür
 * existiert nicht.
 */
/** Radiowert des Eltern-Feldes — `'current'` ist nur wählbar, solange
 *  {@link currentPageIdFromPathname} eine Seite liefert (s. Render unten). */
type ParentChoice = 'current' | 'root'

/** Radiowert des Vorlagen-Feldes — `'empty'` ist der Default und immer
 *  wählbar; jeder andere Wert ist eine `TemplateSummary.id`. */
type TemplateChoice = 'empty' | string

/** Ladezustand der Vorlagen-Liste (Phase 3c Task 5). `'error'` degradiert
 *  den Dialog bewusst auf die alleinige Option „Leer" statt ihn zu
 *  blockieren — s. {@link listTemplates}-Doc in `client-api.ts`: der Fehler
 *  ist hier kein Vertragsfall, sondern schlicht „keine Vorlagen anzeigen". */
type TemplatesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; templates: TemplateSummary[] }
  | { status: 'error' }

/** `httpStatus` ist der NUMERISCHE HTTP-Status aus `CreatePageResult` — die UI
 *  zeigt daraus nur noch den lokalisierten Text zum Status-Code (`errors.*`
 *  via {@link apiErrorText}), NICHT mehr den rohen deutschen `result.error`
 *  aus der API (Phase 4, „API-Fehler-Mapping"). `networkError` ist der
 *  gefangene {@link ClientApiError}-Fall (Netzwerk/502/…, kein
 *  Vertragsfall) — eigener Zustand statt `error`, weil dafür KEIN
 *  HTTP-Status aus einer Antwort vorliegt. */
type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'collision'; httpStatus: number; existingPageId: string }
  | { status: 'error'; httpStatus: number }
  | { status: 'networkError' }

export function NewPageButton({ space }: NewPageButtonProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  // Default „aktuelle Seite" (Brief), zurückgesetzt bei jedem Schließen —
  // sonst bliebe eine manuelle Umschaltung auf „Space-Wurzel" über den
  // nächsten Dialog-Öffnungsvorgang hinweg hängen.
  const [parentChoice, setParentChoice] = useState<ParentChoice>('current')
  // Default „Leer" (Brief), ebenfalls bei jedem Schließen zurückgesetzt.
  const [templateChoice, setTemplateChoice] = useState<TemplateChoice>('empty')
  const [templatesState, setTemplatesState] = useState<TemplatesState>({ status: 'idle' })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pathname = usePathname()
  const router = useRouter()
  const currentPageId = currentPageIdFromPathname(pathname, space)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Vorlagen erst beim tatsächlichen Öffnen laden (nicht beim Mount — der
  // Button sitzt im Seitenbaum-Kopf und ist praktisch immer im DOM). Ein
  // Fehler bricht den Dialog NICHT: die Liste bleibt leer, das Feld zeigt
  // dann nur „Leer" (s. {@link TemplatesState}). `ignore` schützt vor einer
  // veralteten Antwort, falls der Dialog vor Abschluss des Fetches wieder
  // geschlossen und erneut geöffnet wird.
  useEffect(() => {
    if (!open) return
    let ignore = false
    setTemplatesState({ status: 'loading' })
    listTemplates(space)
      .then((templates) => {
        if (!ignore) setTemplatesState({ status: 'loaded', templates })
      })
      .catch(() => {
        if (!ignore) setTemplatesState({ status: 'error' })
      })
    return () => {
      ignore = true
    }
  }, [open, space])

  // Das 'close'-Event feuert bei JEDEM Schließen (ESC, Backdrop-Klick,
  // erfolgreicher Submit) — hier zentral den restlichen State zurücksetzen
  // (Muster `search-dialog.tsx`).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    function onClose() {
      setOpen(false)
      setTitle('')
      setState({ status: 'idle' })
      setParentChoice('current')
      setTemplateChoice('empty')
      setTemplatesState({ status: 'idle' })
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [])

  function onBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close()
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length === 0) return

    setState({ status: 'submitting' })
    const parentId = parentChoice === 'current' ? (currentPageId ?? undefined) : undefined
    const templateId = templateChoice === 'empty' ? undefined : templateChoice

    try {
      const result = await createPage(space, trimmed, parentId, templateId)
      if (result.ok) {
        dialogRef.current?.close()
        router.push(wikiPageEditHref(space, result.page.id))
        return
      }
      if (result.status === 409) {
        setState({ status: 'collision', httpStatus: result.status, existingPageId: result.pageId })
        return
      }
      setState({ status: 'error', httpStatus: result.status })
    } catch (err) {
      // SessionExpiredError: die Umleitung läuft in client-api.ts bereits —
      // hier bleibt nichts mehr zu tun. Jeder ClientApiError (Netzwerk/502/…)
      // bekommt eine generische Fehlermeldung im Dialog.
      if (err instanceof ClientApiError) {
        setState({ status: 'networkError' })
      }
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn quiet icon newpage-trigger"
        title={t('actions.newPage.triggerLabel')}
        aria-label={t('actions.newPage.triggerLabel')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {PLUS_ICON}
      </button>

      <dialog
        ref={dialogRef}
        className="newpage-dialog"
        aria-label={t('actions.newPage.dialogAriaLabel')}
        onClick={onBackdropClick}
      >
        <div className="dialog-head">
          <h2>{t('actions.newPage.heading')}</h2>
        </div>
        <form onSubmit={onSubmit}>
          <div className="newpage-body">
            <label>
              {t('actions.newPage.titleLabel')}
              {/* Teilschritt I: das Feld trägt den Baustein `.input`
                  (41-eingabe.css). Die lokale Feldkopie in `44-dialog.css`
                  samt der sechsten und letzten wörtlich wiederholten
                  Fokus-Ersatzregel (`outline: none` + Rand + Ring) ist damit
                  entfallen. */}
              <input
                ref={inputRef}
                type="text"
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <fieldset className="newpage-parent">
              <legend>{t('actions.newPage.parentLegend')}</legend>
              {currentPageId ? (
                <>
                  <label className="newpage-parent-option">
                    <input
                      type="radio"
                      name="newpage-parent"
                      checked={parentChoice === 'current'}
                      onChange={() => setParentChoice('current')}
                    />
                    {t('actions.newPage.parentCurrent')}
                  </label>
                  <label className="newpage-parent-option">
                    <input
                      type="radio"
                      name="newpage-parent"
                      checked={parentChoice === 'root'}
                      onChange={() => setParentChoice('root')}
                    />
                    {t('actions.newPage.parentRoot')}
                  </label>
                </>
              ) : (
                <p className="newpage-parent-fixed">{t('actions.newPage.parentFixed')}</p>
              )}
            </fieldset>
            <fieldset className="newpage-template">
              <legend>{t('actions.newPage.templateLegend')}</legend>
              <label className="newpage-template-option">
                <input
                  type="radio"
                  name="newpage-template"
                  checked={templateChoice === 'empty'}
                  onChange={() => setTemplateChoice('empty')}
                />
                {t('actions.newPage.templateEmpty')}
              </label>
              {templatesState.status === 'loading' ? (
                <p className="newpage-parent-fixed">{t('actions.newPage.templatesLoading')}</p>
              ) : templatesState.status === 'loaded' ? (
                templatesState.templates.map((template) => (
                  <label key={template.id} className="newpage-template-option">
                    <input
                      type="radio"
                      name="newpage-template"
                      checked={templateChoice === template.id}
                      onChange={() => setTemplateChoice(template.id)}
                    />
                    <span className="newpage-template-info">
                      <span className="newpage-template-name">
                        <b>{template.name}</b>
                        {template.source === 'global' ? (
                          <span className="tag">{t('actions.newPage.templateGlobalBadge')}</span>
                        ) : null}
                      </span>
                      {template.description ? <small>{template.description}</small> : null}
                    </span>
                  </label>
                ))
              ) : null}
            </fieldset>
            {/* Hinweisblock-Baustein (43-flaeche.css). `.callout` ist bewusst
                KEIN Flex-Kasten: Meldung und Aktion klebten sonst aneinander —
                die Meldung steht deshalb als `<p>`, der Verweis auf die
                bestehende Seite in einer `.btn-row` (dasselbe Muster wie in
                den Werkzeugseiten aus Teilschritt H4). Die drei Inline-Stile
                `padding: 0, textAlign: 'left'` entfallen: sie korrigierten
                nur, dass `.search-dialog-status` als Suchdialog-Statuszeile
                mittig gesetzt und großzügig gepolstert ist. */}
            {state.status === 'collision' ? (
              <div className="callout error" role="alert">
                <p>{apiErrorText(t, state.httpStatus)}</p>
                <div className="btn-row">
                  <a href={wikiPageHref(space, state.existingPageId)}>{t('actions.existingPageLink')}</a>
                </div>
              </div>
            ) : state.status === 'error' ? (
              <div className="callout error" role="alert">
                <p>{apiErrorText(t, state.httpStatus)}</p>
              </div>
            ) : state.status === 'networkError' ? (
              <div className="callout error" role="alert">
                <p>{t('actions.newPage.genericError')}</p>
              </div>
            ) : null}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
              {t('actions.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={state.status === 'submitting'}>
              {t('actions.newPage.submit')}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
