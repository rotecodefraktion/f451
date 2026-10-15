/** The diagram a `.drawio.svg` carries in its `content` attribute, decoded;
 *  null when the SVG has none. */
export function diagramXml(svg: Uint8Array): string | null {
  const m = /\scontent="([^"]*)"/.exec(Buffer.from(svg).toString('utf8'))
  if (!m) return null
  return m[1]!
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
