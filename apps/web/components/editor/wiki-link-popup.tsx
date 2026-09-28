'use client'

// s. slash-menu.tsx: `React` explizit importiert wegen des klassischen JSX-Transforms
// unter Vitest (tsconfig `jsx: "preserve"`), das dieses Modul-Level-`<svg>` sonst als
// `React.createElement`-Aufruf ohne sichtbares `React` im Scope emittiert.
import React from 'react'
import type { WikiSuggestion } from '../../lib/editor/wiki-suggest'
import type { T } from '../../lib/i18n/types'

export interface WikiLinkPopupProps {
  query: string
  suggestions: WikiSuggestion[]
  selectedIndex: number
  loading: boolean
  onSelect: (suggestion: WikiSuggestion) => void
  /** Von `ui-extensions.ts#wikiLinkAutocompleteExtension` durchgereicht (NICHT
   *  `useT()` hier — s. `slash-menu.tsx#SlashMenuProps.t`-Kommentar: derselbe
   *  eigene `createRoot()`-Baum außerhalb von `<LocaleProvider>`). */
  t: T
}

const PAGE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M14 3H6v18h12V8z" strokeLinejoin="round" />
    <path d="M14 3v5h5" strokeLinecap="round" />
  </svg>
)

/** Verzeichnisanteil von `path` (ohne `index.md`) als Breadcrumb-Segmente für die
 *  Anzeige — dieselbe Ableitung wie `deriveWikiLinkTarget`s `dir`, hier nur für die
 *  Darstellung (nicht für das einzufügende `target`-Attribut, s. dort). */
function pathSegments(path: string): string[] {
  const dir = path.replace(/(^|\/)index\.md$/, '')
  return dir.length === 0 ? [] : dir.split('/')
}

/**
 * `[[`-Autocomplete-Popup (`.pop.linkpop`, Mockup `docs/design/mockups/editor.html`).
 * Rein präsentational (Tastaturnavigation + Suche laufen in der Suggestion-Extension/
 * `lib/editor/wiki-suggest.ts`, s. `slash-menu.tsx`-Kopfkommentar für dasselbe Muster).
 * `.mk`-Badge „Entwurf" markiert Treffer, die nur im Draft-Index gefunden wurden
 * (`isDraft`, s. `suggestWikiTargets`-Merge).
 */
export function WikiLinkPopup({ query, suggestions, selectedIndex, loading, onSelect, t }: WikiLinkPopupProps) {
  return (
    <div className="menu linkpop" role="listbox" aria-label={t('editor.wikiLinkPopup.ariaLabel')}>
      <div className="ph">
        {t('editor.wikiLinkPopup.headingPrefix')} <span className="q">[[{query}</span>
      </div>
      {loading ? (
        <div className="ph">{t('editor.wikiLinkPopup.searching')}</div>
      ) : suggestions.length === 0 ? (
        <div className="ph">{t('editor.wikiLinkPopup.empty')}</div>
      ) : (
        suggestions.map((suggestion, index) => (
          <div
            key={suggestion.id}
            role="option"
            aria-selected={index === selectedIndex}
            className="menu-item"
            onMouseEnter={(event) => event.currentTarget.scrollIntoView({ block: 'nearest' })}
            onMouseDown={(event) => {
              // s. slash-menu.tsx: `onMouseDown` statt `onClick`, sonst schließt der
              // Fokusverlust die Suggestion bereits vor der Auswahl.
              event.preventDefault()
              onSelect(suggestion)
            }}
          >
            <span className="lic">{PAGE_ICON}</span>
            <span className="lt">
              <b>{suggestion.title}</b>
              {pathSegments(suggestion.path).length > 0 ? (
                <span className="path">
                  {pathSegments(suggestion.path).map((segment, i) => (
                    <span key={i}>
                      {i > 0 ? <span className="s">/</span> : null}
                      {segment}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            {suggestion.isDraft ? <span className="chip working">{t('editor.wikiLinkPopup.draftBadge')}</span> : null}
          </div>
        ))
      )}
      <div className="pf">
        <span>
          <span className="kbd">↑↓</span> {t('editor.wikiLinkPopup.navigate')}
        </span>
        <span>
          <span className="kbd">↵</span> {t('editor.wikiLinkPopup.insert')}
        </span>
        <span>
          <span className="kbd">esc</span> {t('editor.wikiLinkPopup.cancel')}
        </span>
      </div>
    </div>
  )
}
