/** The base URL in front of a book, chapter or page URL BookStack reported
 *  (`<base>/books/<book>[/page|chapter/<slug>]`). BookStack builds these from
 *  its own APP_URL, which can differ from the address f451 uses to reach it.
 *  Undefined for anything else. */
export function publicBaseOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  } catch {
    return undefined
  }
  const match = /^(.*?)\/books\/[^/?#]+(?:\/(?:page|chapter)\/[^/?#]+)?\/?(?:[?#].*)?$/.exec(url)
  const base = match?.[1]?.replace(/\/+$/, '')
  return base ? base : undefined
}
