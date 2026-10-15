'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n/provider.js'
import { previewPosition } from '../lib/link-preview'
import { loadMermaid, mermaidTheme, renderAll, type MermaidResult } from '../lib/mermaid'
import { apiPagePreviewPath, parseWikiPageHref } from '../lib/urls'
import { youtubeEmbedSrc } from '../lib/youtube'

interface LinkPreview {
  title: string
  text: string
}

/** Delay before a hovered link shows its preview; focus shows it at once. */
const HOVER_DELAY_MS = 350

/** Loads a link preview; any failure (404, network, bad body) is `null`. */
async function fetchPreview(pageId: string, section: string | null): Promise<LinkPreview | null> {
  try {
    const res = await fetch(apiPagePreviewPath(pageId, section), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { title?: unknown; text?: unknown }
    if (typeof body.title !== 'string') return null
    return { title: body.title, text: typeof body.text === 'string' ? body.text : '' }
  } catch {
    return null
  }
}

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
  // Link hover preview (#100).
  const tooltipId = `link-preview-${useId()}`
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewLinkRef = useRef<HTMLAnchorElement | null>(null)
  const previewCache = useRef(new Map<string, LinkPreview | null>())

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

  // Link hover preview (#100): hovering (after a short delay) or focusing an
  // internal page link shows title and opening text of the target page.
  // Skipped on devices without hover — there a tap navigates. A 404 from the
  // preview route (page missing or not readable) shows nothing; results,
  // failures included, are cached per page and section.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    if (window.matchMedia('(hover: none)').matches) return
    const cache = previewCache.current
    const currentPageId = parseWikiPageHref(window.location.pathname)?.pageId ?? null
    let timer: ReturnType<typeof setTimeout> | undefined

    function previewTarget(node: EventTarget | null) {
      const link = node instanceof Element ? node.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || !root?.contains(link) || link.classList.contains('broken')) {
        return null
      }
      const parsed = parseWikiPageHref(link.getAttribute('href') ?? '')
      if (!parsed || (currentPageId !== null && parsed.pageId === currentPageId)) return null
      return { link, pageId: parsed.pageId, section: parsed.section }
    }

    function hide() {
      clearTimeout(timer)
      timer = undefined
      const link = previewLinkRef.current
      if (!link) return
      if (link.getAttribute('aria-describedby') === tooltipId) link.removeAttribute('aria-describedby')
      previewLinkRef.current = null
      setPreview(null)
    }

    async function load(link: HTMLAnchorElement, pageId: string, section: string | null) {
      const key = `${pageId}#${section ?? ''}`
      let data = cache.get(key)
      if (data === undefined) {
        data = await fetchPreview(pageId, section)
        cache.set(key, data)
      }
      // The pointer or focus moved on while the request was running.
      if (previewLinkRef.current !== link || !data) return
      link.setAttribute('aria-describedby', tooltipId)
      setPreview(data)
    }

    function start(target: { link: HTMLAnchorElement; pageId: string; section: string | null }, delay: number) {
      if (target.link === previewLinkRef.current) return
      hide()
      previewLinkRef.current = target.link
      timer = setTimeout(() => {
        timer = undefined
        void load(target.link, target.pageId, target.section)
      }, delay)
    }

    function onPointerOver(ev: PointerEvent) {
      if (ev.pointerType === 'touch') return
      const target = previewTarget(ev.target)
      if (target) start(target, HOVER_DELAY_MS)
    }
    function onPointerOut(ev: PointerEvent) {
      const link = previewLinkRef.current
      if (!link || !(ev.target instanceof Node) || !link.contains(ev.target)) return
      if (ev.relatedTarget instanceof Node && link.contains(ev.relatedTarget)) return
      hide()
    }
    function onFocusIn(ev: FocusEvent) {
      const target = previewTarget(ev.target)
      if (target) start(target, 0)
    }
    function onFocusOut(ev: FocusEvent) {
      const link = previewLinkRef.current
      if (link && ev.target instanceof Node && link.contains(ev.target)) hide()
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape' && previewLinkRef.current) hide()
    }
    function onScroll() {
      if (previewLinkRef.current) hide()
    }

    root.addEventListener('pointerover', onPointerOver)
    root.addEventListener('pointerout', onPointerOut)
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      root.removeEventListener('pointerover', onPointerOver)
      root.removeEventListener('pointerout', onPointerOut)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
      hide()
    }
  }, [html, tooltipId])

  // Place the preview before it is painted: measure the rendered box, then
  // set top/left imperatively (no inline style in JSX, see css:inventar).
  useLayoutEffect(() => {
    const box = previewRef.current
    const link = previewLinkRef.current
    if (!preview || !box || !link) return
    const pos = previewPosition(
      link.getBoundingClientRect(),
      { width: box.offsetWidth, height: box.offsetHeight },
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    )
    box.style.top = `${pos.top}px`
    box.style.left = `${pos.left}px`
    box.dataset.placement = pos.placement
  }, [preview])

  return (
    <>
      <article ref={ref} className="page-body" dangerouslySetInnerHTML={{ __html: html }} />
      {preview ? (
        <div ref={previewRef} className="link-preview" role="tooltip" id={tooltipId}>
          <strong>{preview.title}</strong>
          {preview.text ? <p>{preview.text}</p> : null}
        </div>
      ) : null}
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
