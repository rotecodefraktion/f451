// --- Geteilte YouTube-Erkennung (mdast) --------------------------------------------
//
// Spec §6: „YouTube-URL allein auf einer Zeile" wird zum Thumbnail-Embed. Diese Datei
// enthält NUR die Erkennung (URL -> Video-ID, Paragraph -> Match) — verwendet sowohl
// von render.ts (Lese-HTML, siehe remarkYoutubeEmbeds dort) als auch vom Editor-
// Konverter (@f451/editor from-markdown, Muster matchAlertBlockquote aus alerts.ts).

export interface YoutubeMatch {
  url: string
  videoId: string
}

const WATCH_RE = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})(?:[&#].*)?$/
const SHORT_RE = /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#].*)?$/

/** Extrahiert die 11-Zeichen-Video-ID (watch?v= / youtu.be), sonst null. Die
 *  strikte ID-Form ist Teil der XSS-Verteidigung: nur `[A-Za-z0-9_-]{11}`
 *  gelangt je in ein data-Attribut oder eine Embed-URL. */
export function youtubeVideoId(url: string): string | null {
  const m = WATCH_RE.exec(url) ?? SHORT_RE.exec(url)
  return m?.[1] ?? null
}

/** Spec §6: „YouTube-URL allein auf einer Zeile" = Paragraph mit EXAKT einem
 *  Link-Kind, dessen einziges Text-Kind wortgleich zur URL ist (GFM-Autolink-
 *  Literal). Generisch über die Knotenform, damit die Lese-Pipeline (render.ts)
 *  und der Editor-Konverter (@f451/editor from-markdown) denselben Code nutzen
 *  — Muster matchAlertBlockquote. */
export function matchYoutubeParagraph(paragraph: {
  type?: string
  children?: Array<{ type?: string; url?: string; title?: string | null; children?: Array<{ type?: string; value?: string }> }>
}): YoutubeMatch | null {
  if (paragraph.type !== 'paragraph' || paragraph.children?.length !== 1) return null
  const link = paragraph.children[0]!
  if (link.type !== 'link' || typeof link.url !== 'string') return null
  if (link.children?.length !== 1) return null
  const text = link.children[0]!
  if (text.type !== 'text' || text.value !== link.url) return null
  const videoId = youtubeVideoId(link.url)
  return videoId ? { url: link.url, videoId } : null
}
