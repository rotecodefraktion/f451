'use client'

import { Fragment, useRef, useState, type KeyboardEvent } from 'react'
import type { DiffBlock, MarkdownDiff, MdDiffLine } from '@f451/markdown'
import { useT } from '../../lib/i18n/provider.js'
import type { T } from '../../lib/i18n/types.js'
import { dchangeModifierClass, dtagLabel } from '../../lib/review/diff-view-model'

export interface DiffViewProps {
  diff: MarkdownDiff
}

const EYE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const MD_TAB_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M6 15V9l3 3 3-3v6M17 9v6M15 13l2 2 2-2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ADDED_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
)

/** Identisch zu `EDIT_ICON` in `components/page-view.tsx` (kleines, lokal
 *  dupliziertes Icon-Konstrukt — Muster dort, s. dortiger Kommentar zu
 *  `initials`). */
const CHANGED_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" />
    <path d="m13 5 3 3" strokeLinecap="round" />
  </svg>
)

const CHEVRON_ICON = (
  <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
    <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

type ViewMode = 'visual' | 'md'

/** Reihenfolge im Markup = Reihenfolge unter den Pfeiltasten (zugesicherte
 *  Eigenschaft 7: der Tastaturlauf folgt der räumlichen Anordnung). */
const VIEW_MODES: readonly ViewMode[] = ['visual', 'md']

const tabId = (mode: ViewMode) => `diff-tab-${mode}`
const panelId = (mode: ViewMode) => `diff-panel-${mode}`

function renderVisualBlock(block: DiffBlock, t: T) {
  if (block.kind === 'same') {
    // "nackt" (Brief wörtlich) — kein Wrapper, kein Anchor (same-Blöcke sind
    // keine Sprungziele, s. `lib/review/diff-view-model.ts#changedBlocks`).
    // Ein `<div>`-Wrapper ist trotzdem nötig (React erlaubt
    // `dangerouslySetInnerHTML` nur auf einem echten DOM-Knoten, keinem
    // Fragment) — visuell ohne Effekt, das Fragment sitzt block-level im Fluss.
    return <div key={block.anchor} dangerouslySetInnerHTML={{ __html: block.html }} />
  }
  if (block.kind === 'removed') {
    return (
      <details key={block.anchor} id={block.anchor} className="removed">
        <summary>
          {CHEVRON_ICON}
          {t('review.diff.removedSummary')}
        </summary>
        <div className="rbody" dangerouslySetInnerHTML={{ __html: block.html }} />
      </details>
    )
  }
  const modifier = dchangeModifierClass(block.kind)
  const label = dtagLabel(t, block.kind)
  return (
    <div key={block.anchor} id={block.anchor} className={`dchange ${modifier}`}>
      {/* Teilschritt I: die Marke war die Eigenklasse `.dtag` (eine der 17 aus
          Bestandsaufnahme §2.3) und hing als Alias am `.chip`. Jetzt trägt sie
          den Baustein selbst — Zeichen (`aria-hidden`) plus ausgeschriebenes
          Wort (`label`), also Zustand nie über Farbe allein (Spec,
          „Zugesicherte Eigenschaften" Punkt 3). */}
      <span className={block.kind === 'added' ? 'chip released' : 'chip review'}>
        {block.kind === 'added' ? ADDED_ICON : CHANGED_ICON}
        {label}
      </span>
      <div dangerouslySetInnerHTML={{ __html: block.html }} />
    </div>
  )
}

function mdLineClassName(kind: MdDiffLine['kind']): string | null {
  if (kind === 'add') return 'ml-add'
  if (kind === 'rm') return 'ml-rm'
  return null
}

function renderMdLine(line: MdDiffLine, index: number) {
  const className = mdLineClassName(line.kind)
  return (
    <Fragment key={index}>
      {className ? <span className={className}>{line.text}</span> : line.text}
      {'\n'}
    </Fragment>
  )
}

/**
 * Visueller/Markdown-Diff einer Review (Phase 2d Task 7) — Struktur 1:1 aus
 * `docs/design/mockups/review-diff.html` (`.viewbar`/`.difflegend`/`.dchange`/
 * `.removed`/`.mdview`; die Umschaltleiste selbst trägt seit Teilschritt G
 * den Reiter-Baustein `.tabs` statt der früheren `.seg`-Auswahl).
 * Client-Insel NUR wegen der Reiter-Umschaltung (Brief:
 * „die Diff-Darstellung ist statisch, NUR Aktionen/Tabs brauchen Client") —
 * das Diff-HTML selbst ist bereits serverseitig sanitisiert
 * (`@f451/markdown#diffMarkdown`, Doppel-Sanitize-Architektur aus Task 4) und
 * wird genau wie `page-view.tsx#data.html` per `dangerouslySetInnerHTML`
 * gesetzt — kein erneutes Client-Sanitizing.
 *
 * Der Visuell-Tab wiederverwendet `.page-body` (NICHT zusätzlich `.doc` —
 * anders als der WYSIWYG-Editor, dessen `.doc`-Overrides für Tiptaps
 * abweichendes Tabellen-DOM gedacht sind und `.page-body table`s
 * Overflow-Wrapper-Verhalten IN DIESEM Kontext kaputt machen würden, s.
 * Kommentar `globals.css` Editor-Abschnitt) — das Diff-HTML kommt aus
 * derselben Render-Pipeline wie die normale Leseansicht (`renderHtml`), die
 * Typografie passt deshalb unverändert.
 */
export function DiffView({ diff }: DiffViewProps) {
  const [mode, setMode] = useState<ViewMode>('visual')
  const { t } = useT()
  const tabRefs = useRef<Partial<Record<ViewMode, HTMLButtonElement | null>>>({})

  // Pfeiltasten/Pos1/Ende wandern durch die Laschen und schalten dabei sofort
  // um („automatic activation" — vertretbar, weil beide Bereiche schon im
  // Speicher liegen und der Wechsel nichts nachlädt). Der Tabulator selbst
  // springt über die Reiterreihe hinweg: nur die aktive Lasche ist
  // tabbierbar (`tabIndex` unten), so verlangt es das Reiter-Muster.
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = VIEW_MODES.indexOf(mode)
    let next: ViewMode | undefined
    if (event.key === 'ArrowRight') next = VIEW_MODES[(index + 1) % VIEW_MODES.length]
    else if (event.key === 'ArrowLeft') next = VIEW_MODES[(index - 1 + VIEW_MODES.length) % VIEW_MODES.length]
    else if (event.key === 'Home') next = VIEW_MODES[0]
    else if (event.key === 'End') next = VIEW_MODES[VIEW_MODES.length - 1]
    if (!next) return
    event.preventDefault()
    setMode(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <>
      <div className="viewbar">
        {/* Echte Reiter, keine segmentierte Auswahl (Teilschritt G, s.
            Kommentarkopf von `app/styles/45-auswahl.css`): hier wird zwischen
            zwei BEREICHEN umgeschaltet, die beide dieselbe Änderung zeigen —
            visuell und als Markdown. `.flush`, weil `.viewbar` ihre Haarlinie
            schon selbst zieht. */}
        <div
          className="tabs flush"
          role="tablist"
          aria-label={t('review.diff.viewToggleAriaLabel')}
          onKeyDown={onTabKeyDown}
        >
          {VIEW_MODES.map((viewMode) => (
            <button
              key={viewMode}
              type="button"
              role="tab"
              id={tabId(viewMode)}
              ref={(element) => {
                tabRefs.current[viewMode] = element
              }}
              aria-selected={mode === viewMode}
              /* Nur die aktive Lasche verweist auf ihren Bereich: der inaktive
                 wird gar nicht gerendert (s. unten), ein `aria-controls` auf
                 eine nicht vorhandene id wäre ein toter Verweis. */
              aria-controls={mode === viewMode ? panelId(viewMode) : undefined}
              tabIndex={mode === viewMode ? 0 : -1}
              onClick={() => setMode(viewMode)}
            >
              {viewMode === 'visual' ? EYE_ICON : MD_TAB_ICON}
              {viewMode === 'visual' ? t('review.diff.visualTab') : t('review.diff.markdownTab')}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="difflegend">
          {/* `.lg-sign` ist das Zeichen, das `diff.ts` in eine neue bzw.
              geänderte TABELLENZELLE schreibt (`+` / `~`, dort echter Text,
              kein `aria-hidden`). Hier steht es einmal neben seinem
              ausgeschriebenen Wort — `packages/markdown` kennt keine Sprache
              und kann das Wort nicht selbst mitliefern. In der Legende ist es
              dekorativ (`aria-hidden`): das Wort daneben sagt dasselbe. */}
          <span>
            <span className="lg-dot add" />
            {t('review.diff.legend.added')}
            <span className="lg-sign add" aria-hidden="true">+</span>
          </span>
          <span>
            <span className="lg-dot chg" />
            {t('review.diff.legend.changed')}
            <span className="lg-sign chg" aria-hidden="true">~</span>
          </span>
          <span>
            <span className="lg-dot rm" />
            {t('review.diff.legend.removed')}
          </span>
        </span>
      </div>

      {/* `tabIndex={0}` auf dem Bereich: beide Bereiche sind lange, scrollbare
          Flächen ohne eigenes Bedienelement — ohne Tabstopp käme man mit der
          Tastatur nicht hinein. Es wird immer nur der aktive Bereich
          gerendert; der inaktive ist damit gar nicht erst da, statt per
          `display: none` aus dem Zugänglichkeitsbaum zu fallen. */}
      {mode === 'visual' ? (
        <div className="body" role="tabpanel" id={panelId('visual')} aria-labelledby={tabId('visual')} tabIndex={0}>
          <article className="page-body">{diff.blocks.map((block) => renderVisualBlock(block, t))}</article>
        </div>
      ) : (
        <div className="mdview" role="tabpanel" id={panelId('md')} aria-labelledby={tabId('md')} tabIndex={0}>
          <pre>
            <code>{diff.mdLines.map(renderMdLine)}</code>
          </pre>
        </div>
      )}
    </>
  )
}
