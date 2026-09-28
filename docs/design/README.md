# Design — verbindliche Referenz für Phase 1

Diese Seite bündelt das Ergebnis von Phase D (UI/UX-Design) und ist die Grundlage, auf der
die Frontend-Implementierung in Phase 1 aufbaut. Sie ersetzt nicht die abgenommenen Mockups
und die Token-Quelle, sondern verweist auf sie.

## 1. Entschiedene Richtung

Gewählt wurde **Variante B „Werkzeug"** aus den drei Stilexplorationen
(`docs/design/explorations/`): kompaktes, dichtes Layout mit System-Sans-Schrift und
sichtbarer Panel-Struktur, ausgelegt auf tägliches Arbeiten und Nachschlagen statt auf lange
Lesestrecken. Die Akzentfarbe von Variante B (Kobaltblau) wurde vollständig durch die
vorgegebene Markenpalette ersetzt — Rot (`#e70c2e`) als Primärakzent, Purpur und Beige
als Sekundärflächen, dazu neu eingeführtes Grün für den Status `released`, da die
Markenpalette kein Grün enthält. Alle Farbwerte sind gegen WCAG-AA (≥ 4.5:1 für Fließtext,
≥ 3:1 für UI-Chrome) geprüft und wo nötig in der Helligkeit angepasst; die vollständige
Herleitung inklusive Kontrastwerten steht in `docs/design/explorations/README.md` (Abschnitt
„Entscheidung") und als Kommentare direkt bei den Werten in `packages/design-tokens/src/tokens.ts`.

## 2. Token-Referenz

Die Werte selbst leben ausschließlich in `packages/design-tokens/src/tokens.ts` (Quelle) bzw.
im generierten `packages/design-tokens/dist/tokens.css` (CSS-Variablen, `:root` = Light,
`[data-theme="dark"]` und `@media (prefers-color-scheme: dark)` = Dark). Diese Tabelle
dupliziert keine Werte, sondern beschreibt Zweck und Einsatz je Token. Bei Änderungen ist
`tokens.ts` die einzige Quelle der Wahrheit — `pnpm --filter @f451/design-tokens build`
regeneriert `tokens.css`.

| Token | Zweck | Einsatzbeispiel |
|---|---|---|
| `--color-bg` | Grundfläche der Seite | `<body>`-Hintergrund, Shell-Hintergrund |
| `--color-bg-raised` | Leicht abgesetzte Fläche über `--color-bg` | Panels, Karten (`.card`), Tabellenzeilen (`tbody tr:nth-child(even)`) |
| `--color-text` | Primäre Textfarbe | Fließtext, Überschriften |
| `--color-text-muted` | Sekundärer/gedämpfter Text | Metadaten (Autor, Zeitstempel), Platzhaltertext, Icons ohne Bedeutungsträgerfunktion |
| `--color-accent` | Markenakzent (Signalrot) | Aktive Navigation, primäre Buttons, Links, Fokus-Ring |
| `--color-accent-contrast` | Textfarbe auf `--color-accent`-Fläche | Beschriftung auf primären Buttons |
| `--color-border` | Trennlinien, Rahmen | Kartenrahmen, Tabellenlinien, `border-bottom` der Topbar |
| `--color-danger` | Gefahren-/destruktive Aktionen — bewusst vom Akzent abgesetzt | „Entwurf verwerfen", Fehler-Hinweise |
| `--color-status-working` | Statusfarbe „working" (neutral/grau-blau) | Status-Badge, Statuszeile im Editor |
| `--color-status-review` | Statusfarbe „review" (amber) | Status-Badge, Soft-Lock-Hinweis, Diff-Markierung „geändert" |
| `--color-status-released` | Statusfarbe „released" (grün) | Status-Badge, Diff-Markierung „hinzugefügt" |
| `--color-status-archived` | Statusfarbe „archived" (gedämpftes Grau) | Status-Badge für archivierte Seiten |
| `--font-sans` | System-Sans-Stack | Fließtext, UI-Elemente |
| `--font-mono` | System-Mono-Stack | Codeblöcke, `<code>`, Pfade/URLs in Tabellen |
| `--text-xs` … `--text-2xl` | Schriftgrößen-Skala (6 Stufen) | `xs`: Badges/Meta, `sm`: UI-Text, `md`: Fließtext, `lg`: Zwischenüberschriften, `xl`/`2xl`: Titel |
| `--space-1` … `--space-8` | Abstands-Skala (8 Stufen) | Padding/Gap in Buttons, Panels, Layout-Grid |
| `--radius-sm` / `--radius-md` / `--radius-lg` | Eckenradien | `sm`: Badges/Chips, `md`: Buttons/Popover, `lg`: Karten/Panels |
| `--shadow-sm` / `--shadow-md` | Schattentiefen | `sm`: Karten in Ruhe, `md`: Popover/Dropdowns über Inhalt |

Statusfarben und Basisfarben sind in Light und Dark unterschiedlich kalibriert (siehe
Kommentare in `tokens.ts`), die CSS-Variablennamen bleiben themenübergreifend identisch.

## 3. Statusfarben-Semantik

| Status | Bedeutung | Farbton |
|---|---|---|
| `working` | In Bearbeitung, noch kein Review angefragt | neutral/grau-blau |
| `review` | Review angefragt, wartet auf Freigabe | amber |
| `released` | Freigegeben, aktueller gültiger Stand | grün |
| `archived` | Nicht mehr aktueller/gültiger Stand | gedämpftes Grau |

**Nie-Farbe-allein-Regel:** Farbe ist in jedem Fall nur eine redundante Verstärkung, nie der
einzige Träger einer Information. Jeder Status trägt zusätzlich Label und/oder Icon (z. B.
`.chip`/`.badge`/`.dbadge` mit Text „Released"/„Entwurf" plus Icon). Diff-Markierungen tragen
zusätzlich zur Farbe einen Randbalken, ein Text-Tag (z. B. „geänd.", „neu") sowie bei
Wort-Diffs Unterstreichung (Einfügung) bzw. Durchstreichung (Entfernung). Graph-Kantentypen
werden zusätzlich über Strichstil und Pfeilform unterschieden, nicht nur über Farbe. Fließtext
erfüllt in beiden Themes WCAG-AA-Kontrast (≥ 4.5:1).

## 4. Mockup-Verzeichnis

Alle Pfade relativ zu `docs/design/`.

| Datei | Screen | Status | Abgenommen am |
|---|---|---|---|
| `mockups/leseansicht.html` | Leseansicht (finale Shell: Topbar, Seitenbaum, Wiki-Seite, rechte Leiste) | Abgenommen | 2026-07-09 |
| `mockups/editor.html` | Editor (/-Menü, `[[`-Autocomplete, Entwurfs-Statuszeile, Formatier-Toolbar) | Abgenommen (nach Mobil-Fixes) | 2026-07-10 |
| `mockups/graph.html` | Graph-Ansicht (Knoten nach Status, Kantentyp-Legende, Filter) | Abgenommen (nach Mobil-Fixes) | 2026-07-10 |
| `mockups/review-diff.html` | Review-Diff (visuelle + Markdown-Diff-Ansicht, Aktionsleiste, Konfliktfall) | Abgenommen (nach Mobil-Fixes) | 2026-07-10 |

`editor.html`, `graph.html` und `review-diff.html` wurden am 2026-07-10 nach den in Abschnitt 5
beschriebenen Mobil-Fixes (Topbar-Überlauf, angedocktes Graph-Popover, Editor-Overflow) erneut
geprüft und abgenommen.

### Historisch: Stilexplorationen

`explorations/variante-a.html`, `explorations/variante-b.html`, `explorations/variante-c.html`
sowie `explorations/README.md` dokumentieren die drei zur Wahl gestellten Gestaltungsrichtungen
und die Entscheidung für Variante B. Sie sind **historisch** — keine Implementierungsgrundlage,
keine Pflege-Verpflichtung. Für Phase 1 zählen ausschließlich die vier Mockups oben.

## 5. Responsive-Regeln

Etabliert durch die Mobil-Fixes an allen vier Mockups (Commits `18a10dc`, `64f4577`, `c7d78b0`).
Verbindlich für Phase 1:

- **Grundsatz: die Seite scrollt nie horizontal.** `document.documentElement.scrollWidth` darf
  `window.innerWidth` auf keiner unterstützten Breite überschreiten.
- **Breite Inhalte scrollen in ihrem eigenen Container**, nicht die Seite — z. B. Tabellen in
  `.tbl-wrap{overflow-x:auto}`, Codeblöcke in `pre{overflow-x:auto}`.
- **Layout-Breakpoints** (Shell mit Seitenbaum + Inhalt + rechter Leiste, in `leseansicht.html`,
  `editor.html`, `review-diff.html`):
  - `max-width: 1160px` — rechte Leiste (`.rail`) wird ausgeblendet, Grid auf zwei Spalten.
  - `max-width: 820px` — Seitenbaum (`.tree`) wird ausgeblendet, Grid auf eine Spalte.
  - `graph.html` hat kein `.rail`/`.tree` (eigenständiges Vollbild-Layout mit Mini-Baum
    `.minitree`); dort gilt stattdessen `max-width: 720px` für das Ausblenden von `.minitree`.
- **Topbar/Suche, `max-width: 640px`** (identisch in allen vier Dateien): kompakte Suchleiste
  (Platzhaltertext wird durch Kurzlabel „Suchen" ersetzt, App-Namenszusatz in `.brand`
  ausgeblendet); zusätzlich `max-width: 400px` blendet auch das Kurzlabel aus (nur noch
  Icon + `⌘K`). Suchfeld und Buttons erhalten feste/nicht schrumpfende Breiten (`flex:none`
  auf `.tbtn`/`.avatar`), damit nichts überlappt.
- **Popover docken bei schmalen Breiten unten an**: Popups (`.pop`, z. B. `.cmdmenu`,
  `.linkpop`, Graph-Detailpopover) wechseln unterhalb der jeweiligen Breakpoint-Schwelle von
  `position:absolute` (Sprechblase mit Zunge) zu `position:fixed;left/right:var(--space-3);
  bottom:var(--space-3)` (volle Breite minus Rand, oben abgerundet, Zunge ausgeblendet) —
  siehe `graph.html` (`max-width:720px`) als Referenzimplementierung.
- Anchor-relative Demo-/Hinweis-Badges dürfen nicht an inline-fließenden Elementen verankert
  werden, wenn sie über den Viewportrand hinausragen können — stattdessen am Block-Container
  verankern und umbruchfähig gestalten (Lehre aus `editor.html`, Commit `c7d78b0`).

## 6. Komponentenliste für Phase 1

Gestalt-Referenz = das Mockup, aus dem die Implementierung visuell abgeleitet werden soll.
Die vier Mockups teilen sich Token-`<style>`-Block und Topbar-Markup 1:1 (siehe Abschnitt
„Konsistenz-Check" im Task-Bericht); eine Komponente ist nur dann bei mehreren Screens
verlinkt, wenn sich ihre Ausprägung zwischen den Screens unterscheidet.

| Komponente | Gestalt-Referenz | Fundstelle (Klasse) |
|---|---|---|
| Topbar | `mockups/leseansicht.html` (identisch in allen vier) | `.topbar` |
| Seitenbaum-Item | `mockups/leseansicht.html` | `.tree .nav a`, aktiv: `.active` |
| Status-Badge | `mockups/leseansicht.html` (Kopfzeile), `mockups/editor.html` (Entwurfs-Variante) | `.chip`, `.dbadge` |
| Hinweisbanner | `mockups/leseansicht.html` | `.notices` / `.notice` |
| Soft-Lock-Hinweis | `mockups/leseansicht.html` | `.notice.lock` |
| Tag-Chip | `mockups/leseansicht.html` (rechte Leiste) | `.tags .tag` |
| Broken-Link-Stil | `mockups/leseansicht.html`, `mockups/editor.html` | `a.broken` |
| Toolbar-Button | `mockups/editor.html` | `.etoolbar .tbtn` |
| /-Menü-Popup | `mockups/editor.html` | `.pop.cmdmenu` |
| Autocomplete-Popup | `mockups/editor.html` | `.pop.linkpop` |
| Metadaten-Panel | `mockups/editor.html` (rechte Leiste, editierbar) | `.rail` (aria-label „Metadaten bearbeiten") |
| Graph-Legende | `mockups/graph.html` | `.legend` |
| Diff-Markierung | `mockups/review-diff.html` | `.dchange` (Absatz), `.cell-chg` (Tabellenzelle) |
| Konflikt-Banner | `mockups/review-diff.html` | `.notice.conflict` |
| Aktionsleiste | `mockups/review-diff.html` | `.actions` / `.act-row` |
