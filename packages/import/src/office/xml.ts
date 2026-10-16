// A minimal pull tokenizer for the XML parts of ODF and OOXML packages
// (content.xml, meta.xml, *.rels). No DTDs, no namespaces resolution: names
// keep their prefix (`draw:frame`), which is how ODF documents are written.

export type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; value: string }

// Groups: 1 CDATA text, 2 closing name, 3 opening name, 4 attributes, 5 self-closing slash, 6 text.
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(ENTITY, (all, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()] ?? all
    const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '', 10)
    try {
      return String.fromCodePoint(code)
    } catch {
      return all
    }
  })
}

/** Yields start tags, end tags and text in document order; comments,
 *  processing instructions and doctypes are skipped. Malformed markup is
 *  skipped rather than reported. */
export function* xmlEvents(xml: string): Generator<XmlEvent> {
  const re = new RegExp(TOKEN.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) yield { type: 'text', value: m[1] }
    else if (m[2] !== undefined) yield { type: 'close', name: m[2] }
    else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {}
      for (const a of (m[4] ?? '').matchAll(ATTR)) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '')
      yield { type: 'open', name: m[3], attrs, selfClosing: m[5] === '/' }
    } else if (m[6] !== undefined) yield { type: 'text', value: decodeEntities(m[6]) }
  }
}
