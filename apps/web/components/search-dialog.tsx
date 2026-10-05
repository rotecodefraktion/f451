'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '../lib/i18n/provider.js'
import { parseSnippet } from '../lib/snippet'
import { wikiPageHref } from '../lib/urls'

/** Ein Treffer aus `GET /api/search?q=&space=` (siehe apps/api/src/routes/search.ts). */
interface SearchResult {
  id: string
  title: string
  space: string
  /** `ts_headline`-Markup (`<b>…</b>`) — NIE direkt rendern, siehe lib/snippet.ts. */
  snippet: string
  /** Effective class (#39); only in spaces with classes. */
  classification?: string
  rank: number
}

type Status = 'idle' | 'loading' | 'done' | 'error'

const DEBOUNCE_MS = 250

/** Event on `document` that opens the search dialog from anywhere (tool list,
 *  tree head, edge magnifier) — the dialog lives in another subtree. */
export const OPEN_SEARCH_EVENT = 'f451:open-search'

export function openSearch() {
  document.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))
}

export interface SearchTriggerProps {
  /** `bar`: the top bar field; `field`: full-width field in the tree head. */
  variant?: 'bar' | 'field'
  /** Defaults to firing `OPEN_SEARCH_EVENT`. */
  onClick?: () => void
}

/** The search field look-alike that opens the dialog. */
export function SearchTrigger({ variant = 'bar', onClick }: SearchTriggerProps) {
  const { t } = useT()
  return (
    <button
      type="button"
      className={variant === 'field' ? 'search search-field' : 'search'}
      onClick={onClick ?? openSearch}
      aria-haspopup="dialog"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.2-3.2" strokeLinecap="round" />
      </svg>
      <span className="ph">{t('shell.search.placeholder')}</span>
      <span className="short">{t('shell.search.short')}</span>
      <span className="kbd">⌘K</span>
    </button>
  )
}

export interface SearchDialogProps {
  /** `false` renders the dialog only; triggers elsewhere open it through `openSearch()`. */
  trigger?: boolean
}

/**
 * Topbar-Suchfeld + ⌘K-Suchdialog als EINE Client-Insel (Shell bleibt Server
 * Component, siehe app/shell.tsx — Task 1 Review-Prinzip: Client-Inseln so
 * klein wie möglich, aber Trigger + Dialog gehören hier zusammen, weil sie
 * denselben `open`-State teilen).
 *
 * Öffnen: Klick auf den Trigger-Button ODER ⌘K/Ctrl-K (globaler
 * Keydown-Listener, `preventDefault` gegen z. B. Firefox' eingebaute
 * Adressleisten-Suche unter Ctrl-K). Für den Dialog selbst wird bewusst das
 * native `<dialog>`-Element (`showModal()`) verwendet statt eines
 * handgebauten Overlays: der Browser liefert Fokus-Trap, ESC-Schließen
 * (`cancel`-Event → Default schließt) und ein `::backdrop` kostenlos mit —
 * eine eigene Fokus-Trap-Implementierung wäre nur eine Fehlerquelle mehr.
 * Klick auf den Backdrop schließt zusätzlich (siehe `onBackdropClick`).
 *
 * Snippets: die API liefert `ts_headline`-Markup (`<b>…</b>`) als reinen
 * String. Gerendert wird AUSSCHLIESSLICH über `lib/snippet.ts#parseSnippet`
 * + React-Textknoten — KEIN `dangerouslySetInnerHTML`. Andere Tags (z. B.
 * `<script>`) landen dadurch immer als sichtbarer Text, nie als ausgeführtes
 * Markup (siehe dortige Tests).
 */
export function SearchDialog({ trigger = true }: SearchDialogProps = {}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [activeIndex, setActiveIndex] = useState(-1)

  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const { t } = useT()

  // ⌘K / Ctrl+K öffnet den Dialog — global, unabhängig davon, wo der Fokus
  // gerade steht (auch außerhalb der Topbar).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Zweiter Auslöser: die Werkzeugliste der linken Leiste ist kein Link,
  // sondern feuert `f451:open-search` auf `document` — sie liegt in einem
  // anderen Teilbaum und kann diesen Dialog nur so erreichen.
  useEffect(() => {
    function onOpenRequest() {
      setOpen(true)
    }
    document.addEventListener(OPEN_SEARCH_EVENT, onOpenRequest)
    return () => document.removeEventListener(OPEN_SEARCH_EVENT, onOpenRequest)
  }, [])

  // React-`open`-State <-> natives Dialog-Element synchron halten.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // showModal() fokussiert bereits das erste fokussierbare Element,
      // aber erst NACH dem aktuellen Render-Zyklus zuverlässig im Feld
      // landen (z. B. bei erneutem Öffnen mit noch leerem Frame).
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Das 'close'-Event feuert bei JEDEM Schließen (ESC → cancel → Default,
  // Backdrop-Klick → dialog.close(), oder Navigation → setOpen(false) oben) —
  // hier zentral den restlichen State zurücksetzen, statt an jeder
  // Schließ-Stelle einzeln.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    function onClose() {
      setOpen(false)
      setQuery('')
      setResults([])
      setStatus('idle')
      setActiveIndex(-1)
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [])

  // Debounced Suche gegen /api/search — relativer Client-Fetch über die
  // Next-Rewrites (Plan Global Constraints), `credentials: 'same-origin'`
  // reicht den Session-Cookie durch. Ein AbortController pro Tastenanschlag
  // verhindert, dass eine langsame ältere Antwort eine neuere überschreibt.
  // Tipp-Suche mit Präfix-Matching, Phase 3a.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults([])
      setStatus('idle')
      setActiveIndex(-1)
      return
    }
    setStatus('loading')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}&prefix=true`, {
        credentials: 'same-origin',
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`API antwortete mit ${res.status}`)
          return res.json() as Promise<SearchResult[]>
        })
        .then((data) => {
          setResults(data)
          setActiveIndex(data.length > 0 ? 0 : -1)
          setStatus('done')
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setResults([])
          setActiveIndex(-1)
          setStatus('error')
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  function navigateTo(result: SearchResult) {
    setOpen(false)
    router.push(wikiPageHref(result.space, result.id))
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = results[activeIndex]
      if (target) navigateTo(target)
    }
  }

  // Standard-Muster für „Klick außerhalb schließt den Dialog“ bei nativem
  // <dialog>: die Inhalts-Elemente füllen die Dialog-Box vollständig aus
  // (siehe CSS, padding:0), daher trifft `event.target === dialog` nur bei
  // einem Klick auf den Backdrop selbst.
  function onBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close()
    }
  }

  const trimmedQuery = query.trim()

  return (
    <>
      {/* Topbar-Trigger: Phase 1 (`shell.search`-Namespace). Der Dialog-Inhalt
          selbst (Placeholder/Status-Texte weiter unten) ist Phase 4
          (`search`-Namespace, s. `lib/i18n/messages/de/search.ts`). */}
      {trigger ? <SearchTrigger onClick={() => setOpen(true)} /> : null}

      <dialog ref={dialogRef} className="search-dialog" aria-label={t('search.dialogAriaLabel')} onClick={onBackdropClick}>
        <div className="search-dialog-input-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('shell.search.placeholder')}
            aria-label={t('search.inputAriaLabel')}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-dialog-results"
            aria-activedescendant={activeIndex >= 0 ? `search-result-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="kbd">ESC</span>
        </div>

        <div className="search-dialog-body" aria-live="polite">
          {status === 'idle' ? (
            <p className="search-dialog-status">{t('search.idle')}</p>
          ) : status === 'loading' ? (
            <p className="search-dialog-status">{t('search.loading')}</p>
          ) : status === 'error' ? (
            <p className="search-dialog-status error">{t('search.error')}</p>
          ) : results.length === 0 ? (
            <p className="search-dialog-status">{t('search.noResults', { query: trimmedQuery })}</p>
          ) : (
            <ul className="search-results" id="search-dialog-results" role="listbox" aria-label={t('search.resultsAriaLabel')}>
              {results.map((result, index) => (
                <li
                  key={result.id}
                  id={`search-result-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`search-result-item${index === activeIndex ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => navigateTo(result)}
                >
                  <span className="row">
                    <span className="title">{result.title}</span>
                    {result.classification === 'confidential' ? (
                      <span className="chip warn">{t('read.classification.confidential')}</span>
                    ) : null}
                    <span className="tag">{result.space}</span>
                  </span>
                  <span className="snippet">
                    {parseSnippet(result.snippet).map((segment, i) =>
                      segment.highlighted ? (
                        <mark className="hl" key={i}>
                          {segment.text}
                        </mark>
                      ) : (
                        <span key={i}>{segment.text}</span>
                      ),
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </dialog>
    </>
  )
}
