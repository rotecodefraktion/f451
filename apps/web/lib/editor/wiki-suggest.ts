// --- `[[`-Autocomplete: Treffer-Merge + Zielableitung (Phase 2c Task 5) ------------
//
// `suggestWikiTargets` wird direkt als `items()`-Callback der `@tiptap/suggestion`-
// Instanz für `[[` verdrahtet (s. ui-extensions.ts) — Debounce (250ms) UND ein
// `AbortSignal` pro Tastenschlag liefert die Suggestion-Utility selbst (v3.27,
// `SuggestionOptions.debounce` + `items({query, editor, signal})`, s. installiertes
// `@tiptap/suggestion/dist/index.js`), deshalb reicht dieses Modul das Signal nur
// durch und verwirft ein bereits überholtes Ergebnis (dieselbe „prüfe nach dem Await,
// ob inzwischen abgebrochen wurde"-Idee wie `search-dialog.tsx`, nur ohne eigenen
// `AbortController` — den hält die Suggestion-Utility).

/** Minimal-Sicht auf einen `searchPages`-Treffer, die dieses Modul braucht (kein
 *  `space`/`snippet`/`rank` — Structural Typing spart eine harte Abhängigkeit auf
 *  `client-api.ts`s vollen `SearchResult`-Typ, s. `fakeDeps` in wiki-suggest.test.ts). */
export interface WikiSearchResult {
  id: string
  title: string
  path: string
}

/** Injizierbare `searchPages`-Abhängigkeit (Brief: „injizierbare deps") — die echte
 *  Implementierung ist `client-api.ts#searchPages`, hier nur strukturell erwartet,
 *  damit `wiki-suggest.test.ts` ohne `fetch`/DOM auskommt (node-vitest, kein jsdom). */
export interface WikiSuggestDeps {
  searchPages(
    query: string,
    options: { space?: string; ref?: 'main' | 'draft'; prefix?: boolean },
  ): Promise<WikiSearchResult[]>
}

/** Ein Treffer im `[[`-Popup — `isDraft:true` zeigt das `.mk`-Badge „Entwurf"
 *  (wiki-link-popup.tsx). */
export interface WikiSuggestion {
  id: string
  title: string
  path: string
  isDraft: boolean
}

const MAX_RESULTS = 8

/** Parallel gegen `ref:'main'` UND `ref:'draft'` suchen, nach `id` deduplizieren
 *  (Draft-Treffer gewinnt — überschreibt einen gleich-id'd main-Treffer, s.
 *  Brief: „Draft-Treffer gewinnt, isDraft:true"), auf {@link MAX_RESULTS} kappen.
 *  Leere Query liefert `[]`, OHNE `deps.searchPages` überhaupt aufzurufen (kein
 *  unnötiger Netzwerk-Roundtrip bei frisch getipptem `[[`). Ist `signal` beim
 *  Auflösen bereits abgebrochen, wird das Ergebnis verworfen (`[]`) — eine neuere
 *  Anfrage läuft bereits, s. Kopfkommentar. */
export async function suggestWikiTargets(
  query: string,
  space: string,
  deps: WikiSuggestDeps,
  signal?: AbortSignal,
): Promise<WikiSuggestion[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  // Tipp-Suche — der Nutzer steht mitten im Wort, Präfix-Matching Phase 3a.
  const [mainResults, draftResults] = await Promise.all([
    deps.searchPages(trimmed, { space, ref: 'main', prefix: true }),
    deps.searchPages(trimmed, { space, ref: 'draft', prefix: true }),
  ])

  if (signal?.aborted) return []

  const byId = new Map<string, WikiSuggestion>()
  for (const r of mainResults) {
    byId.set(r.id, { id: r.id, title: r.title, path: r.path, isDraft: false })
  }
  for (const r of draftResults) {
    byId.set(r.id, { id: r.id, title: r.title, path: r.path, isDraft: true })
  }

  return [...byId.values()].slice(0, MAX_RESULTS)
}

export interface WikiLinkInsertion {
  target: string
  alias: string | null
}

/** Leitet `target`/`alias` für den einzufügenden `wikiLink`-Node aus einem
 *  Such-Treffer ab (Brief-Regel VERBATIM): `target` = Verzeichnispfad ohne
 *  `/index.md` (`betrieb/deployment/index.md` → `betrieb/deployment`);
 *  Wurzel-`index.md` (kein Verzeichnisanteil) → `target` = Titel. `alias` = Titel,
 *  wenn Titel ≠ target — eindeutig gegen Titel-Kollisionen, weil `LinkResolver`
 *  `<target>/index.md` EXAKT matcht (`apps/api/src/indexer/resolve-links.ts`,
 *  `#resolveWikilink`). Die Serialisierung `[[pfad|Titel]]` ist damit roundtrip-fest
 *  (2b-Korpus) — `alias:null` heißt "kein `|Alias`-Suffix im Markdown". */
export function deriveWikiLinkTarget(suggestion: Pick<WikiSuggestion, 'title' | 'path'>): WikiLinkInsertion {
  // `(^|\/)index\.md$` deckt beide Fälle in einem Ausdruck ab: `index.md` an der
  // Wurzel (der `^`-Zweig, kein Verzeichnisanteil übrig) UND `.../index.md` in
  // einem Unterverzeichnis (der `/`-Zweig, das Verzeichnis bleibt übrig).
  const dir = suggestion.path.replace(/(^|\/)index\.md$/, '')
  const target = dir.length === 0 ? suggestion.title : dir
  const alias = suggestion.title !== target ? suggestion.title : null
  return { target, alias }
}
