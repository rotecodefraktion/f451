/**
 * Allow-list of BookStack instances the web import/export may talk to
 * (F451_IMPORT_BOOKSTACK_URLS, comma-separated base URLs). Prevents the API
 * from being used as an SSRF proxy to arbitrary hosts.
 */

/** Normalises one URL; null when it is not a plain http(s) base URL. */
export function normaliseInstance(url: string): string | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || u.search || u.hash) return null
  // `host` is already lower-cased by URL and omits default ports.
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

/** Parses F451_IMPORT_BOOKSTACK_URLS. Throws Error naming the bad entry. */
export function parseInstances(raw: string | undefined): string[] {
  const out: string[] = []
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const normalised = normaliseInstance(trimmed)
    if (normalised === null) {
      // Mask user info so a password in the variable never reaches the startup log.
      const shown = trimmed.replace(/\/\/[^/@]*@/, '//***@')
      throw new Error(`F451_IMPORT_BOOKSTACK_URLS: invalid entry "${shown}"`)
    }
    if (!out.includes(normalised)) out.push(normalised)
  }
  return out
}

/** The allow-listed form of `url`, or null. */
export function findInstance(list: readonly string[], url: string): string | null {
  const normalised = normaliseInstance(url)
  if (normalised === null) return null
  return list.includes(normalised) ? normalised : null
}
