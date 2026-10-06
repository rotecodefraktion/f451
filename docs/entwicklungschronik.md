# Entwicklungschronik

Wie f451 in Phasen entstanden ist — die frühere README des Projekts.


Self-hosted Wiki mit Confluence-Komfort; Markdown in Git (Forgejo/GitHub) als Source of Truth.

- **Spec:** docs/superpowers/specs/2026-07-09-doku-plattform-design.md
- **Setup:** `pnpm install`, dann `pnpm test`
- **Stacks:** `deploy/wiki/` (App + Postgres), `deploy/git/` (Forgejo-Dev)
- **Betrieb:** Architektur, Env-Referenz, Restore-Prozedur, Störungs-Drehbuch, Monitoring — [deploy/BETRIEB.md](../deploy/BETRIEB.md)

## Phase-1-Status (abgeschlossen)

Phase 1 ist **abgenommen**: Ein bestehendes Markdown-Repo lässt sich als Space einbinden und ist im Browser vollständig navigier- und lesbar.

Was läuft:

- **API** (`apps/api`, Fastify): Indexierung eines Git-Repos (Forgejo/GitHub) nach Postgres, Lese-Endpunkte (`/api/spaces`, `/api/spaces/:id/tree`, `/api/pages/:id`, `/api/search`, `/media/:id/*`), Volltextsuche, Webhooks + Drift-Abgleich.
- **Auth**: OIDC-Login (Microsoft Entra), Session-Cookies, Provider-Kontoverknüpfung (Forgejo/GitHub) mit verschlüsselter Token-Ablage; Space-Sichtbarkeit erbt die Repo-Berechtigung des verknüpften Git-Kontos.
- **Web** (`apps/web`, Next.js App Router): Login-Gate, App-Shell im abgenommenen Design (Design-Tokens), Seitenbaum, gerenderte Wiki-Seiten mit ToC/Metadaten/Broken-Links, ⌘K-Suche, Light/Dark. Graph-Ansicht pro Space (`/wiki/<space>/graph`): Seiten als Knoten (Status-Farben), Hierarchie-/Link-/Relations-Kanten, Filter, Detail-Popover; Mini-Graph verknüpfter Seiten in der Leseansicht.

### Stack lokal starten

Voraussetzung: laufende Container-Runtime (Docker/Podman), Postgres + eine Forgejo-Instanz mit einem Markdown-Repo.

- API: `pnpm --filter @f451/api dev` — konfiguriert über Umgebungsvariablen (`DATABASE_URL`, `F451_SPACES`, `F451_OIDC_ISSUER` + zugehörige Client-Werte, `F451_FORGEJO_URL`, `F451_TOKEN_KEY`; siehe `apps/api/src/server.ts`).
- Web: `pnpm --filter @f451/web dev` — liest `API_URL` (Default `http://localhost:3001`) und proxyt `/api`, `/auth`, `/admin`, `/media` an die API. Läuft auf http://localhost:3000.

### End-to-End-Test (Playwright)

Der komplette Lese-Flow (Login über Mock-IdP → Seitenbaum → Seite mit ToC/Bild → ⌘K-Suche → Logout-Gate, `e2e/lese-ui.spec.ts`), der komplette Editor-Flow (Bearbeiten-Zyklus mit Autosave/Moduswechsel/Verwerfen, Slash-Menü + Wikilink-Autocomplete, Media-Upload, Moduswechsel-Schutz, Responsive — `e2e/editor.spec.ts`, Phase 2c) UND der komplette Workflow (Entwurf → Review anfordern → Freigeben & mergen mit einer ECHTEN zweiten Identität, Leseansichts-Hinweise, Konflikt-Auflösung, Neue Seite, Responsive, Reset-Recovery — `e2e/workflow.spec.ts`, Phase 2d) laufen vollautomatisch gegen einen frisch hochgefahrenen Stack (Postgres- + Forgejo-Testcontainer + Mock-IdP + programmatisch gebaute API + `next dev`):

```
export DOCKER_HOST='unix:///…/podman-machine-default-api.sock'   # bei Podman
export TESTCONTAINERS_RYUK_DISABLED=true                          # bei Podman
pnpm --filter @f451/web test:e2e
```

`e2e/setup/start-stack.ts` startet und seedet den Stack, `playwright.config.ts` fährt ein Chromium-Projekt gegen http://localhost:3000. Der Browser wird aus dem lokalen `ms-playwright`-Cache genutzt (nichts wird zusätzlich installiert). In CI läuft der E2E-Job nur bei `workflow_dispatch` mit Eingabe `run_e2e`. Details zum Editor-Stack (zweiter Forgejo-Nutzer mit echtem Collaborator-Schreibrecht statt Admin-Token, HTML-Seed-Seite): [apps/web/README.md](../apps/web/README.md) Abschnitt „End-to-End-Tests".

## Editor-Kern (Phase 2b, abgeschlossen)

`@f451/editor` (`packages/editor/`) ist der headless ProseMirror/Tiptap-Kern des
kommenden WYSIWYG-Editors: Schema (`getEditorSchema`), Markdown&harr;ProseMirror-
Konverter (`markdownToDoc`/`docToMarkdown`) und die Validierungs-API
`checkEditorSupport`, die vor einem Moduswechsel prüft, ob ein Dokument
verlustfrei editierbar ist (`unsupported` verweigert den Wechsel, `normalization`/
`frontmatter` sind reine Warnungen). Eine Markdown-Wahrheit: Parsen/Serialisieren
laufen ausschließlich über `@f451/markdown` (`parseMarkdownTree`/
`stringifyMarkdown`), kein eigener zweiter Markdown-Prozessor. Der komplette
Golden-Korpus aus `@f451/markdown` roundtrippt byte-identisch
(`docToMarkdown(markdownToDoc(body)) === body`). Details, API-Referenz und die
„nicht unterstützt"-Liste: [packages/editor/README.md](../packages/editor/README.md).

## Editor-UI (Phase 2c, abgeschlossen)

Phase 2c ist **abgenommen**: der `@f451/editor`-Kern aus Phase 2b ist jetzt eine
vollständige Bearbeiten-Ansicht (`/wiki/[space]/[pageId]/edit`, `apps/web`).

Was läuft:

- **Tiptap-WYSIWYG** mit Formatier-Toolbar, `/`-Befehlsmenü (Überschriften,
  Listen, Tabelle, Codeblock, Zitat, fünf Hinweisbox-Typen, Trennlinie, Bild),
  `[[`-Wikilink-Autocomplete (durchsucht main UND Draft-Index, Draft-Treffer
  gewinnen) und Media-Upload per Drop/Paste/Dateidialog.
- **Roh-Modus** (CodeMirror 6) für das volle Dokument inkl. Frontmatter — mit
  debouncter Live-Validierung (`checkEditorSupport`) und Sprung-Navigation aus
  dem Befund-Panel.
- **Moduswechsel-Schutz:** `canEdit:false` (rohes HTML, Fußnoten, …) erzwingt
  den Startmodus Roh-Text; ein späterer Wechsel zurück zu WYSIWYG läuft über
  dieselbe Validierung — verweigert mit Begründung, warnt vor stiller
  Normalisierung, oder wechselt direkt (drei Ausgänge, s.
  [apps/web/README.md](../apps/web/README.md) Abschnitt „Moduswechsel-Regeln").
  Fußnoten unterstützt der WYSIWYG-Editor seit 1.2.9; Seiten mit Fußnoten
  öffnen wieder visuell.
- **Autosave** (30 s Debounce, ⌘S/Moduswechsel/Verlassen flushen sofort),
  **409-Konflikt-Dialog** (kein stilles Überschreiben) und ein **Soft-Lock**
  (Besitz userId-basiert, 2-min-TTL, Heartbeat, „Trotzdem bearbeiten" für den
  bewussten Zweiteinstieg) — Verträge im Detail: [apps/web/README.md](../apps/web/README.md)
  Abschnitt „Editor (Phase 2c)".
- **Design-Treue:** Klassenvokabular und Token-Farben aus `docs/design/mockups/editor.html`,
  Light+Dark, kein horizontaler Scroll bei 390 px (automatisiert per E2E-Flow).

Vollständiger Schreibzyklus (Seite → Bearbeiten → Änderung → Autosave-Commit
mit echter Nutzer-Autorschaft auf `draft/<pageId>` → Verwerfen räumt Branch,
Index und Lock) sowie alle fünf Editor-E2E-Flows: [apps/web/README.md](../apps/web/README.md)
Abschnitt „End-to-End-Tests".

## Workflow (Phase 2d, abgeschlossen)

Phase 2d ist **abgenommen**: eine Seite lässt sich im Browser vollständig von
Entwurf bis Freigabe führen (`e2e/workflow.spec.ts` Flow 1) — die Zustände
selbst werden dabei NIRGENDS separat gepflegt: `working`/`review` leiten sich
allein aus Branch-Existenz + offener-PR-Suche ab (`apps/api/src/drafts/lifecycle.ts`),
`released` ist schlicht der `main`-Stand. Kein neues Status-Feld in der DB.

Was läuft:

- **Review anfordern → visueller Diff → Freigeben & mergen** — Statuszeile im
  Editor (`StatusBar`), Review-Ansicht `/wiki/[space]/[pageId]/review` mit
  blockweisem Diff (Tabs Visuell/Markdown, Wort-Diff auf der Markdown-Quelle,
  `@f451/markdown#diffMarkdown`), „Freigeben & mergen" (inkl. synchronem
  Cleanup: Branch weg, Index aktuell, KEIN Warten auf den Webhook) und
  „Änderungen anfragen".
- **Konflikt sichtbar, nie stiller Verlust** — läuft `main` seit Review-Beginn
  auseinander, blockiert eine Notice den Merge-Button sichtbar (nicht nur
  disabled ohne Erklärung); „Entwurf aktualisieren" bietet „main übernehmen"
  (explizite, bestätigte Wahl) oder „Meine Fassung behalten" (bewahrt den
  Text beweisbar, warnt vor Media-Verlust). Ein fehlschlagender Reset
  („Auf letzte Freigabe zurücksetzen") verliert den zuletzt bearbeiteten
  Inhalt ebenfalls nie — ein Recovery-Dialog zeigt ihn und erlaubt die
  Übernahme in den Editor.
- **Rechte geerbt, nicht dupliziert** — kein eigenes Merge-Recht-Feld im Code;
  ein Provider-`403` beim Merge-Versuch selbst IST die Freigabe-Recht-Antwort
  (Spec §7).
- **„+ Neue Seite"** legt eine Draft-only-Seite an (kein main-Commit vor dem
  ersten Release) — Titel + sichtbare Eltern-Wahl, Editor öffnet direkt mit
  `# <Titel>`.

Details, Endpunkt-Referenz und bekannte Vereinfachungen der Diff-Engine:
[apps/api/README.md](../apps/api/README.md) Abschnitt „Workflow-API";
UI-Verträge (Chips/Notices, Review-Seite, Reset-Recovery):
[apps/web/README.md](../apps/web/README.md) Abschnitt „Workflow (Phase 2d)";
alle sechs Workflow-E2E-Flows (inkl. der zwei-Identitäten-Mechanik):
[apps/web/README.md](../apps/web/README.md) Abschnitt „End-to-End-Tests".

## Vorlagen (Phase 3c)

Vorlagen pro Space (`_templates/`) und optional global; „Neue Seite" füllt `{{titel}}`/`{{autor}}`/`{{datum}}`; „Als Vorlage speichern" im Editor.

## YouTube-Embeds (Phase 3d)

YouTube-URLs allein auf einer Zeile werden in der Leseansicht als Player eingebettet (youtube-nocookie, Thumbnail zuerst) — außerhalb der Plattform bleiben sie klickbare Links.

## Resilienz (Phase 4b)

Editor-Änderungen überleben Störungen, statt verloren zu gehen: ein scheiternder Autosave puffert lokal (`localStorage`, Statusband „Änderungen lokal — Server nicht erreichbar") und schiebt automatisch nach, sobald Server/Provider wieder erreichbar sind; ein Session-Widerruf während einer Änderung führt über Re-Login zurück zum gepufferten Stand (Recovery-Dialog: Übernehmen/Verwerfen); ein abgelaufenes Provider-Token wird serverseitig automatisch per Refresh erneuert (ein Versuch, sonst Re-Login-Fallback). Details: [apps/web/README.md](../apps/web/README.md) Abschnitt „Offline-Puffer + Recovery", [apps/api/README.md](../apps/api/README.md) Abschnitt „Auth" („Provider-Token-Refresh"), das Störungs-Drehbuch als automatisierte E2E-Flows (`e2e/resilienz.spec.ts`).

## Tests

Die Testcontainers-Tests benötigen eine laufende Container-Runtime (z. B. Docker Desktop oder Podman). Bei Verwendung von Podman anstelle von Docker Desktop muss zusätzlich `TESTCONTAINERS_RYUK_DISABLED=true` gesetzt werden, da Ryuk den Podman-Socket nicht mounten kann.
