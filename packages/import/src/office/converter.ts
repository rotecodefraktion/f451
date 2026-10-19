// The one interface the import (and part E's export) uses to reach LibreOffice:
// either the convert service over HTTP or a local `soffice` (CLI without a URL).

import { tmpdir } from 'node:os'
import { strFromU8, unzipSync } from 'fflate'
import { ConvertError, runSoffice, type ExportTarget } from './soffice.js'

export { ConvertError } from './soffice.js'

export interface HtmlBundle {
  html: string
  /** Keyed by the path `document.html` uses, e.g. `media/img-1.png`. */
  media: Map<string, Uint8Array>
  odf: Uint8Array
  odfExt: 'odt' | 'odp' | 'ods'
  /** Presentations: a rendered SVG per slide, keyed by 0-based slide index
   *  (`slides/slide-<n>.svg`, n 1-based). Best effort — slides may be missing. */
  slides?: Map<number, Uint8Array>
}

export interface Converter {
  toHtml(bytes: Uint8Array, name: string): Promise<HtmlBundle>
  fromBundle(zip: Uint8Array, to: ExportTarget, opts?: { timeoutS?: number }): Promise<Uint8Array>
}

const LOCAL_TIMEOUT_S = 60

/** Reads the `to=html` response ZIP; `status` is used for a malformed ZIP. */
export function bundleFromZip(zip: Uint8Array, status: number): HtmlBundle {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch {
    throw new ConvertError('the converter returned no valid ZIP', status)
  }
  const html = entries['document.html']
  const odfName = Object.keys(entries).find((n) => /^document\.(odt|odp|ods)$/.test(n))
  if (!html || !odfName) throw new ConvertError('the converter returned an incomplete result', status)
  const media = new Map<string, Uint8Array>()
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith('media/') && !name.endsWith('/')) media.set(name, bytes)
  }
  const slides = new Map<number, Uint8Array>()
  for (const [name, bytes] of Object.entries(entries)) {
    const m = /^slides\/slide-([1-9]\d*)\.svg$/.exec(name)
    if (m && bytes.length > 0) slides.set(Number(m[1]) - 1, bytes)
  }
  return {
    html: strFromU8(html),
    media,
    odf: entries[odfName],
    odfExt: odfName.slice('document.'.length) as HtmlBundle['odfExt'],
    slides,
  }
}

export function httpConverter(baseUrl: string, fetchImpl: typeof fetch = fetch): Converter {
  const base = baseUrl.replace(/\/+$/, '')

  async function post(query: URLSearchParams, body: Uint8Array): Promise<Uint8Array> {
    let res: Response
    try {
      res = await fetchImpl(`${base}/convert?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Blob([body as Uint8Array<ArrayBuffer>]),
      })
    } catch (e) {
      throw new ConvertError(`convert service unreachable: ${e instanceof Error ? e.message : String(e)}`, 502)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let reason = text.trim()
      try {
        const j = JSON.parse(text) as { error?: unknown }
        if (typeof j.error === 'string') reason = j.error
      } catch {
        // not JSON — keep the text
      }
      throw new ConvertError(reason || `convert service answered ${res.status}`, res.status)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    async toHtml(bytes, name) {
      const zip = await post(new URLSearchParams({ to: 'html', name }), bytes)
      return bundleFromZip(zip, 502)
    },
    async fromBundle(zip, to, opts) {
      const q = new URLSearchParams({ to })
      if (opts?.timeoutS !== undefined) q.set('timeout', String(opts.timeoutS))
      return post(q, zip)
    },
  }
}

/** Runs `soffice` from the PATH directly — same output as the service. */
export function localConverter(): Converter {
  return {
    async toHtml(bytes, name) {
      const r = await runSoffice({ bytes, name }, 'html', { timeoutS: LOCAL_TIMEOUT_S, workRoot: tmpdir() })
      if (!('zip' in r)) throw new ConvertError('LibreOffice returned no bundle', 422)
      return bundleFromZip(r.zip, 422)
    },
    async fromBundle(zip, to, opts) {
      const r = await runSoffice({ bytes: zip, name: 'bundle.zip' }, to, {
        timeoutS: opts?.timeoutS ?? LOCAL_TIMEOUT_S,
        workRoot: tmpdir(),
      })
      if (!('file' in r)) throw new ConvertError('LibreOffice returned no file', 422)
      return r.file
    },
  }
}
