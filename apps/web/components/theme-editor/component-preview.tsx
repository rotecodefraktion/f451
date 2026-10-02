'use client'

import type { Mode, ResolvedTheme } from '@f451/design-tokens'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useT } from '../../lib/i18n/provider'
import { currentMode, previewStyle } from '../../lib/theme-preview'

export interface ComponentPreviewProps {
  resolved: ResolvedTheme
}

const CODE_LINES: readonly { text: string; comment?: boolean }[] = [
  { text: '# rebuild and restart', comment: true },
  { text: 'docker compose build web api' },
  { text: 'docker compose up -d web api' },
]

const INFO_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
)

const DOC_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    <path d="M14 3v5h5" />
  </svg>
)

/**
 * The "Bausteinvorschau" of the July spec (chapter "Bedienung", section
 * "Vorschau"): the app's real building blocks, drawn with the draft's values.
 *
 * The draft sits as inline custom properties on the stage element — never on
 * the document — so the editor around it keeps the saved theme. The stage also
 * carries `data-theme`, which makes `tokens.css` recompute the derived colours
 * there from the stage's own base colours. Hover and focus are forced through
 * modifier classes (`is-hover`, `is-focus`, rules in `65-theme-editor.css`)
 * instead of waiting for a pointer; the stage is `inert`, nothing in it reacts.
 */
export function ComponentPreview({ resolved }: ComponentPreviewProps) {
  const { t } = useT()
  const [mode, setMode] = useState<Mode>('light')

  // Start in the mode the document shows; only known after hydration.
  useEffect(() => {
    setMode(
      currentMode(
        document.documentElement.getAttribute('data-theme'),
        window.matchMedia('(prefers-color-scheme: dark)').matches,
      ),
    )
  }, [])

  const style = useMemo(() => previewStyle(resolved, mode) as CSSProperties, [resolved, mode])

  const rest = t('settings.appearance.preview.stateRest')
  const hover = t('settings.appearance.preview.stateHover')
  const focus = t('settings.appearance.preview.stateFocus')
  const disabled = t('settings.appearance.preview.stateDisabled')
  const primary = t('settings.appearance.preview.buttonPrimary')
  const quiet = t('settings.appearance.preview.buttonQuiet')
  const danger = t('settings.appearance.preview.buttonDanger')

  return (
    <section className="te-pv" aria-labelledby="te-pv-title">
      <div className="te-pv-head">
        <h2 className="te-pv-title" id="te-pv-title">
          {t('settings.appearance.preview.heading')}
        </h2>
        <div className="te-pv-modes" role="group" aria-label={t('settings.appearance.preview.modeGroup')}>
          <button
            type="button"
            className={mode === 'light' ? 'btn small primary' : 'btn small'}
            aria-pressed={mode === 'light'}
            onClick={() => setMode('light')}
          >
            {t('settings.appearance.modeLight')}
          </button>
          <button
            type="button"
            className={mode === 'dark' ? 'btn small primary' : 'btn small'}
            aria-pressed={mode === 'dark'}
            onClick={() => setMode('dark')}
          >
            {t('settings.appearance.modeDark')}
          </button>
        </div>
      </div>
      <p className="te-pv-intro">{t('settings.appearance.preview.intro')}</p>

      <div className="te-pv-stage" data-theme={mode} style={style} inert>
        {/* Reading text: hanging number, paragraph in the measure, margin note, table, code. */}
        <div className="page-body">
          <h2>{t('settings.appearance.preview.sampleHeading')}</h2>
          <p>{t('settings.appearance.preview.sampleParagraph')}</p>
          <aside className="te-pv-note">{t('settings.appearance.preview.marginalNote')}</aside>
          <table>
            <thead>
              <tr>
                <th>{t('settings.appearance.preview.tableField')}</th>
                <th>{t('settings.appearance.preview.tableValue')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('settings.appearance.preview.tableRow1Field')}</td>
                <td>{t('settings.appearance.preview.tableRow1Value')}</td>
              </tr>
              <tr>
                <td>{t('settings.appearance.preview.tableRow2Field')}</td>
                <td>{t('settings.appearance.preview.tableRow2Value')}</td>
              </tr>
            </tbody>
          </table>
          <pre>
            <code>
              {CODE_LINES.map((line, i) => (
                <span key={i} className="te-pv-line">
                  <span className="te-pv-ln" aria-hidden="true">
                    {i + 1}
                  </span>
                  {line.comment ? <span className="te-pv-comment">{line.text}</span> : line.text}
                </span>
              ))}
            </code>
          </pre>
        </div>

        <div className="callout info">
          <p className="callout__head">
            {INFO_ICON}
            {t('settings.appearance.preview.noticeTitle')}
          </p>
          <p>{t('settings.appearance.preview.noticeBody')}</p>
        </div>

        <div className="te-pv-cells">
          <span className="chip working">{t('settings.appearance.preview.chipWorking')}</span>
          <span className="chip review">{t('settings.appearance.preview.chipReview')}</span>
          <span className="chip released">{t('settings.appearance.preview.chipReleased')}</span>
          <span className="chip archived">{t('settings.appearance.preview.chipArchived')}</span>
        </div>

        {/* Buttons: one row per variant, four states each. Written out so every
            class name stands literally in `className` (CSS inventory). */}
        <div className="te-pv-cells">
          <Cell caption={rest}>
            <button type="button" className="btn primary">{primary}</button>
          </Cell>
          <Cell caption={hover}>
            <button type="button" className="btn primary is-hover">{primary}</button>
          </Cell>
          <Cell caption={focus}>
            <button type="button" className="btn primary is-focus">{primary}</button>
          </Cell>
          <Cell caption={disabled}>
            <button type="button" className="btn primary" disabled>{primary}</button>
          </Cell>
        </div>
        <div className="te-pv-cells">
          <Cell caption={rest}>
            <button type="button" className="btn quiet">{quiet}</button>
          </Cell>
          <Cell caption={hover}>
            <button type="button" className="btn quiet is-hover">{quiet}</button>
          </Cell>
          <Cell caption={focus}>
            <button type="button" className="btn quiet is-focus">{quiet}</button>
          </Cell>
          <Cell caption={disabled}>
            <button type="button" className="btn quiet" disabled>{quiet}</button>
          </Cell>
        </div>
        <div className="te-pv-cells">
          <Cell caption={rest}>
            <button type="button" className="btn danger">{danger}</button>
          </Cell>
          <Cell caption={hover}>
            <button type="button" className="btn danger is-hover">{danger}</button>
          </Cell>
          <Cell caption={focus}>
            <button type="button" className="btn danger is-focus">{danger}</button>
          </Cell>
          <Cell caption={disabled}>
            <button type="button" className="btn danger" disabled>{danger}</button>
          </Cell>
        </div>

        {/* Tree row: rest, hover (forced), active — the classes of `components/tree.tsx`. */}
        <div className="nav te-pv-tree">
          <div className="node-row">
            <a>
              {DOC_ICON}
              <span className="lbl">{t('settings.appearance.preview.treeRest')}</span>
            </a>
            <span className="te-pv-caption">{rest}</span>
          </div>
          <div className="node-row">
            <a className="is-hover">
              {DOC_ICON}
              <span className="lbl">{t('settings.appearance.preview.treeHover')}</span>
            </a>
            <span className="te-pv-caption">{hover}</span>
          </div>
          <div className="node-row">
            <a className="active">
              {DOC_ICON}
              <span className="lbl">{t('settings.appearance.preview.treeActive')}</span>
            </a>
            <span className="te-pv-caption">{t('settings.appearance.preview.stateActive')}</span>
          </div>
        </div>

        {/* Dialog over its veil, inline — a real <dialog> would leave the column. */}
        <div className="te-pv-veil">
          <div className="te-pv-dialog">
            <div className="dialog-head">
              <h2>{t('settings.appearance.preview.dialogTitle')}</h2>
              <p>{t('settings.appearance.preview.dialogBody')}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn quiet">
                {t('settings.appearance.preview.dialogCancel')}
              </button>
              <button type="button" className="btn danger">
                {t('settings.appearance.preview.dialogConfirm')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** One sample with its state named above it. */
function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="te-pv-cell">
      <span className="te-pv-caption">{caption}</span>
      {children}
    </div>
  )
}
