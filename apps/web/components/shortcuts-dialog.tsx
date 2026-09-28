'use client'

import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n/provider.js'
import { shouldOpenShortcuts } from '../lib/shortcuts'

/**
 * Übersicht der Tastenkürzel als nativer `<dialog>` — gebaut nach dem Muster
 * von `components/search-dialog.tsx`: `showModal()` liefert Fokus-Trap,
 * ESC-Schließen und `::backdrop` vom Browser, ein Klick auf den Backdrop
 * schließt zusätzlich (`onBackdropClick`).
 *
 * Diese Komponente ist NUR der Dialog, ohne Trigger — anders als beim
 * Suchdialog, wo Trigger und Dialog denselben `open`-State teilen. Der
 * Auslöser sitzt in der Werkzeugliste der linken Leiste und ist kein Link;
 * er feuert das CustomEvent `f451:open-shortcuts` auf `document`. Deshalb
 * hängt der Dialog EINMAL in der Schale (`app/shell.tsx`) und muss auf jeder
 * Seite existieren, damit ihn dieses Ereignis erreicht.
 *
 * Zweiter Weg hinein ist die Taste `?`; ob sie greifen darf, entscheidet
 * `lib/shortcuts.ts#shouldOpenShortcuts` (nicht während des Schreibens).
 *
 * Der Inhalt ist bewusst eine feste Liste von sechs Zeilen und keine
 * Registrierung: die Kürzel selbst leben dort, wo sie wirken (`[`/`]`/`\` in
 * `app/pane-edges.tsx`, ⌘K in `components/search-dialog.tsx`) — diese Tabelle
 * ist ihre Beschriftung, nicht ihre Quelle. Ändert sich dort ein Kürzel, muss
 * es hier von Hand nachgezogen werden.
 */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { t } = useT()

  // Beide Wege in den Dialog: das Ereignis aus der Werkzeugliste und die
  // Taste `?` — global, unabhängig davon, wo der Fokus gerade steht.
  useEffect(() => {
    function onOpenRequest() {
      setOpen(true)
    }
    function onKeyDown(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null
      const allowed = shouldOpenShortcuts({
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        altKey: ev.altKey,
        target: target ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null,
      })
      if (!allowed) return
      ev.preventDefault()
      setOpen(true)
    }
    document.addEventListener('f451:open-shortcuts', onOpenRequest)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('f451:open-shortcuts', onOpenRequest)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // React-`open`-State <-> natives Dialog-Element synchron halten.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  // Das 'close'-Event feuert bei JEDEM Schließen (ESC → cancel → Default,
  // Backdrop-Klick → dialog.close()) — hier zentral den State nachziehen,
  // damit ein erneutes `?` den Dialog wieder öffnet.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    function onClose() {
      setOpen(false)
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [])

  // Wie im Suchdialog: die Inhalts-Elemente füllen die Dialog-Box vollständig
  // aus (CSS, padding:0), daher trifft `event.target === dialog` nur bei einem
  // Klick auf den Backdrop selbst.
  function onBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close()
    }
  }

  const groups = [
    {
      title: t('shortcuts.groups.view'),
      rows: [
        { keys: '[', text: t('shortcuts.view.nav') },
        { keys: ']', text: t('shortcuts.view.rail') },
        { keys: '\\', text: t('shortcuts.view.full') },
      ],
    },
    {
      title: t('shortcuts.groups.search'),
      rows: [{ keys: t('shortcuts.search.keys'), text: t('shortcuts.search.open') }],
    },
    {
      title: t('shortcuts.groups.help'),
      rows: [
        { keys: '?', text: t('shortcuts.help.overview') },
        { keys: 'Esc', text: t('shortcuts.help.close') },
      ],
    },
  ]

  return (
    <dialog
      ref={dialogRef}
      className="shortcuts-dialog"
      aria-label={t('shortcuts.dialogAriaLabel')}
      onClick={onBackdropClick}
    >
      <div className="dialog-head">
        <h2>{t('shortcuts.title')}</h2>
      </div>

      <div className="shortcuts-body">
        {groups.map((group) => (
          <section className="shortcuts-group" key={group.title}>
            <h3>{group.title}</h3>
            {/* Beschreibungsliste statt Tabelle: Taste (dt) und was sie tut
                (dd) sind ein Begriffspaar, keine zwei gleichrangigen Spalten. */}
            <dl className="shortcuts-list">
              {group.rows.map((row) => (
                <div className="shortcuts-row" key={row.keys}>
                  <dt>
                    <span className="kbd">{row.keys}</span>
                  </dt>
                  <dd>{row.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      {/* Sichtbarer Weg hinaus, zusätzlich zu Esc und Backdrop-Klick. Fußzeile
          mit `.btn` statt Kreuz in der Kopfzeile, weil ALLE anderen Dialoge des
          Repos ihre Aktionen so führen (`.dialog-actions`, s. `44-dialog.css`)
          und keiner ein Kopfzeilen-Kreuz kennt. Beschriftung ist derselbe Text
          wie die Kürzel-Zeile `Esc — Schließen` — ein eigener Schlüssel wäre
          eine zweite Quelle für dasselbe Wort. */}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
          {t('shortcuts.help.close')}
        </button>
      </div>
    </dialog>
  )
}
