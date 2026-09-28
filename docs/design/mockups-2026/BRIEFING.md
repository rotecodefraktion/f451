# Briefing — Design-Mockups f451 (2026)

Gemeinsamer Kontext für alle Mockup-Agenten. **Vollständig lesen, bevor du entwirfst.**

## Was f451 ist

Git-native Dokumentationsplattform für Unternehmen. Jeder **Space** ist ein Git-Repository
(Forgejo/GitHub); Seiten sind Markdown-Dateien mit YAML-Frontmatter. Rechte erbt die App
vom Git-Provider — es gibt kein eigenes Rollensystem. Änderungen laufen über einen
Review-Workflow: Entwurf → Review-PR → Freigabe. Die Oberfläche ist **durchgängig deutsch**.

Reale Inhalte: SAP-/Azure-Betriebshandbücher (HANA, MaxDB, Backup & Restore,
Kerneltausch), technische HOW-TOs mit draw.io-Diagrammen, Code- und Konsolenblöcken.
Nutzer sind Admins und Berater — Fachpublikum, das lange Prozeduren liest und
Schritt für Schritt abarbeitet.

## Ansichten (alle bestehenden Routen)

| Route | Zweck |
|---|---|
| `/wiki` | Space-Übersicht (Einstieg) |
| `/wiki/<space>` | Space-Startseite |
| `/wiki/<space>/<pageId>` | **Leseansicht** — die wichtigste Ansicht |
| `/wiki/<space>/<pageId>/edit` | Editor (Markdown, Live-Vorschau, Diagramme) |
| `/wiki/<space>/<pageId>/review` | Review (Diff, Kommentare, Freigabe) |
| `/wiki/<space>/report` | Bericht (defekte Links, Fehler) |
| `/wiki/<space>/schema` | Metadaten-Schema des Space |
| `/wiki/<space>/templates` | Vorlagenverwaltung |
| `/wiki/<space>/graph` | Wissensgraph |
| `/einstellungen/verbindungen` | Konten verbinden, API-Tokens |

## Aufbau der Leseansicht heute

- **Linke Seitenleiste:** Seitenbaum (verschachtelt, Drag&Drop), Space-Umschalter, Suche
- **Kopfbereich:** Breadcrumb (`handbuch / azure betrieb / backup restore / Backup & Restore`),
  Status-Chip (`Released`), Button „Bearbeiten"
- **Metazeile:** `Aktualisiert 25.07.2026 · Space handbuch · Version 1.2.0`
- **Hinweisblöcke:** Verarbeitungsfehler, defekte Links (gelber Kasten)
- **Inhalt:** Überschriften, Fließtext, Tabellen, Codeblöcke, Callouts, draw.io-SVG-Diagramme, Bilder
- **Rechte Info-Leiste („Rail"):** Inhaltsverzeichnis (Sprungmarken), Tags, Metadaten
  (schema-getrieben), Relationen (nach Typ gruppiert), Mini-Graph verknüpfter Seiten

**Workflow-Status:** `Entwurf` · `In Review` · `Released` · `Archiviert` — jeder mit eigener Farbe.

## Design-System heute

`packages/design-tokens/src/tokens.ts` → generiert `tokens.css` (CSS-Variablen), importiert in
`apps/web/app/globals.css`. Vorhandene Token-Gruppen:

- `--color-bg`, `--color-bg-raised`, `--color-text`, `--color-text-muted`,
  `--color-accent`, `--color-accent-contrast`, `--color-border`, `--color-danger`
- `--color-status-working|review|released|archived`
- `--font-sans` (Hanken Grotesk), `--font-display` (Schibsted Grotesk), `--font-mono` (JetBrains Mono)
- `--text-xs|sm|md|lg|xl|2xl`
- `--space-1` … `--space-8`
- `--radius-sm|md|lg`
- `--shadow-sm|md|accent`

Light und Dark sind beide Pflicht (`[data-theme="dark"]` + `prefers-color-scheme`).

## Was der Auftraggeber am heutigen Design kritisiert

Alle vier Punkte gelten gleichzeitig:

1. **Uneinheitliche Bausteine** — Buttons, Karten, Dialoge, Abstände sehen je nach Ansicht
   anders aus; gewachsen statt systematisch (`globals.css` ist über 2600 Zeilen).
2. **Navigation/Auffindbarkeit** — Funktionen werden nicht gefunden (die Vorlagenverwaltung
   existiert seit Monaten und war dem Auftraggeber unbekannt).
3. **Wirkt altbacken** — visuelle Sprache nicht auf der Höhe von 2026.
4. **Leseerlebnis** — Zeilenlänge, Hierarchie, Code/Diagramme/Tabellen und
   Inhaltsverzeichnis tragen die langen technischen Prozeduren nicht.

## Harte Randbedingung: Themefähigkeit

Parallel entsteht die Fähigkeit, dass Anwender **eigene Design-Templates** anlegen —
festgelegt als **reine Token-Themes** (Farben, Schriften, Abstände, Radien, Schatten,
Dichte), global mit Space-Override. Kein fremdes CSS, keine Layout-Schalter.

**Konsequenz für deinen Entwurf:** Layout und Bausteine sind *fix* (das ist der neue
Standard), die visuelle Identität muss sich *allein über Token-Werte* verschieben lassen.
Schreibe Farben, Abstände, Radien und Schriftgrößen deshalb ausschließlich als
CSS-Variablen — keine fest eingebrannten Hex-Werte oder px-Angaben in den Bausteinen.
Ein Mockup, dessen Wirkung an hartcodierten Werten hängt, ist unbrauchbar.
