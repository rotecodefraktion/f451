import { Agent, fetch as undiciFetch } from 'undici'
import type { OfficeExportOptions, OfficeExportReport } from '@f451/import'

/**
 * Pieces of the Office export (spec 2026-10-16-office-export) shared by the
 * instant route and the background job: formats, response headers, the job
 * report and the long-running `fetch` for the convert service.
 */

export type OfficeFormat = OfficeExportOptions['format']

export const OFFICE_FORMATS: readonly OfficeFormat[] = ['docx', 'pptx', 'xlsx', 'pdf']

export const OFFICE_CONTENT_TYPES: Record<OfficeFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

/** `attachment` with an ASCII `filename` (slug of the name) and the exact
 *  name as UTF-8 `filename*` (RFC 6266 / RFC 5987). */
export function contentDisposition(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot).replace(/[^A-Za-z0-9.]/g, '') : ''
  const ascii =
    stem
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'export'
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}${ext}"; filename*=UTF-8''${encoded}`
}

/** Markdown report of a finished export job. */
export function renderOfficeExportReport(fileName: string, report: OfficeExportReport): string {
  const lines = ['# Export report', '', `File: ${fileName}`, '', `Pages: ${report.pages}`]
  if (report.overfullSlides.length > 0) {
    lines.push('', '## Slides that may overflow', '', ...report.overfullSlides.map((t) => `- ${t}`))
  }
  if (report.droppedMedia.length > 0) {
    lines.push('', '## Missing images', '', ...report.droppedMedia.map((m) => `- ${m}`))
  }
  return `${lines.join('\n')}\n`
}

/** Header and body timeout of the job's convert requests: above the job's
 *  per-conversion timeout of 600 s. */
const LONG_TIMEOUT_MS = 660_000

/**
 * A `fetch` for the background export. Node's built-in `fetch` gives up after
 * 300 s without response headers (undici `headersTimeout`), shorter than the
 * job's conversion timeout. undici's own `fetch` is used together with its
 * `Agent`, so the dispatcher always matches the fetch implementation.
 */
export function longTimeoutFetch(): typeof fetch {
  const dispatcher = new Agent({ headersTimeout: LONG_TIMEOUT_MS, bodyTimeout: LONG_TIMEOUT_MS })
  const impl = (input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })
  return impl as unknown as typeof fetch
}
