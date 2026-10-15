import { inflateSync } from 'fflate'
import { ArchiveRejectedError, DEFAULT_ZIP_LIMITS, comparePaths, type FileSource, type ZipLimits } from './source.js'

// The central directory is parsed here rather than through fflate's `unzipSync` filter:
// the filter does not expose the external attributes needed to recognise symlinks, and
// a per-read `unzipSync` would rescan the whole directory for every file. fflate does
// the inflating.

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_SIZE = 22
const CD_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30
const MAX_COMMENT = 0xffff

const FLAG_ENCRYPTED = 0x1
const FLAG_UTF8 = 0x800
const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000
const DOS_DIRECTORY = 0x10
const STORED = 0
const DEFLATED = 8
const ZIP64_EXTRA = 0x0001
const U32_MAX = 0xffffffff

interface Entry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

/**
 * A ZIP archive as a file source. The central directory is validated on creation —
 * unsafe paths, too many entries or a suspicious unpacked size reject the whole archive
 * with an `ArchiveRejectedError`. Directories, symlinks and macOS `__MACOSX/` metadata are
 * skipped; a single folder wrapping every file is stripped.
 */
export function zipSource(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): FileSource {
  const lim: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const files = stripWrapper(readCentralDirectory(bytes, view, lim))
  const byPath = new Map(files.map((e) => [e.name, e]))
  const paths = [...byPath.keys()].sort(comparePaths)
  return {
    async list() {
      return [...paths]
    },
    async read(path) {
      const entry = byPath.get(path)
      if (!entry) throw new Error(`Not a file in the archive: ${path}`)
      return extract(bytes, view, entry)
    },
  }
}

function readCentralDirectory(bytes: Uint8Array, view: DataView, lim: ZipLimits): Entry[] {
  const eocd = findEocd(bytes, view)
  if (eocd < 0) throw new ArchiveRejectedError('The file is not a ZIP archive.')
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new ArchiveRejectedError('Split ZIP archives are not supported.')
  }
  const total = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (total === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ArchiveRejectedError('ZIP64 archives are not supported.')
  }
  if (total > lim.maxEntries) {
    throw new ArchiveRejectedError(`The archive has ${total} entries; at most ${lim.maxEntries} are allowed.`)
  }
  if (cdOffset + cdSize > eocd) throw corrupt()

  const maxByRatio = lim.maxRatio * bytes.length
  const files: Entry[] = []
  const seen = new Set<string>()
  let unpacked = 0
  let p = cdOffset
  for (let i = 0; i < total; i++) {
    if (p + CD_HEADER_SIZE > eocd || view.getUint32(p, true) !== CD_SIG) throw corrupt()
    const madeBy = view.getUint16(p + 4, true)
    const flags = view.getUint16(p + 8, true)
    const method = view.getUint16(p + 10, true)
    let compressedSize = view.getUint32(p + 20, true)
    let size = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const external = view.getUint32(p + 38, true)
    let localOffset = view.getUint32(p + 42, true)
    const nameStart = p + CD_HEADER_SIZE
    const extraStart = nameStart + nameLen
    const next = extraStart + extraLen + commentLen
    if (next > eocd) throw corrupt()

    const rawName = decodeName(bytes.subarray(nameStart, extraStart), (flags & FLAG_UTF8) !== 0)
    const unsafe = unsafePathReason(rawName)
    if (unsafe) throw new ArchiveRejectedError(`The archive contains an unsafe path ${JSON.stringify(rawName)}: ${unsafe}.`)

    if (size === U32_MAX || compressedSize === U32_MAX || localOffset === U32_MAX) {
      const z = readZip64Extra(view, extraStart, extraLen, size === U32_MAX, compressedSize === U32_MAX, localOffset === U32_MAX)
      if (!z) throw corrupt()
      size = z.size ?? size
      compressedSize = z.compressedSize ?? compressedSize
      localOffset = z.localOffset ?? localOffset
    }

    unpacked += size
    if (unpacked > lim.maxUnpackedBytes) {
      throw new ArchiveRejectedError(`The archive unpacks to more than ${lim.maxUnpackedBytes} bytes.`)
    }
    if (unpacked > maxByRatio) {
      throw new ArchiveRejectedError(`The archive unpacks to more than ${lim.maxRatio} times its own size.`)
    }
    p = next

    // The high 16 bits carry the Unix mode when the archive was made on Unix or macOS.
    const mode = external >>> 16
    const unixLike = (madeBy >> 8) === 3 || (madeBy >> 8) === 19 || mode !== 0
    const isDir = rawName.endsWith('/') || (unixLike && (mode & S_IFMT) === S_IFDIR) || (external & DOS_DIRECTORY) !== 0
    const isLink = unixLike && (mode & S_IFMT) === S_IFLNK
    if (isDir || isLink) continue

    const name = rawName.split('/').filter((s) => s !== '' && s !== '.').join('/')
    if (name === '' || name.split('/')[0] === '__MACOSX') continue
    if (seen.has(name)) throw new ArchiveRejectedError(`The archive contains ${JSON.stringify(name)} more than once.`)
    seen.add(name)

    if (flags & FLAG_ENCRYPTED) throw new ArchiveRejectedError(`The archive entry ${JSON.stringify(name)} is encrypted.`)
    if (method !== STORED && method !== DEFLATED) {
      throw new ArchiveRejectedError(`The archive entry ${JSON.stringify(name)} uses an unsupported compression method (${method}).`)
    }
    if (localOffset + LOCAL_HEADER_SIZE > bytes.length) throw corrupt()
    files.push({ name, method, compressedSize, size, localOffset })
  }
  return files
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  const lowest = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT)
  for (let p = bytes.length - EOCD_SIZE; p >= lowest; p--) {
    if (view.getUint32(p, true) === EOCD_SIG && p + EOCD_SIZE + view.getUint16(p + 20, true) <= bytes.length) return p
  }
  return -1
}

function decodeName(raw: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(raw)
  try {
    // Many tools write UTF-8 without setting the flag.
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return new TextDecoder('latin1').decode(raw)
  }
}

/** Why an entry path could escape the target (zip slip), or null if it is safe. */
function unsafePathReason(name: string): string | null {
  if (name.includes('\\')) return 'backslash'
  if (name.includes('\0')) return 'NUL character'
  if (name.startsWith('/')) return 'absolute path'
  if (/^[A-Za-z]:/.test(name)) return 'drive letter'
  if (name.split('/').includes('..')) return "'..' segment"
  return null
}

function readZip64Extra(
  view: DataView, start: number, length: number,
  wantSize: boolean, wantCompressed: boolean, wantOffset: boolean,
): { size?: number; compressedSize?: number; localOffset?: number } | null {
  const end = start + length
  let p = start
  while (p + 4 <= end) {
    const id = view.getUint16(p, true)
    const len = view.getUint16(p + 2, true)
    const dataEnd = p + 4 + len
    if (dataEnd > end) return null
    if (id === ZIP64_EXTRA) {
      let q = p + 4
      const take = (): number | null => {
        if (q + 8 > dataEnd) return null
        const v = Number(view.getBigUint64(q, true))
        q += 8
        return v
      }
      const out: { size?: number; compressedSize?: number; localOffset?: number } = {}
      if (wantSize) { const v = take(); if (v === null) return null; out.size = v }
      if (wantCompressed) { const v = take(); if (v === null) return null; out.compressedSize = v }
      if (wantOffset) { const v = take(); if (v === null) return null; out.localOffset = v }
      return out
    }
    p = dataEnd
  }
  return null
}

/** Strip a single top-level folder that contains every file ("compress folder"). */
function stripWrapper(files: Entry[]): Entry[] {
  if (files.length === 0) return files
  const top = files[0]!.name.split('/')[0]!
  const prefix = `${top}/`
  if (!files.every((e) => e.name.startsWith(prefix))) return files
  return files.map((e) => ({ ...e, name: e.name.slice(prefix.length) }))
}

function extract(bytes: Uint8Array, view: DataView, e: Entry): Uint8Array {
  const p = e.localOffset
  if (p + LOCAL_HEADER_SIZE > bytes.length || view.getUint32(p, true) !== LOCAL_SIG) throw corrupt(e.name)
  const start = p + LOCAL_HEADER_SIZE + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
  const end = start + e.compressedSize
  if (end > bytes.length) throw corrupt(e.name)
  const data = bytes.subarray(start, end)
  if (e.method === STORED) {
    if (data.length !== e.size) throw corrupt(e.name)
    return data.slice()
  }
  if (e.size === 0) return new Uint8Array(0)
  let out: Uint8Array
  try {
    // A fixed output buffer caps inflation at the declared size, which the limits
    // above have already accepted.
    out = inflateSync(data, { out: new Uint8Array(e.size) })
  } catch {
    throw corrupt(e.name)
  }
  if (out.length !== e.size) throw corrupt(e.name)
  return out
}

function corrupt(name?: string): ArchiveRejectedError {
  return new ArchiveRejectedError(
    name ? `The archive entry ${JSON.stringify(name)} is damaged.` : 'The ZIP archive is damaged.',
  )
}
