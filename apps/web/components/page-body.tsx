'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useT } from '../lib/i18n/provider.js'
import { loadMermaid, mermaidTheme, renderAll, type MermaidResult } from '../lib/mermaid'
import { youtubeEmbedSrc } from '../lib/youtube'

export interface PageBodyProps {
  html: string
}

/**
 * Rendert das server-sanitisierte Seiten-HTML und aktiviert YouTube-Embeds
 * erst beim Klick (Spec §6: „Thumbnail zuerst" — kein Drittanbieter-iframe
 * vor der Nutzer-Entscheidung): Event-Delegation auf dem Artikel; ein Klick
 * auf den Thumbnail-Link ersetzt das Embed-Markup durch das
 * youtube-nocookie-iframe. Ohne JS bleibt der Link ein normaler
 * YouTube-Link (Degradation). Die Video-ID aus dem data-Attribut wird vor
 * dem iframe-Bau erneut validiert (youtubeEmbedSrc) — nie ungeprüft
 * interpoliert.
 *
 * Kein Client-Sanitizing des restlichen HTML und keine Script-Ausführung:
 * der String kommt ausschließlich aus der vertrauenswürdigen API (Phase 1b)
 * und wird per `dangerouslySetInnerHTML` gesetzt (React führt dabei keine
 * `<script>` aus).
 */
export function PageBody({ html }: PageBodyProps) {
  const ref = useRef<HTMLElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { t } = useT()
  // Vollbild für Bilder und Diagramme (#67): nur bei Fingerbedienung — am
  // Desktop sind sie in voller Spaltenbreite lesbar, und ein Klick soll dort
  // nichts Neues auslösen.
  const [bild, setBild] = useState<{ src: string; alt: string } | null>(null)
  const [original, setOriginal] = useState(false)
  // Stable per instance; mermaid uses the id as a DOM id and CSS selector,
  // so it is reduced to [a-z0-9-] and starts with a letter.
  const mermaidIdPrefix = `mermaid-${useId().toLowerCase().replace(/[^a-z0-9-]/g, '')}`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (bild && !dialog.open) dialog.showModal()
    if (!bild && dialog.open) dialog.close()
  }, [bild])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    function onClick(ev: MouseEvent) {
      const target = ev.target as Element | null
      if (
        target instanceof HTMLImageElement &&
        !target.closest('a') &&
        window.matchMedia('(pointer: coarse)').matches
      ) {
        ev.preventDefault()
        setOriginal(false)
        setBild({ src: target.currentSrc || target.src, alt: target.alt })
        return
      }
      const link = target?.closest?.('.yt-embed > a.yt-link')
      const wrap = link?.closest('.yt-embed')
      if (!(wrap instanceof HTMLElement)) return
      const src = youtubeEmbedSrc(wrap.dataset.videoId ?? '')
      if (!src) return
      ev.preventDefault()
      const iframe = document.createElement('iframe')
      iframe.src = src
      iframe.title = t('read.youtubeTitle')
      iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
      iframe.className = 'yt-frame'
      wrap.replaceChildren(iframe)
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [t])

  // Mermaid diagrams (#104). mermaid is loaded lazily, only when the page
  // actually contains a ```mermaid block — pages without diagrams pay nothing.
  // `securityLevel: 'strict'` (see lib/mermaid) runs the SVG through mermaid's
  // DOMPurify, so inserting it via innerHTML does not open a script path. On
  // failure the source block stays visible.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const pres = Array.from(root.querySelectorAll<HTMLPreElement>('pre[data-lang="mermaid"]'))
    if (pres.length === 0) return
    const sources = pres.map((pre) => pre.querySelector('code')?.textContent ?? '')
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    let cancelled = false
    // Runs are chained: mermaid is not reentrant, and a theme switch during a
    // running render must not overlap with it.
    let chain: Promise<void> = Promise.resolve()

    async function run() {
      const theme = mermaidTheme(document.documentElement.dataset.theme, media.matches)
      let results: MermaidResult[]
      try {
        const renderer = await loadMermaid(theme)
        if (cancelled) return
        results = await renderAll(sources, renderer, mermaidIdPrefix)
      } catch {
        // Loading the chunk failed: leave the code blocks as they are.
        return
      }
      if (cancelled) return
      results.forEach((result, i) => {
        const pre = pres[i]
        if (!pre) return
        const next = pre.nextElementSibling
        const existing = next instanceof HTMLElement && next.matches('figure.mermaid') ? next : null
        if ('svg' in result) {
          const figure = existing ?? document.createElement('figure')
          if (!existing) {
            figure.className = 'mermaid'
            pre.after(figure)
          }
          figure.innerHTML = result.svg
          pre.hidden = true
        } else {
          pre.hidden = false
          existing?.remove()
        }
      })
    }

    function schedule() {
      chain = chain.then(run).catch(() => {})
    }

    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media.addEventListener('change', schedule)
    return () => {
      cancelled = true
      observer.disconnect()
      media.removeEventListener('change', schedule)
    }
  }, [html, mermaidIdPrefix])

  return (
    <>
      <article ref={ref} className="page-body" dangerouslySetInnerHTML={{ __html: html }} />
      <dialog ref={dialogRef} className="bild-vollbild" aria-label={t('read.lightbox.ariaLabel')} onClose={() => setBild(null)}>
        {bild ? (
          <>
            <div className="bild-vollbild-leiste">
              <button type="button" className="btn" onClick={() => setOriginal((o) => !o)}>
                {original ? t('read.lightbox.fit') : t('read.lightbox.original')}
              </button>
              <span className="grow">{t('read.lightbox.hint')}</span>
              <button type="button" className="btn primary" onClick={() => setBild(null)}>
                {t('read.lightbox.close')}
              </button>
            </div>
            <div className="bild-vollbild-flaeche" data-original={original ? 'ja' : undefined}>
              <img src={bild.src} alt={bild.alt} />
            </div>
          </>
        ) : null}
      </dialog>
    </>
  )
}
