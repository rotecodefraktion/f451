'use client'

import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n/provider.js'
import { cycleIndex, indexOfSpace, resolveCurrentSpace, type SpaceSwitcherSpace } from '../lib/space-switcher'
import { wikiSpaceHref } from '../lib/urls'

export type { SpaceSwitcherSpace }

export interface SpaceSwitcherProps {
  /** Alle konfigurierten Spaces (aus `GET /api/spaces`), min. 2 Einträge —
   *  bei weniger rendert der Aufrufer (`Shell`) gar keinen Switcher. */
  spaces: SpaceSwitcherSpace[]
  /** Id des aktuell angezeigten Space, sofern die Seite einem festen Space
   *  zugeordnet ist (z. B. `Einstellungen` hat keinen). Ohne Treffer in
   *  `spaces` wird kein Eintrag als aktuell markiert. */
  currentSpaceId?: string
}

/**
 * Space-Wechsler in der Topbar (ersetzt das frühere statische `.app`-Label,
 * s. `Shell`): Button mit aktuellem Space-Namen + Chevron, öffnet ein
 * `role="menu"` mit allen Spaces; ein Klick navigiert per echtem
 * Seitenwechsel zu `/wiki/<space>` (die Zielseite lädt ihren eigenen
 * Seitenbaum/Space-Kontext server-seitig neu — kein Client-Router-Push
 * nötig, dasselbe Muster wie der „Einstellungen"-Link in `AccountMenu`).
 *
 * Markup/Verhalten bewusst identisch zu `components/account-menu.tsx`
 * (`.account`/`.pop`/`.item`-Klassen, Pointerdown-außerhalb + Escape
 * schließen) für ein konsistentes Look-and-feel der beiden Topbar-Popover.
 */
export function SpaceSwitcher({ spaces, currentSpaceId }: SpaceSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([])
  const { t } = useT()

  const current = resolveCurrentSpace(spaces, currentSpaceId)
  const label = current?.name ?? spaces[0]?.name ?? ''

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // Fokus auf den aktuellen (oder ersten) Eintrag, sobald das Menü öffnet —
    // Pfeiltasten navigieren danach zwischen den Einträgen (s. `onMenuKeyDown`).
    const index = Math.max(indexOfSpace(spaces, currentSpaceId), 0)
    itemRefs.current[index]?.focus()
  }, [open, spaces, currentSpaceId])

  function onMenuKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = itemRefs.current.filter((el): el is HTMLAnchorElement => el != null)
    if (items.length === 0) return
    const activeIndex = items.findIndex((el) => el === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex = cycleIndex(activeIndex, delta, items.length)
    items[nextIndex]?.focus()
  }

  if (spaces.length < 2) {
    return <span className="app">{label}</span>
  }

  return (
    <div className="space-switcher" ref={rootRef}>
      <button
        type="button"
        className="app-switch btn quiet"
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* Redesign Phase 2 (Handoff „Space-Switcher"): dunkler „B"-Chip vor
            dem Namen — erster Buchstabe des aktuellen Space, dekorativ (der
            Name selbst trägt die Bedeutung), daher `aria-hidden`. */}
        <span className="sq" aria-hidden="true">
          {label.charAt(0).toUpperCase()}
        </span>
        <span className="app-switch-label">{label}</span>
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          className="menu space-switcher-menu"
          role="menu"
          aria-label={t('shell.spaceSwitcher.menuAriaLabel')}
          onKeyDown={onMenuKeyDown}
        >
          {spaces.map((space, index) => {
            const isCurrent = space.id === currentSpaceId
            return (
              <a
                key={space.id}
                ref={(el) => {
                  itemRefs.current[index] = el
                }}
                className={isCurrent ? 'menu-item current' : 'menu-item'}
                role="menuitem"
                href={wikiSpaceHref(space.id)}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                <b>{space.name}</b>
                {isCurrent ? (
                  <span className="check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </a>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
