'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { EXPORT_FORMATS, type ExportFormat } from '../lib/import-job'
import { useT } from '../lib/i18n/provider.js'
import { apiPageExportPath, wikiImportHref } from '../lib/urls'

export interface ExportDialogProps {
  space: string
  pageId: string
}

/**
 * "Export as …" of the page view (f451#88): a button that opens a native
 * `<dialog>` (pattern `shortcuts-dialog.tsx`) with the format, the "with
 * subpages" choice and a plain download link to the instant export route —
 * no fetch, the browser downloads the file. Large branches are pointed to the
 * panel export (background job). The page only renders this island when the
 * convert service is configured.
 */
export function ExportDialog({ space, pageId }: ExportDialogProps) {
  const { t } = useT()
  const uid = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ExportFormat>('docx')
  const [subpages, setSubpages] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  // 'close' fires for every way of closing (Esc, backdrop, button).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClose = () => setOpen(false)
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [])

  function onBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) dialogRef.current?.close()
  }

  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        {t('import.exportDialog.menu')}
      </button>
      <dialog
        ref={dialogRef}
        className="newpage-dialog"
        aria-label={t('import.exportDialog.heading')}
        onClick={onBackdropClick}
      >
        <div className="dialog-head">
          <h2>{t('import.exportDialog.heading')}</h2>
        </div>
        <div className="newpage-body">
          <fieldset className="field">
            <legend className="label">{t('import.exportDialog.format')}</legend>
            {EXPORT_FORMATS.map((f) => (
              <label className="check" key={f} htmlFor={`${uid}-${f}`}>
                <input
                  id={`${uid}-${f}`}
                  type="radio"
                  name={`${uid}-format`}
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                />
                <span>{t(`import.exportFormats.${f}`)}</span>
              </label>
            ))}
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={subpages} onChange={(e) => setSubpages(e.target.checked)} />
            <span>{t('import.exportDialog.subpages')}</span>
          </label>
          <p className="hint">
            {t('import.exportDialog.largeHint')} <a href={wikiImportHref(space)}>{t('import.exportDialog.panelLink')}</a>
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
            {t('import.exportDialog.close')}
          </button>
          <a
            className="btn primary"
            href={apiPageExportPath(pageId, format, subpages)}
            download
            onClick={() => dialogRef.current?.close()}
          >
            {t('import.exportDialog.download')}
          </a>
        </div>
      </dialog>
    </>
  )
}
