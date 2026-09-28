/**
 * Sicheres Snippet-Rendering für Suchtreffer.
 *
 * `GET /api/search` liefert Snippets über Postgres' `ts_headline` (siehe
 * `apps/api/src/routes/search.ts`) — reiner Text mit `<b>…</b>`-Markup um die
 * Treffer-Wörter. Dieses Modul parst genau diese Markierung, OHNE jemals
 * `dangerouslySetInnerHTML` zu benutzen: `components/search-dialog.tsx`
 * rendert das Ergebnis ausschließlich als React-Textknoten. Schon dadurch
 * kann kein Markup ausgeführt werden — diese Funktion sorgt zusätzlich dafür,
 * dass NUR echte, wohlgeformte `<b>`/`</b>`-Paare optisch hervorgehoben
 * werden und jedes andere Zeichen (inklusive anderer Tags wie `<script>`)
 * als literaler Text erhalten bleibt.
 *
 * Parser-Regeln:
 * - Nur die exakten Strings `<b>` und `</b>` zählen als Markup-Grenzen
 *   (case-sensitive, keine Attribute) — alles andere ist Text.
 * - Ein `<b>` öffnet nur, wenn gerade keines offen ist. Ein zweites `<b>`,
 *   während eines bereits offen ist (Verschachtelung), bleibt literaler Text
 *   innerhalb des äußeren Hervorhebungs-Segments.
 * - Ein `</b>` schließt nur ein offenes `<b>`. Ein `</b>` ohne passendes
 *   offenes `<b>` (verwaist) bleibt literaler Text.
 * - Ein `<b>`, das bis zum Ende des Strings nie geschlossen wird
 *   (unbalanciert), bleibt ebenfalls literaler Text — es wird NIE als
 *   Hervorhebung ohne Ende gerendert.
 */

export interface SnippetSegment {
  text: string
  highlighted: boolean
}

type Token =
  | { kind: 'open' | 'close'; value: '<b>' | '</b>' }
  | { kind: 'text'; value: string }

const TAG_RE = /(<\/?b>)/g

function tokenize(input: string): Token[] {
  return input
    .split(TAG_RE)
    .filter((part) => part.length > 0)
    .map((part): Token => {
      if (part === '<b>') return { kind: 'open', value: '<b>' }
      if (part === '</b>') return { kind: 'close', value: '</b>' }
      return { kind: 'text', value: part }
    })
}

/** Parst einen `ts_headline`-Snippet-String in Text-/Hervorhebungs-Segmente. */
export function parseSnippet(input: string): SnippetSegment[] {
  const tokens = tokenize(input)

  // Pass 1: nur wohlgeformte, nicht verschachtelte <b>…</b>-Paare als Markup
  // markieren (Index -> Markup-Flag). Alles andere bleibt per Default Text.
  const isMarkup = new Array<boolean>(tokens.length).fill(false)
  let openIndex: number | null = null
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'open') {
      if (openIndex === null) openIndex = i
      // sonst: verschachteltes <b> — bleibt literaler Text (Default false)
    } else if (token.kind === 'close') {
      if (openIndex !== null) {
        isMarkup[openIndex] = true
        isMarkup[i] = true
        openIndex = null
      }
      // sonst: verwaistes </b> — bleibt literaler Text (Default false)
    }
  }
  // Ein am Ende noch offenes <b> (openIndex !== null) bleibt unmarkiert und
  // damit literaler Text — genau das gewünschte "unbalanciert → als Text".

  // Pass 2: Segmente aus den markierten Grenzen bauen.
  const segments: SnippetSegment[] = []
  let buffer = ''
  let highlighted = false

  function flush(): void {
    if (buffer.length > 0) segments.push({ text: buffer, highlighted })
    buffer = ''
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'open' && isMarkup[i]) {
      flush()
      highlighted = true
    } else if (token.kind === 'close' && isMarkup[i]) {
      flush()
      highlighted = false
    } else {
      buffer += token.value
    }
  }
  flush()

  return segments
}
