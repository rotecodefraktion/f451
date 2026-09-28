const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

/** Baut die nocookie-Embed-URL — NUR für validierte 11-Zeichen-IDs, sonst null
 *  (zweite Validierungsstufe: data-Attribute aus dem HTML werden nie ungeprüft
 *  interpoliert — Plan-Entscheidung 2). */
export function youtubeEmbedSrc(videoId: string): string | null {
  if (!VIDEO_ID_RE.test(videoId)) return null
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`
}
