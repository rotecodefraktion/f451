# @f451/markdown

Eine Pipeline, zwei Konsumenten: dieselbe Markdown-Verarbeitung liefert sowohl die
Struktur für den Indexer (`parsePage`) als auch das HTML für die Leseansicht
(`renderHtml`). In Phase 2 dient sie zusätzlich als Referenz für die
Editor-Serialisierung — daher die Golden-Files.

## API

- **`parsePage(markdown, opts?)`** — parst Frontmatter, Wikilinks/relative Links
  (keine externen/Anker/mailto, keine Bilder), Headings mit Slugs und den Titel
  (`frontmatter.title`, sonst erstes H1, sonst `undefined`). Wirft nie.
- **`renderHtml(markdown, opts)`** — rendert sanitisiertes HTML. Callback-Vertrag:
  - `resolveLink(rawTarget, kind)` — `{ href }` bei Treffer, sonst `null` →
    Linkziel wird zu `<span class="broken-link" title="…">` ohne `href`.
  - `resolveImage?(src)` — schreibt relative Bildpfade um (z. B. Media-Endpunkt der
    Seite); ohne Callback bleiben Pfade unverändert.

## Diff-Engine (Phase 2d Task 4)

**`diffMarkdown(oldMd, newMd, opts?)`** vergleicht zwei vollständige Markdown-Dokumente
(Frontmatter inklusive) und liefert ein `MarkdownDiff`:

```ts
interface MarkdownDiff {
  blocks: DiffBlock[]                                  // c1..cN, sanitisiertes HTML je Block
  summary: { added: number; changed: number; removed: number }
  mdLines: MdDiffLine[]                                 // Zeilen-Diff des vollen Dokuments
}
```

**Algorithmus:** Frontmatter wird abgetrennt (`splitFrontmatter`) und bei Abweichung als
eigener, synthetischer `changed`-Block VOR dem Body ausgeliefert (Roh-Darstellung beider
Stände, kein YAML-Diff). Die Bodies werden geparst, ihre Top-Level-Blöcke einzeln über
`stringifyMarkdown` kanonisiert ("Block-String") und per LCS verglichen — identische
Block-Strings sind `same`. Nicht gematchte Blöcke zwischen zwei Treffern werden
**paarweise** (alt[i] ↔ neu[i], in Dokumentreihenfolge) als `changed` behandelt, ein
Überhang wird `removed` bzw. `added`.

Für ein `changed`-Paar aus zwei **Absätzen** gibt es einen **Wort-Diff**
(`diffWordsWithSpace` über die kanonische Markdown-**Quelle** beider Absätze —
Erster-Run-Vereinfachung: innerhalb geänderter Absätze erscheint die Markdown-Quelle
statt gerendertem Rich-Text, `**fett**` bleibt als Zeichenkette sichtbar statt in
gerendertes Fett zu verschwinden — dafür bleiben Formatierungsänderungen selbst
sichtbar). Für zwei **Tabellen** gibt es einen **Zellvergleich** (Zeilen-/Spaltenindex,
KEINE Umordnungserkennung): `cell-chg`/`cell-add`-Klassen + `.cellflag`-Badges auf
geänderten/neuen Zellen, `row-add` auf komplett neuen Zeilen — Postprocessing auf dem
selbst gerenderten HTML der neuen Tabelle. Jeder andere `changed`-Typ (Codeblock,
Alert/Blockquote, Liste, Heading, …) wird als **`removed`+`added`-Paar** ausgeliefert
(zwei Blöcke statt eines `changed`-Blocks).

`mdLines` ist ein reiner Zeilen-Diff (`diffLines`) über die VOLLEN Dokumente (inkl.
Frontmatter) für einen "Markdown"-Tab in der UI.

**Sanitizing:** `same`/`added`/`removed`-Blöcke laufen unverändert durch `renderHtml`
mit dem normalen Seiten-Schema. Die drei Sonderpfade (Wort-Diff, Frontmatter-Roh-Block,
Tabellen-Zellvergleich-Postprocessing) bauen ihr HTML selbst zusammen und laufen
zusätzlich durch einen **eigenen, erweiterten** Sanitizer (`ins`/`del`, `cell-chg`/
`cell-add`/`row-add`/`cellflag`-Klassen, `data-diff`-Attribut) — das normale
Seiten-Schema (`renderHtml`, alle anderen Konsumenten) bleibt davon unberührt. Text, der
in diesen drei Pfaden eingebettet wird, wird vor dem Zusammenbau HTML-escaped und läuft
danach durch einen Reparse (`rehype-raw`) + denselben Sanitizer — ein Absatz, der
zufällig wie ein `<script>`-Tag aussieht, bleibt dadurch sichtbarer (escapeter) Text,
statt als echtes Element interpretiert zu werden; ein echtes, gefährliches Konstrukt
(z. B. `onerror` an einem `<img>` in einer Tabellenzelle) wird bereits von der ersten
`renderHtml`-Runde vollständig entfernt. Siehe `test/diff.test.ts` (XSS-Pflichttest) und
den Modul-Kommentar in `src/diff.ts` für Details.

`opts.resolveLink`/`opts.resolveImage` reichen wie bei `renderHtml` bis in die
`same`/`added`/`removed`-Blöcke durch (NICHT in den Wort-Diff, der zeigt die
Markdown-Quelle). Ohne `resolveLink` markiert der Default jeden Wikilink/relativen Link
als `broken-link` (der Diff kennt ohne übergebenen Resolver den Seitengraph nicht).

**Bewusst nicht gebaut (YAGNI):** kein Syntax-Highlighting im Codeblock-Diff, keine
Moved-Block-Erkennung.

## Frontmatter-Vertrag

Ungültiges/fehlendes Frontmatter ist niemals eine Exception — Fehler landen als
Klartext-Strings in `frontmatterErrors` (z. B. `"tags: muss eine Liste von Strings
sein"`), das restliche Feld bleibt einfach leer/Default. Das macht die Pipeline
indexer-tauglich: eine kaputte Seite blockiert nie den ganzen Lauf (Spec Abschnitt 9).

## Sicherheitsgrenze

`renderHtml` sanitisiert über `rehype-sanitize` (GitHub-Default-Schema + Erweiterungen
für `broken-link`-Spans und Alert-Boxen). Entfernt werden u. a. `<script>`, `<iframe>`,
`<style>`, Event-Handler-Attribute (`onerror` etc.) und `javascript:`-URLs. Rohes
Inline-HTML läuft bewusst durch `rehype-raw` (sonst würde `remark-rehype` es komplett
verschlucken statt es zu sanitisieren) — erlaubt bleiben dadurch harmlose Tags wie
`<b>`, `<em>`, `<br>`. Details und Testfälle: `test/security.test.ts`.

## Golden-File-Politik

`test/fixtures/beispielseite.md` deckt alle unterstützten Konstrukte ab (Frontmatter,
Wikilinks inkl. Alias, relative/externe/kaputte Links, Tabelle, Taskliste,
Codeblock, Alert, Bild, normales Blockquote). Die dazugehörigen `.html`- und
`.parsed.json`-Dateien sind erzeugt und **manuell reviewt** — sie gelten als
eingefroren. Eine Änderung an ihnen ist immer ein bewusster Review-Schritt (Diff
lesen, nicht blind neu generieren), nie ein Nebeneffekt eines Refactorings.

## Tests

```sh
pnpm --filter @f451/markdown test
```
