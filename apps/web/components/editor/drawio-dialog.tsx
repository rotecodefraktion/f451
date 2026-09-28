'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadDiagram, saveDiagram } from '../../lib/editor/client-api'
import type { DiagramDialogState } from './wysiwyg-editor'
import { drawioKonfiguration } from '../../lib/editor/drawio-library'
import { createDrawioProtocol, drawioBaseUrl, drawioEmbedUrl } from '../../lib/editor/drawio-protocol'
import { useT } from '../../lib/i18n/provider'

export interface DrawioDialogProps {
  pageId: string
  state: DiagramDialogState
  onSaved: (state: DiagramDialogState) => void
  onClose: () => void
}

/** Eingebetteter draw.io-Editor (self-hosted iframe, Embed-JSON-Protokoll).
 *  Bestandsdiagramm: lädt den Draft-Stand vor dem iframe-Mount; Neuanlage
 *  (state.isNew): startet leer, erster Save legt die Datei per ifAbsent an. */
export function DrawioDialog({ pageId, state, onSaved, onClose }: DrawioDialogProps) {
  const { t, locale } = useT()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [initial, setInitial] = useState<string | null>(state.isNew ? '' : null)
  const [error, setError] = useState<string | null>(null)
  const embedUrl = drawioEmbedUrl(drawioBaseUrl())

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    if (state.isNew) return
    let ignore = false
    loadDiagram(pageId, state.path)
      .then((text) => {
        if (!ignore) setInitial(text)
      })
      .catch(() => {
        if (!ignore) setError(t('editor.drawioDialog.loadFailed'))
      })
    return () => {
      ignore = true
    }
  }, [pageId, state.isNew, state.path])

  const persist = useCallback(
    async (svgText: string, exit: boolean) => {
      const result = await saveDiagram(pageId, {
        path: state.path,
        content: svgText,
        ...(state.isNew ? { ifAbsent: true } : {}),
      }).catch(() => null)
      if (!result) {
        setError(t('editor.drawioDialog.saveFailed'))
        return
      }
      if (!result.ok) {
        setError(t('editor.drawioDialog.nameExists'))
        return
      }
      onSaved(state)
      if (exit) onClose()
    },
    [onClose, onSaved, pageId, state, t],
  )

  useEffect(() => {
    if (initial === null) return
    // `embedUrl` ist entweder ABSOLUT (`NEXT_PUBLIC_DRAWIO_URL` gesetzt) oder
    // RELATIV (`/drawio/…`, Proxy-Default). Gegen `window.location.href`
    // aufgelöst ergibt Ersteres die konfigurierte draw.io-Origin, Letzteres die
    // eigene App-Origin (same-origin-Proxy) — in beiden Fällen exakt die Origin,
    // mit der der iframe seine postMessage-Nachrichten sendet (Origin-Check unten).
    const embedOrigin = new URL(embedUrl, window.location.href).origin
    const protocol = createDrawioProtocol(
      embedOrigin,
      (msg) => iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), embedOrigin),
      {
        getInitialContent: () => initial,
        onSave: (svg, exit) => void persist(svg, exit),
        onExit: onClose,
        getConfig: () => drawioKonfiguration(locale === 'en' ? 'en' : 'de'),
      },
    )
    const onMessage = (ev: MessageEvent) => protocol.handleMessage(ev)
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [embedUrl, initial, onClose, persist, locale])

  return (
    <dialog ref={dialogRef} className="diagram-dialog" onClose={onClose}>
      {error ? (
        <p className="diagram-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      {initial === null && !error ? <p className="diagram-dialog-status">{t('editor.drawioDialog.loading')}</p> : null}
      {initial !== null ? (
        <iframe ref={iframeRef} src={embedUrl} className="diagram-frame" title={t('editor.drawioDialog.iframeTitle')} />
      ) : null}
      <button type="button" className="btn primary diagram-dialog-close" onClick={onClose}>
        {t('editor.drawioDialog.close')}
      </button>
    </dialog>
  )
}
