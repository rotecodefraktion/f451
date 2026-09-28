# Stilvarianten der Leseansicht

Drei bewusst unterschiedliche Gestaltungsrichtungen für **dieselbe** Leseansicht der
Git-nativen Dokumentationsplattform **f451**. Alle drei zeigen identischen Inhalt und
identische Elemente (Topbar, Seitenbaum, Wiki-Seite „Deployment", Statuszeile, rechte
Leiste mit Inhaltsverzeichnis, Tags und Mini-Graph) — nur die Gestalt unterscheidet sich.

Jede Datei ist self-contained (keine externen Fonts, Bilder oder Skripte), nutzt einen
System-Font-Stack, Inline-SVG-Icons und funktioniert in **Light und Dark**. Das Theme folgt
`prefers-color-scheme`; oben rechts schaltet ein Button per `data-theme` am `<html>`-Element
manuell um.

## Varianten

### A — „Ruhige Dokumentation" (`variante-a.html`)
Warmes Papier, Serifen-Titel (Palatino/Georgia-Stack), Salbeigrün als einziger Akzent und
viel Weißraum bei schmaler Textspalte (~68 Zeichen). Haarlinien statt Flächen, ruhige
Hierarchie — die Gestaltung tritt zurück, damit der Text im Vordergrund steht. Für lange,
konzentrierte Lesestrecken.

### B — „Werkzeug" (`variante-b.html`)
Kompakt und dicht, durchgehend System-Sans, kräftiger Kobaltblau-Akzent und sichtbare
Struktur aus umrandeten Panels (Confluence-nah). Werkzeugleiste mit Meta-Zeile, Raster in der
Tabelle, benannter Codeblock-Kopf — maximale Informationsdichte für tägliches Arbeiten und
Nachschlagen.

### C — „Editorial" (`variante-c.html`)
Magazin-Anmutung mit großer Typo-Hierarchie: übergroßer Serifen-Titel, nummerierte Kapitel,
Initial (Drop-Cap) und Vermillon als markanter Akzent auf hohem Kontrast. Zwei-Schrift-System
(Serif-Display + Sans-Fließtext), kräftige Trennlinien und asymmetrische Betonung — für einen
selbstbewussten, wiedererkennbaren Auftritt.

## Statusfarben-Semantik (in allen Varianten gleich)
- **working** — neutral/grau-blau
- **review** — amber
- **released** — grün

Farbe steht nie allein: jeder Status trägt zusätzlich Label und Icon. Fließtext erfüllt in
beiden Themes WCAG-AA-Kontrast (≥ 4.5:1).

## Entscheidung

**Gewählt am 2026-07-09: Variante B („Werkzeug") mit der vorgegebenen Markenfarbwelt.**

Layout, Dichte und Panel-Struktur kommen aus Variante B; die Farbwelt wird durch die
Markenpalette des Betreibers ersetzt (übernommen aus dessen Design-System):

| Rolle | Wert | Quelltoken |
|---|---|---|
| Primär/Akzent | `#e70c2e` (Rot) | `--color-p-100` |
| Sekundärakzent | `#8d0981` (Purpur) | `--color-p-200` |
| Warmton (Flächen) | `#f4ebe1` (Beige) | `--color-p-300` |
| Text dunkel | `#242424` / `#000` | `--color-n-500/600` |
| Gedämpft | `#7c8084` / `#aeb0b1` | `--color-n-700/900` |
| Flächen hell | `#f5f5f5` / `#f7f7f7` / `#efefef` | `--color-n-400/450/800` |
| Linien | `#d9d9d9` / `#e6e6e6` | `--color-n-200/300` |
| Orange/Amber (Zusatz) | `#ef6f00` / `#fdbf54` | (Akzente) |

Hinweise für die Token-Ableitung (Task 2):
- Kobaltblau aus Variante B wird vollständig durch das Markenrot als Akzent ersetzt.
- **Rot ist zugleich Markenfarbe und potenzielle Gefahrenfarbe** — `--color-danger` muss
  sich vom Akzent unterscheidbar absetzen (z. B. dunkleres Signalrot) und destruktive
  Aktionen tragen immer zusätzlich Text/Icon.
- Statusfarben-Semantik bleibt wie geplant (working = grau-blau, review = amber → hier
  bietet sich `#ef6f00`/abgedunkelt an, released = grün — Grün wird neu eingeführt, da die
  Markenpalette keins enthält).
- Alle Werte sind gegen die WCAG-Kontrast-Tests zu prüfen und dürfen dafür in Helligkeit
  angepasst werden (z. B. `#e70c2e` auf Weiß liegt nahe der 4.5:1-Grenze — für Text-Links
  ggf. abdunkeln, als reine UI-Akzentfläche zulässig).
- Dark Theme: die Markenvorgabe definiert keines — es wird aus der Palette abgeleitet (dunkle
  Neutrals `#242424`-Familie, Akzente aufgehellt bis Kontrast erfüllt).
