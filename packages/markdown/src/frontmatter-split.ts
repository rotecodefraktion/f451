import { markdownProcessor } from './parse.js'

/** mdast-Knoten von remark-frontmatter — kein offizieller mdast-Typ vorhanden (analog
 *  zu den lokalen Typen in parse.ts). position ist Standard bei unified/micromark immer
 *  gesetzt (nichts in diesem Paket deaktiviert das). */
interface YamlNode {
  type: 'yaml'
  position?: { end: { offset: number } }
}

/** Trennt einen führenden YAML-Frontmatter-Block (samt `---`-Zäunen und
 *  abschließendem Zeilenumbruch) byte-identisch vom Rest des Dokuments ab. Nutzt
 *  denselben geteilten Prozessor wie parsePage/parseMarkdownTree, um exakt dieselbe
 *  Erkennung zu verwenden (Position des yaml-Knotens im Quelltext) statt eine zweite,
 *  potenziell abweichende Fence-Erkennung per Hand nachzubauen. Kein Frontmatter ->
 *  frontmatterRaw === ''. */
export function splitFrontmatter(markdown: string): { frontmatterRaw: string; body: string } {
  const tree = markdownProcessor.parse(markdown)
  const first = tree.children[0] as unknown as YamlNode | undefined

  if (!first || first.type !== 'yaml' || !first.position) {
    return { frontmatterRaw: '', body: markdown }
  }

  // position.end.offset zeigt auf das Zeichen direkt nach dem schließenden '---' —
  // den folgenden Zeilenumbruch (\n oder \r\n) zählen wir noch zum Frontmatter-Block
  // dazu ("abschließender Zeilenumbruch" laut Vertrag).
  let end = first.position.end.offset
  if (markdown[end] === '\r' && markdown[end + 1] === '\n') {
    end += 2
  } else if (markdown[end] === '\n') {
    end += 1
  }

  return { frontmatterRaw: markdown.slice(0, end), body: markdown.slice(end) }
}

/** Kehrt splitFrontmatter um. Reine Konkatenation genügt, weil splitFrontmatter den
 *  Split-Punkt so wählt, dass frontmatterRaw + body === markdown gilt — dadurch ist
 *  das Roundtrip-Gesetz joinFrontmatter(...Object.values(splitFrontmatter(md))) === md
 *  für jedes Dokument trivial erfüllt. */
export function joinFrontmatter(frontmatterRaw: string, body: string): string {
  return frontmatterRaw + body
}
