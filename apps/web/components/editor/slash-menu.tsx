'use client'

// Vitest transformiert `.tsx` gegen `tsconfig.json`s `jsx: "preserve"` mit dem
// klassischen JSX-Transform (kein automatischer Runtime-Import) — anders als Next.js'
// eigener SWC-Loader (automatic runtime) braucht `React.createElement` im
// Test-Prozess deshalb ein sichtbares `React` im Scope, s. ui-extensions.test.ts
// (importiert dieses Modul transitiv über ui-extensions.ts).
import React, { type ReactNode } from 'react'
import type { SlashItem } from '../../lib/editor/slash-items'
import type { T } from '../../lib/i18n/types'

export interface SlashMenuProps {
  items: SlashItem[]
  selectedIndex: number
  onSelect: (item: SlashItem) => void
  /** Von `ui-extensions.ts#slashCommandExtension` durchgereicht (NICHT `useT()`
   *  hier — diese Komponente wird über einen eigenen `createRoot()`-Baum
   *  außerhalb von `app/layout.tsx`s `<LocaleProvider>` gemountet, s.
   *  `createReactSuggestionRender` dort; ein `useT()`-Aufruf hier würde ohne
   *  Provider-Vorfahren werfen). */
  t: T
}

const ICONS: Record<string, ReactNode> = {
  heading1: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M4 5v14M14 5v14M4 12h10" strokeLinecap="round" />
    </svg>
  ),
  heading2: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M6 5v14M14 5v14M6 12h8" strokeLinecap="round" />
      <path d="M18 9v10" strokeLinecap="round" />
    </svg>
  ),
  heading3: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M4 5v14M12 5v14M4 12h8" strokeLinecap="round" />
      <path d="M16 8h4M16 12h4M16 16h4" strokeLinecap="round" />
    </svg>
  ),
  bulletList: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
      <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  orderedList: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M10 6h11M10 12h11M10 18h11" strokeLinecap="round" />
      <path
        d="M4.6 5.4h1v4M4.2 9.4h2.8M4.4 13.6h2a1 1 0 0 1 0 2h-.8M4.4 13.6a1 1 0 0 1 1.8-.5M4 20h2.6a1 1 0 0 0 0-2H5a1 1 0 0 1 0-2h1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  taskList: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="4" y="5" width="5" height="5" rx="1" />
      <path d="m5 7.3 1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7h8" strokeLinecap="round" />
      <rect x="4" y="14" width="5" height="5" rx="1" />
      <path d="M12 16h8" strokeLinecap="round" />
    </svg>
  ),
  table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16M15 4v16" strokeLinecap="round" />
    </svg>
  ),
  codeBlock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="m9 8-4 4 4 4M15 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  blockquote: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path
        d="M7 8c-2 1-3 2.6-3 5v3h5v-5H6c.2-1.3 1-2.2 2-2.8L7 8Zm9 0c-2 1-3 2.6-3 5v3h5v-5h-3c.2-1.3 1-2.2 2-2.8L16 8Z"
        strokeLinejoin="round"
      />
    </svg>
  ),
  alertNote: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M12 3 2 20h20L12 3Z" strokeLinejoin="round" />
      <path d="M12 10v4M12 17v.01" strokeLinecap="round" />
    </svg>
  ),
  horizontalRule: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M4 12h16" strokeLinecap="round" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.8" />
      <path d="m4 18 5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  // Superscript "1" above a text baseline — same glyph as the toolbar button.
  footnote: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M3 19h9" strokeLinecap="round" />
      <path d="M16.5 6.5 18.5 4.5v7M16.5 11.5h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
}

function iconFor(id: string): ReactNode {
  // Alle 5 Hinweisbox-Typen teilen sich dasselbe Callout-Glyph (mockup: ein
  // Icon für "Hinweisbox" als Kategorie, nicht pro Typ).
  return ICONS[id] ?? ICONS.alertNote
}

/**
 * `/`-Befehlsmenü-Popup (`.pop.cmdmenu`, Mockup `docs/design/mockups/editor.html`).
 * Rein präsentational: Tastaturnavigation (↑↓/↵/esc) UND Filterung laufen bereits
 * außerhalb (Suggestion-Extension in `ui-extensions.ts` hält `selectedIndex`,
 * `lib/editor/slash-items.ts#filterSlashItems` filtert) — diese Komponente zeigt nur
 * den aktuellen Zustand an und meldet Maus-Auswahl über `onSelect` zurück (Playwright
 * statt Unit-Test, s. Task-Brief: React-Popups sind hier bewusst ungetestet).
 */
export function SlashMenu({ items, selectedIndex, onSelect, t }: SlashMenuProps) {
  return (
    <div className="menu cmdmenu" role="listbox" aria-label={t('editor.slashMenu.ariaLabel')}>
      <div className="ph">{t('editor.slashMenu.heading')}</div>
      {items.length === 0 ? (
        <div className="ph">{t('editor.slashMenu.empty')}</div>
      ) : (
        items.map((item, index) => (
          <div
            key={item.id}
            role="option"
            aria-selected={index === selectedIndex}
            className="menu-item"
            onMouseEnter={(event) => event.currentTarget.scrollIntoView({ block: 'nearest' })}
            onMouseDown={(event) => {
              // `onMouseDown` statt `onClick`: verhindert, dass der Editor durch den
              // Klick zuvor den Selektions-/Fokusverlust auslöst, der die
              // Suggestion (und damit dieses Popup) bereits vor der Auswahl schließt.
              event.preventDefault()
              onSelect(item)
            }}
          >
            <span className="ic">{iconFor(item.id)}</span>
            <span className="tx">
              <b>{item.label}</b>
              {item.hint ? <span>{item.hint}</span> : null}
            </span>
            {item.kbd ? <span className="kbd">{item.kbd}</span> : null}
          </div>
        ))
      )}
      <div className="pf">
        <span>{t('editor.slashMenu.filterHint')}</span>
        <span>
          <span className="kbd">↵</span> {t('editor.slashMenu.insertHint')}
        </span>
      </div>
    </div>
  )
}
