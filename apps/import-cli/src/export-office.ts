import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { UsageError, type ParsedArgs } from './args.js'

/** File name from a `Content-Disposition` header: `filename*` (UTF-8) first,
 *  then `filename`. Directory parts are dropped — the server must not choose
 *  where the file lands. */
export function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null
  let name: string | null = null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim())
    } catch {
      name = null
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header)
    if (plain) name = plain[1]!.replace(/\\(.)/g, '$1').trim()
  }
  if (!name) return null
  const safe = basename(name.replace(/\\/g, '/'))
  return safe && safe !== '.' && safe !== '..' ? safe : null
}

/** Human-readable text for a failed export answer. */
export function exportFailureMessage(status: number, reason: string | null): string {
  const detail = reason ? ` ${reason}` : ''
  if (status === 413) return `The export has too many pages for a direct download.${detail} Use the export in the import/export panel.`
  if (status === 504) return `The export took too long.${detail} Use the export in the import/export panel.`
  if (status === 400) return `The server cannot export Office files (no convert service configured).${detail}`
  if (status === 404) return `Page not found or no access.${detail}`
  if (status === 422) return `Nothing to export in this format.${detail}`
  if (status === 401 || status === 403) return `Not allowed (check F451_TOKEN).${detail}`
  return `Export failed (HTTP ${status}).${detail}`
}

/** `f451-import export office`: downloads the file from the instant export
 *  route `GET /api/pages/:id/export` and writes it to disk. */
export async function runOfficeExport(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WriteStream,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const need = (k: string) => {
    const v = env[k]
    if (!v) throw new UsageError(`${k} is not set`)
    return v
  }
  const base = need('F451_URL').replace(/\/+$/, '')
  const token = need('F451_TOKEN')
  const query = `format=${encodeURIComponent(args.format!)}&subpages=${args.subpages ? '1' : '0'}`
  const url = `${base}/api/pages/${encodeURIComponent(args.page!)}/export?${query}`

  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    let reason: string | null = null
    try {
      const body = (await res.json()) as { reason?: unknown }
      if (typeof body.reason === 'string') reason = body.reason
    } catch {
      // not JSON: the status text says enough
    }
    process.stderr.write(`${exportFailureMessage(res.status, reason)}\n`)
    return 1
  }

  const fileName = fileNameFromDisposition(res.headers.get('content-disposition')) ?? `export.${args.format}`
  const target = args.out ?? join('.', fileName)
  const bytes = new Uint8Array(await res.arrayBuffer())
  await writeFile(target, bytes)
  out.write(`file: ${target} (${bytes.byteLength} bytes)\n`)
  return 0
}
