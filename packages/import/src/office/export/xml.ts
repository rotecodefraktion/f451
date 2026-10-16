// XML building for the generated Flat ODP / Flat ODS. Every text node and every
// attribute value goes through `escapeXml`; `tag` is the only way markup is made.

// Characters XML 1.0 does not allow at all (control characters, lone surrogates).
const INVALID_XML = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu

export function escapeXml(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export type Attrs = Record<string, string | number | boolean | undefined | null>

/** `<name attrs>children</name>`, or self-closing without children. Attribute
 *  values are escaped; `children` must already be XML (made by `tag`/`escapeXml`). */
export function tag(name: string, attrs: Attrs = {}, children: string | string[] = ''): string {
  let a = ''
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    a += ` ${k}="${escapeXml(String(v))}"`
  }
  const inner = Array.isArray(children) ? children.join('') : children
  return inner === '' ? `<${name}${a}/>` : `<${name}${a}>${inner}</${name}>`
}

/** Text for an ODF paragraph that keeps its spaces and tabs (code): runs of
 *  spaces become `text:s`, tabs `text:tab`, as ODF collapses white space. */
export function odfPreservedText(s: string): string {
  let out = ''
  const parts = s.split(/(\t| {2,}|^ )/)
  for (const part of parts) {
    if (part === '') continue
    if (part === '\t') out += '<text:tab/>'
    else if (/^ +$/.test(part) && (part.length > 1 || out === '')) {
      // The first space of a run stays a space, except at the start of the line.
      const atStart = out === ''
      const count = atStart ? part.length : part.length - 1
      out += (atStart ? '' : ' ') + (count === 1 ? '<text:s/>' : `<text:s text:c="${count}"/>`)
    } else out += escapeXml(part)
  }
  return out
}

/** Base64 of binary data, for `office:binary-data`. */
export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}
