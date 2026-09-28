# @f451/web

Next.js-App-Router-Frontend der f451-Wiki-Plattform: Login-Gate, Seitenbaum,
gerenderte Wiki-Seiten, ⌘K-Suche — und seit Phase 2c der WYSIWYG-/Markdown-
Editor. Server Components laden über `lib/api.ts` direkt gegen `API_URL`
(Cookie als expliziter Parameter); Client-Inseln (Editor, Suche, Kontomenü)
fetchen relativ über die Next-Rewrites (`next.config.ts`: `/api`, `/auth`,
`/admin`, `/media` → API) mit `credentials: 'same-origin'`.

## Module

- **`app/`** — App-Router-Routen: `/` (Login), `/wiki`, `/wiki/[space]`,
  `/wiki/[space]/[pageId]` (Leseansicht), `/wiki/[space]/[pageId]/edit`
  (Editor, Phase 2c), `/einstellungen` (Provider-Verknüpfung).
- **`components/`** — Server- und Client-Komponenten der Leseansicht
  (`page-view.tsx`, `tree.tsx`, `rail.tsx`, `search-dialog.tsx`,
  `account-menu.tsx`) sowie `components/editor/` (Phase 2c, s. u.).
- **`lib/`** — `api.ts` (Server-seitiger API-Client), `urls.ts` (zentrale
  URL-Helfer — JEDE Wiki-/Media-URL läuft darüber, s. dortiger Kommentar zu
  Fallback-Ids mit Slashes/Doppelpunkt), `page-view.ts`/`snippet.ts`/`session.ts`
  sowie `lib/editor/` (Phase 2c, s. u.).
- **`e2e/`** — Playwright-End-to-End-Tests gegen den echten Stack, s.
  „End-to-End-Tests" unten.

## Editor (Phase 2c)

Der Editor ist EINE Client-Insel (`components/editor/editor-root.tsx`,
`'use client'`), server-seitig nur über `app/wiki/[space]/[pageId]/edit/page.tsx`
eingebettet (lädt Titel/Breadcrumb über die normale Lese-API, main-Ref — der
eigentliche Draft-Inhalt kommt ausschließlich über Client-Fetches, s.
`apps/api/README.md` Abschnitt „Draft-API").

### Client-Insel-Architektur

```
EditorRoot                    lädt den Draft (createDraft), entscheidet den
  └─ EditorSession             Startmodus (checkEditorSupport), trägt
       ├─ StatusBar            Autosave/Lock/Konflikt/Moduswechsel (Task 4/6)
       ├─ LockBanner           für GENAU einen geladenen Draft-Stand — neu
       ├─ WysiwygEditor        gemountet über key={draft.branch}, s. Kommentar
       │    ├─ EditorToolbar   dort (sauberer Remount statt manuellem Reset
       │    └─ (Tiptap)        von Autosave-Instanz/baseSha/Lock-Status nach
       │       ui-extensions:  einem Fehler-Retry).
       │       Slash-Menü,
       │       [[-Autocomplete,
       │       Media-Upload,
       │       Table-Guard
       ├─ RawEditor            CodeMirror 6, VOLLES Dokument inkl.
       │    (im Roh-Modus)     Frontmatter — der einzige Frontmatter-Editor
       ├─ ModeSwitch           in 2c (Tab-Umschalter + Normalisierungs-Dialog)
       ├─ FindingsPanel        Validierungsbefunde (checkEditorSupport)
       └─ ConflictDialog       409-Zusammenführungsansicht
```

`EditorRoot` selbst trägt nur den Ladezustand (`loading`/`error`/`ready`);
die gesamte Session-Verdrahtung lebt in `EditorSession`, damit ein erneuter
`load()` (Fehler-Retry) über den `key`-Remount immer einen sauberen Zustand
bekommt statt jedes Session-Feld einzeln zurückzusetzen.

Reine Logik-Module (kein React/DOM, `lib/editor/*.test.ts`, node-vitest):
`autosave.ts` (State-Machine), `mode-switch-core.ts` (`evaluateModeSwitch`),
`client-api.ts` (Fetch-Wrapper), `table-guard.ts` (ProseMirror-Plugin +
reiner Enter-Command), `slash-items.ts`/`wiki-suggest.ts`/`paste-rules.ts`
(Filter-/Merge-/Klassifikationslogik der drei Suggestion-Flows), `upload-queue.ts`
(Reducer für parallele Uploads), `frontmatter-offset.ts` (Zeilen-Offset
zwischen `checkEditorSupport`s body-relativen Zeilen und den vollen
Dokumentzeilen des Roh-Modus/Findings-Panels), `diagram.ts`/`diagram-versions.ts`
(Pfad-/Slug-Helfer bzw. Versionszähler für Diagramm-Bilder, s. „Diagramme"
unten), `drawio-protocol.ts` (draw.io-Embed-postMessage-Protokoll, s. dort).
Die DOM-/Tiptap-Verdrahtung
selbst (`ui-extensions.ts`, alle `components/editor/*.tsx`) ist bewusst
NICHT unit-getestet — React-Popups + ihr Glue-Code sind Playwright-Terrain
(s. „End-to-End-Tests" unten).

### Autosave-Vertrag (`lib/editor/autosave.ts`)

Reine, node-testbare State-Machine — kein `fetch`/`setTimeout` im Modul
selbst, Zeit kommt immer als `now`-Parameter herein. Zustände:
`idle → dirty(t) → saving → idle | conflict`, plus ein eigener `error`-Zustand
nach 3 Fehlversuchen (exponentieller Backoff 2s/4s/8s).

- **Debounce:** 30 s zwischen letzter Änderung (`onChange`) und automatischem
  Save (`dueAt()`).
- **Sofort-Save (`flushNow`):** ausgelöst bei Moduswechsel (WYSIWYG⇄Markdown),
  ⌘S und beim Verlassen der Seite (Routenwechsel/Tab-Close über
  `pagehide`/`beforeunload`, dort mit `keepalive: true`). Liefert `false`
  (kein Save), solange bereits einer läuft (in-flight-Guard — die Änderung
  bleibt vorgemerkt) oder der Zustand `conflict` ist.
- **`conflict` ist eingefroren:** `dueAt()` liefert `null`, `onChange` ist ein
  No-Op, `flushNow` liefert IMMER `false` — die einzige Fortsetzung ist
  `resolveConflict()` aus dem Konflikt-Dialog heraus („Meine Fassung
  behalten"/„Serverstand übernehmen"). Ohne diese Sperre würde ein globaler
  ⌘S-Handler durch den fokussierten, aber nicht-modalen Konflikt-Dialog
  hindurch bubbeln und einen zweiten Save mit frischem Editor-Inhalt, aber
  altem `baseSha` auslösen.
- **409 (`saveDraft` in `lib/editor/client-api.ts`)** ist ein diskriminiertes
  Ergebnis (`{ok:false, conflict:{currentSha, currentContent}}`), KEIN Wurf —
  `editor-root.tsx` baut daraus `ConflictDialog`. Kein Pfad überschreibt je
  still den Serverstand.

### Offline-Puffer + Recovery (Phase 4b, Spec §9/§11)

Der Autosave-Fehlversuch (Backoff-Endzustand `error`, s. o.) puffert den
zuletzt getippten Stand zusätzlich lokal, statt ihn nur im React-State zu
halten — ein Tab-Close/Reload während einer Störung verliert ihn sonst.

- **`lib/editor/offline-buffer.ts`** (reines, DOM-freies Modul):
  `writeOfflineDraft`/`readOfflineDraft`/`clearOfflineDraft` legen unter dem
  Schlüssel **`f451.offline.<pageId>`** in `window.localStorage` ein
  `OfflineDraft` ab (`content` volles Markdown inkl. Frontmatter, `baseSha`,
  `branch`, `savedAt`). Zugriffe sind vollständig try/catch-geschützt (Safari-
  Private-Mode, Quota, korrupter Eintrag) — ein Storage-Ausfall degradiert nie
  zum Absturz, sondern zum `error`-Zustand ohne Puffer.
- **Statusband:** der `saving`-Zustand aus dem 3.-Backoff-Versuch bekommt hier
  einen eigenen Zwischenschritt — solange der Autosave noch NICHT den
  `error`-Endzustand erreicht hat, ABER bereits ein Netzwerk-/5xx-/
  Session-Fehler auftrat und die Pufferung gelang, zeigt die Statuszeile
  (`components/editor/status-bar.tsx`) den byte-exakten Wortlaut
  **„Änderungen lokal — Server nicht erreichbar"** (Gedankenstrich U+2014,
  KEIN Bindestrich) statt „Änderungen nicht gespeichert". Aus diesem Zustand
  heraus ist ein manueller ⌘S (`flushNow`) immer als Retry erlaubt; gelingt
  er, räumt der Erfolgspfad in `editor-root.tsx#saveContent` den Puffer.
  Ein `SessionExpiredError` (401 vom Server) puffert genauso wie ein
  Netzwerk-/5xx-Fehler — der Editor-Inhalt überlebt damit auch einen
  Session-Widerruf, s. u.
- **Mount-Recovery (`OfflineRecoveryDialog`, `lib/editor/offline-recovery.ts`):**
  findet `editor-root.tsx#load` beim Öffnen eines Entwurfs einen Puffer-
  Eintrag, wird er NIE still eingespielt — `evaluateOfflineRecovery` prüft
  erst, ob der gepufferte Inhalt überhaupt vom frisch geladenen
  Server-Stand abweicht (identisch → still geräumt, kein Dialog). Weicht er
  ab, zeigt ein natives `<dialog>` (kein Escape-/Backdrop-Schließen — die
  einzigen beiden Wege heraus sind die beiden Buttons) Zeitstempel und, falls
  der Puffer von einem inzwischen anderen Draft-Branch stammt, einen
  Fremd-Branch-Hinweis:
  - **„Übernehmen"** übernimmt den gepufferten Inhalt in den Editor (dirty,
    der Puffer selbst bleibt bis zum nächsten erfolgreichen Save bestehen).
  - **„Verwerfen"** räumt den Puffer endgültig, der Editor bleibt beim
    Server-Stand.
- **Session-Widerruf → Re-Login-Fallback:** trifft ein Autosave auf einen 401
  (Session/Cookie weg), navigiert `lib/editor/client-api.ts` selbst zur
  Login-Seite mit `?next=` zurück auf die Edit-Route — der Offline-Puffer
  wurde davor bereits geschrieben. Nach erfolgreichem Re-Login landet die
  Login-Transaktion automatisch wieder auf derselben Edit-Route, wo der
  Mount-Recovery-Dialog den geretteten Stand anbietet (s. o.). Analog dazu
  löst ein 401 VOM GIT-PROVIDER (nicht von der eigenen Session) serverseitig
  genau einen automatischen Token-Refresh + Retry aus, bevor der Client
  überhaupt etwas davon merkt — s. `apps/api/README.md` Abschnitt
  „Provider-Token-Refresh".

### Lock-Vertrag (Soft-Lock, `EditorSession` in `editor-root.tsx`)

Reiner Hinweis-Charakter (blockiert nie hart), Besitz **userId-basiert**
(nicht Anzeigename — zwei Konten mit demselben Namen konnten sich sonst
gegenseitig Locks „stehlen", s. `apps/api/README.md`), TTL 2 min
(`LOCK_TTL_MS`, API-seitig).

- **Einstieg:** `entryGateActive` startet synchron aus der `createDraft`-Antwort
  (kein Warten auf den ersten Heartbeat-Roundtrip — vermeidet einen kurzen
  „editierbar"-Flackerer). Hält ein ANDERER Nutzer einen frischen Lock, startet
  der Editor readonly, `LockBanner` zeigt „Trotzdem bearbeiten" — ein Klick
  schaltet bewusst frei (`handleOverride`), KEIN automatisches Übernehmen.
- **Heartbeat:** alle 45 s (`HEARTBEAT_INTERVAL_MS`, deutlich unter der
  2-min-TTL, damit Latenz zwischen zwei Heartbeats den eigenen Lock nie
  ablaufen lässt), läuft NICHT solange `entryGateActive` gilt. Ein fehlgeschlagener
  Heartbeat blockiert nichts (reiner Hinweis) — der nächste Intervall-Tick
  versucht es erneut.
- **Verlassen gibt den Lock frei** — bei echtem React-Unmount (Routenwechsel)
  UND bei `pagehide`/`beforeunload` (Tab-Close, kein React-Unmount). **Bugfix
  (Phase 2c Task 7, per E2E gefunden):** dieser Release-Effect darf NUR an
  `pageId` hängen, nicht an `saveContent`/`readCurrentContent` — letztere sind
  über `mode` gekoppelt (`readCurrentContent` hängt direkt von `[mode]` ab),
  ein Moduswechsel hätte sonst bei JEDEM Wechsel WYSIWYG⇄Markdown einen
  Effect-Teardown samt `releaseLock` ausgelöst (der eigene Lock wäre beim
  bloßen Umschalten des Editor-Modus verloren gegangen — Spec: „Verlassen
  gibt ihn frei", nicht „Moduswechsel"). Die beiden Callbacks werden dafür
  über Refs referenziert (immer aktuell, ohne im Dependency-Array zu stehen).

### Moduswechsel-Regeln (`lib/editor/mode-switch-core.ts`)

- **WYSIWYG → Markdown:** immer erlaubt, `flushNow` läuft VOR dem Wechsel.
- **Markdown → WYSIWYG:** über `evaluateModeSwitch(fullMarkdown)`
  (baut auf `checkEditorSupport` aus `@f451/editor` auf, „wirft nie"), drei
  Ausgänge:
  1. `allowed:false` — mindestens ein nicht abbildbarer Knoten (rohes HTML,
     Fußnoten, Referenz-Links/-Bilder/-Definitionen). Der Wechsel wird
     VERWEIGERT, der WYSIWYG-Tab bleibt inaktiv (mit Begründung im
     Tab-`title`), das Befund-Panel öffnet mit der vollen Liste.
  2. `allowed:true, needsConfirmation:true` — jeder Knoten ist abbildbar, aber
     der Roundtrip verändert Bytes (andere Bullet-Zeichen, Setext- statt
     ATX-Headings, …). Ein Bestätigungsdialog zeigt `canonicalBody` VOR jedem
     Verlust; erst nach „Normalisieren und wechseln" wird übernommen.
  3. `allowed:true, needsConfirmation:false` — kanonisch oder nur
     `frontmatter`-Befunde (der WYSIWYG-Editor rührt das Frontmatter ohnehin
     nicht an) — direkter Wechsel.

  Startmodus (`EditorRoot`): `canEdit:false` erzwingt den Roh-Modus beim
  ersten Laden — derselbe `checkEditorSupport`-Report, den `evaluateModeSwitch`
  intern für spätere Wechsel nutzt.
- **Tabellenzellen können UI-seitig keinen zweiten Block aufnehmen**
  (`lib/editor/table-guard.ts`): Enter in einer Zelle springt zur nächsten
  Zelle statt den Absatz zu splitten, ein `filterTransaction`-Sicherheitsnetz
  verwirft jede Transaktion, die trotzdem eine ≠1-Block-Zelle erzeugt (Paste,
  Markdown-Shortcuts, Drag&Drop). Der 2b-Hard-Throw in `docToMarkdown` (mehr
  als ein Block/Nicht-Absatz-Block in einer Zelle) ist dadurch im UI-Betrieb
  unerreichbar — von `editor.spec.ts` (Flow 2) als Regressionsschutz bewiesen.

### Media-Upload

Toolbar-Button/Slash-Item „Bild" triggern denselben Custom-Command
(`editor.commands.triggerImageUpload()`) wie ein Drop/Paste-Event den
Upload-Pfad — beide landen in `wysiwyg-editor.tsx#handleImageFiles`
(sequenziell hochgeladen, Fehler GESAMMELT statt überschrieben,
`lib/editor/upload-queue.ts`). Anzeige im Editor läuft über
`?ref=draft` (`GET /media/:pageId/*`, s. `apps/api/README.md`), damit frisch
hochgeladene Bilder rendern, bevor der Draft gespeichert ist.

**Bugfix (Phase 2c Task 7, per E2E gefunden):** `lib/urls.ts#mediaHref` hängte
das `_media/`-Präfix der Markdown-Bildreferenz (`_media/diagramm.png`)
UNVERÄNDERT an den URL-Pfad an — die Server-Route baut den Git-Pfad aber
bereits selbst als `<Seitenordner>/_media/<Wildcard>`, ein verbliebenes
Präfix ergab serverseitig ein doppeltes `_media/_media/…` und damit einen
404 (weder das Seed-Bild noch ein frisch hochgeladenes Draft-Bild luden im
Editor). `mediaHref` entfernt das führende `_media/`-Segment jetzt, bevor es
den URL-Pfad baut — konsistent zum Bild-Src-Rewriting der Leseansicht
(`apps/api/src/indexer/index-space.ts`), das denselben Server-Vertrag
korrekt bedient.

### Diagramme (Phase 3e)

Bild-Nodes mit `src`-Endung `.drawio.svg`/`.excalidraw.svg` (`lib/editor/diagram.ts#diagramKind`)
rendern in der NodeView (`ui-extensions.ts`) mit einem schwebenden „Diagramm
bearbeiten"-Button statt als einfaches `<img>` — in der Leseansicht (reines
Markdown-Rendering, keine ProseMirror-NodeView) bleibt es dagegen ein
gewöhnliches Bild ohne Button. Die Slash-Items „draw.io-Diagramm"/„Excalidraw"
fragen per `window.prompt` einen Namen ab (transliteriert/slugifiziert via
`diagramSlug`) und legen einen neuen `_media/<slug>.drawio.svg`bzw.
`_media/<slug>.excalidraw.svg`-Eintrag an (`ifAbsent`-Save — ein Namenskonflikt
zeigt „Eine Datei mit diesem Namen existiert bereits." im Dialog, der Dialog
bleibt offen); „Diagramm bearbeiten" öffnet denselben Dialog im
Überschreiben-Modus für das bestehende Bild. Beide Dialoge sind natives
`<dialog class="diagram-dialog">` (kein Mockup-Vorbild).

`components/editor/drawio-dialog.tsx` bettet einen **selbst gehosteten**
draw.io-Editor per `<iframe>` ein (Embed-Modus, `proto=json` — s.
`lib/editor/drawio-protocol.ts` für das reine, DOM-freie postMessage-Protokoll;
`noSaveBtn=1` macht „Save & Exit" den einzigen Speichern-Weg, dessen `save`-
Event laut Beobachtung gegen den echten `jgraph/drawio`-Container KEIN
`exit`-Feld trägt — ein fehlendes Feld gilt deshalb als `exit:true`). Die
iframe-URL kommt aus `NEXT_PUBLIC_DRAWIO_URL` (wie `API_URL` eine
BUILD-Zeit-Variable, s. `Dockerfile`/`deploy/wiki/docker-compose.yml`) — im
lokalen Dev-Betrieb ohne gesetzte Variable fällt sie auf das öffentliche
`https://embed.diagrams.net` zurück. Im Compose-Deploy läuft stattdessen der
`drawio`-Service (`jgraph/drawio`, Port 8081) — `deploy/wiki/.env.example`
setzt `NEXT_PUBLIC_DRAWIO_URL=http://localhost:8081` als Beispielwert; die
URL muss vom BROWSER aus erreichbar sein (anders als `API_URL`, das den
internen Docker-Netzwerknamen der `api` nutzt).

`components/editor/excalidraw-dialog.tsx` bettet **`@excalidraw/excalidraw`
als echte React-Komponente** ein (kein externer Dienst, kein iframe) —
`lib/editor/excalidraw-io.ts` exportiert die Szene über `exportToSvg` MIT
eingebetteter Szene (`exportEmbedScene: true`, IMMER gesetzt, auch bei einer
leeren Szene) als SVG-Text mit `<!-- payload-… -->`-Kommentaren, die
`sanitizeSvg` (`apps/api`, Phase-1-Sanitizer) ausdrücklich erhält — ohne diese
Kommentare wäre eine gespeicherte `.excalidraw.svg` nicht mehr über
`loadFromBlob`/`sceneFromSvgText` re-editierbar. „Speichern und schließen"
schließt den Dialog immer bei Erfolg (kein optionales `exit`-Flag wie bei
draw.io).

## Workflow (Phase 2d)

Die Leseansicht und der Editor tragen seit Phase 2d den kompletten
Freigabe-Workflow (Spec §4/9) — die UI leitet ihn ausschließlich aus dem, was
`apps/api` ableitet (Branch-Existenz + offener-PR-Suche, s. `apps/api/README.md`
Abschnitt „Draft-API (Schreiben)"), **kein eigenes Client-seitiges
Status-Feld**.

- **Chips/Notices in der Leseansicht** (`components/page-view.tsx`): `.chip.rel`
  „Released" (Default, kein Draft), `.chip.work` „Entwurf" (Draft ohne offenen
  PR), `.chip.rev` „In Review" (offener Review-PR), `.chip.arch` „Archiviert".
  `.notice.draft` erscheint zusätzlich für JEDEN Nutzer mit Schreibrecht,
  sobald ein Draft existiert (Text unterscheidet `working`/`review`, Link
  „Entwurf ansehen →" zeigt je nach Zustand auf `/edit` oder `/review`);
  `.notice.lock` zusätzlich, wenn ein ANDERER Nutzer gerade den Draft hält.
- **„+ Neue Seite"** (`components/new-page-button.tsx`, im Kopf des
  Seitenbaums): Dialog mit Titel + sichtbarer Eltern-Wahl (aktuelle
  Seite/Space-Wurzel, kein Baum-Picker — YAGNI). Legt die Seite als
  **Draft-only** an (`POST /api/pages`, s. `apps/api/README.md`) und öffnet
  direkt den Editor mit `# <Titel>` als Startinhalt — die Seite erscheint erst
  nach ihrem ersten Release im Seitenbaum/in der Leseansicht.
- **„Review anfordern"/„Auf letzte Freigabe zurücksetzen"** (`StatusBar`,
  `components/editor/status-bar.tsx`, s. „Editor (Phase 2c)" oben für den
  Rest der Statuszeile): flushen den Autosave sofort (Muster Moduswechsel)
  vor dem jeweiligen Aufruf. Der Reset (`POST /api/pages/:id/draft/update`
  `{strategy:'take-main'}`) hat einen eigenen Fehlerpfad — schlägt er NACH
  dem Verwerfen des alten Branches fehl (`preservedContent` im 502-Body, s.
  `apps/api/README.md` „Content-Verlust-Fenster"), zeigt `ResetRecoveryDialog`
  (`components/editor/reset-recovery-dialog.tsx`) den geretteten Inhalt
  ungekürzt an; „Inhalt in den Editor übernehmen" markiert ihn als
  ausstehende Änderung, der nächste Autosave sichert ihn regulär. Kein
  automatisches `alert()`+Verwerfen — das wäre der stille Verlust, den diese
  Route explizit vermeidet.
- **Review-Seite** (`/wiki/[space]/[pageId]/review`, Server Component
  `app/wiki/[space]/[pageId]/review/page.tsx` + zwei Client-Inseln):
  - `DiffView` (`components/review/diff-view.tsx`) — Tabs „Visuell"/„Markdown"
    (`.viewbar`), visuelle Blöcke aus `GET .../review`s `diff.blocks`
    (`.dchange.add`/`.dchange.chg` für neue/geänderte Blöcke, Wort-Diff via
    `ins.add`/`del.rm` INNERHALB eines geänderten Blocks, `<details
    class="removed">` für entfernte Blöcke — s. `apps/api/README.md`
    „Bekannte Vereinfachungen der Diff-Engine": Wort-Diff läuft auf der
    Markdown-**Quelle**, nicht dem gerenderten Rich-Text). Die Rail
    (`.rail .rsum`) zeigt dieselbe `diff.summary`-Zählung als Badges.
  - `ReviewView` (`components/review/review-view.tsx`) — „Freigeben &
    mergen" (Kommentar optional) und „Änderungen anfragen" (Kommentar
    Pflicht). Ist `pr.mergeable === false`, erscheint `.notice.conflict` und
    der Merge-Button ist `disabled` (mit Begründung im `title`) — „Entwurf
    aktualisieren" öffnet einen Strategie-Dialog (`.update-strategy-dialog`,
    identisches Baustein-Muster wie `ConflictDialog` im Editor): „main
    übernehmen" (`take-main`, verwirft den Draft komplett) oder „Meine
    Fassung behalten" (`keep-mine`, behält den Text, warnt vor Media-Verlust
    falls zutreffend) — danach `router.refresh()`, ein frischer Server-Stand
    setzt einen client-seitigen Konflikt-Override IMMER zurück (nie ein
    veralteter Zustand nach der Aktualisierung).
  - Ein Provider-`403` beim Merge-Versuch selbst ist die vollständige
    Berechtigungsantwort (kein eigenes Freigabe-Recht-Feld, Spec §7) — die UI
    zeigt ihn als generische Fehlermeldung, keine gesonderte
    Nicht-berechtigt-Ansicht.
  - **Fix (Task 8, per E2E gefunden):** nach erfolgreichem Merge folgt auf
    `router.push(wikiPageHref(...))` zusätzlich `router.refresh()` — die
    Space-Layout-Route (Seitenbaum) sitzt im selben Next-Router-Segment-Baum
    wie `/review` und die Leseansicht; ein reiner `push` behielt deren
    gecachten Stand bei (App-Router-Soft-Navigation), eine GERADE ERST über
    diesen Weg gemergte neue Seite (Draft-only, „+ Neue Seite") erschien im
    Seitenbaum deshalb nicht, solange derselbe Tab ohne harten Reload
    weiterlief.

## Security-Header (Phase 4a Task 4)

Die `Content-Security-Policy` (Spec §7: iframes NUR draw.io-Embed und
youtube-nocookie) baut **`middleware.ts`** pro Request mit einem frischen
Nonce (offizielles Next-App-Router-CSP-Muster); die request-unabhängigen
Header `X-Content-Type-Options: nosniff`/`Referrer-Policy: same-origin`
setzt weiterhin `next.config.ts`s `headers()` — sie gehören auch auf die
`_next/static`-Asset-Antworten, die der Middleware-Matcher bewusst ausnimmt.

```
default-src 'self'; script-src 'self' 'nonce-<per-Request>'
  [Dev: + 'unsafe-eval']; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://i.ytimg.com;
  frame-src https://www.youtube-nocookie.com <drawio-Origin>;
  connect-src 'self' [Dev: + ws:]; font-src 'self' data:;
  worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self';
  form-action 'self'
```

- **Warum Nonce statt Hash** (Fix-Runde 1, Review-Blocker): der App Router
  streamt seine Hydration-Payload über PER-REQUEST-GENERIERTE Inline-Skripte
  (`self.__next_f.push(...)`) — ein zur Build-Zeit fixierter sha256-Hash kann
  sie prinzipiell nicht abdecken, eine statische Hash-CSP blockt damit JEDE
  Hydration. Die Middleware legt die Nonce-CSP in die REQUEST-Header (daraus
  liest Next den Nonce und hängt ihn automatisch an alle EIGENEN
  Inline-Skripte) und in die RESPONSE-Header (die durchgesetzte CSP); das
  Inline-Theme-Script (`app/layout.tsx`, `NO_FLASH_THEME` — setzt `data-theme`
  VOR dem ersten Paint gegen FOUC) liest den Nonce aus dem
  `x-nonce`-Request-Header via `headers()`. Das macht alle Routen dynamisch —
  eine per-Request-CSP schließt statisches Prerendering des Dokuments
  prinzipbedingt aus (alle Seiten-Routen waren es ohnehin).
- **`frame-src`**: `https://www.youtube-nocookie.com` (fest, s.
  `lib/youtube.ts#youtubeEmbedSrc`) plus die draw.io-Origin — hergeleitet aus
  `NEXT_PUBLIC_DRAWIO_URL` mit demselben Fallback wie
  `lib/editor/drawio-protocol.ts#drawioBaseUrl()` (`https://embed.diagrams.net`
  ohne gesetzte Variable; die zweizeilige Fallback-Logik ist bewusst
  dupliziert, beide Stellen kommentieren aufeinander). **Kopplung**: ändert
  sich `NEXT_PUBLIC_DRAWIO_URL` (z. B. Compose-Deploy gegen den
  `drawio`-Service, s. „Diagramme" oben), MUSS die Variable zur Build-Zeit
  gesetzt sein (`NEXT_PUBLIC_*` wird beim Build in die Middleware inline
  kompiliert), sonst blockt `frame-src` das echte draw.io-iframe.
  **Fail-Fast**: ein nicht als URL parsbarer Wert lässt `new URL()` beim
  Middleware-Init werfen — die App startet dann gar nicht erst mit einer
  kaputten CSP.
- **`img-src … https://i.ytimg.com`**: YouTube-Vorschaubilder
  (`packages/markdown/src/render.ts`, `i.ytimg.com/vi/<id>/hqdefault.jpg`) —
  „Thumbnail zuerst, iframe erst per Klick" (Phase 3d).
- **Dev-Abweichung** (`NODE_ENV !== 'production'`): NUR `'unsafe-eval'` in
  `script-src` (Webpacks HMR-Runtime/React Refresh nutzt `eval()`/`new
  Function()`) und `ws:` in `connect-src` (HMR-WebSocket) — empirisch
  kalibriert gegen `next dev` + Playwright-Konsolen-Probe. KEIN
  `'unsafe-inline'`: mit Nonce-CSP im Request versieht Next auch im Dev-Modus
  alle eigenen Inline-Skripte mit dem Nonce. Die CSP ist im Dev-/E2E-Betrieb
  AKTIV (kein Bypass) — die volle E2E-Suite läuft unter derselben Härte wie
  Produktion, abzüglich dieser beiden HMR-Lockerungen.
- **Rewrites bleiben unberührt**: der Middleware-Matcher nimmt
  `/api`/`/auth`/`/admin`/`/media` (und `_next/static`/`_next/image`) aus —
  die Rewrites proxien direkt zur API durch, diese Antworten tragen NICHT die
  Web-CSP, sondern die eigenen API-Header (`apps/api/src/app.ts`s globaler
  `onSend`-Hook bzw. `routes/media.ts`s sandboxte `Content-Security-Policy`,
  s. `apps/api/README.md`).

## End-to-End-Tests (Playwright)

`e2e/lese-ui.spec.ts` (Phase 1e) deckt die vier Lese-Flows ab (Login-Gate →
Mock-IdP-Login, Seitenbaum → Seite mit ToC/Bild, ⌘K-Suche, Logout-Gate).
`e2e/editor.spec.ts` (Phase 2c Task 7) deckt den Editor ab, serielle Flows
gegen denselben Stack:

1. **Bearbeiten-Zyklus** — Login → Seite → „Bearbeiten" → tippen →
   Moduswechsel zu Markdown (flusht den Save) → Draft-API zeigt den
   getippten Text UND `lock.mine === true` → zurück zu WYSIWYG → „Entwurf
   verwerfen" → Leseansicht, Draft-API danach 404.
2. **Slash-Menü + Wikilink-Autocomplete** — `[[`-Auswahl rendert `a.wiki-link`
   und landet als `[[ziel|Alias]]` im gespeicherten Draft; `/`-Menü fügt eine
   Tabelle ein; Enter in einer Zelle springt zur nächsten statt einen zweiten
   Block im selben Feld zu erzeugen; das `/`-Menü erscheint NICHT innerhalb
   einer Tabellenzelle (Regressionsschutz für ein Review-Finding aus Task 5).
3. **Media-Upload** — der Toolbar-Button öffnet den ECHTEN Datei-Dialog
   (`page.waitForEvent('filechooser')`, beweist das Trigger-Wiring), das Bild
   lädt über `?ref=draft` und landet als `![](_media/…)` im Draft.
4. **Moduswechsel-Schutz** — eine Seite mit rohem HTML-Block startet im
   Markdown-Modus, der WYSIWYG-Tab ist inaktiv (mit Begründung), das
   Befund-Panel zeigt den Befund.
5. **Responsive** — die Edit-Route erzeugt bei 390×844 keinen horizontalen
   Scroll (erste automatisierte Mockup-Treue-Assertion des Repos).

`e2e/setup/start-stack.ts` seedet dafür einen ZWEITEN Forgejo-Nutzer
(Nicht-Admin, per Collaborator-API mit `write`-Recht auf das Wiki-Repo,
Muster aus `apps/api/test/draft-lifecycle.test.ts`) und verknüpft dessen
Token — NICHT das Admin-Token — mit dem E2E-Nutzer, damit Autosave-Commits
eine echte, vom Repo-Owner unabhängige Autorschaft tragen.

`e2e/workflow.spec.ts` (Phase 2d Task 8) deckt den Workflow von Entwurf bis
Freigabe ab — sechs serielle Flows gegen denselben Stack, auf eigenen,
von `editor.spec.ts` unberührten Seiten (`workflow-*`, s. `start-stack.ts`s
`seedRepo`), damit die Reihenfolge der Spec-Dateien keine Rolle spielt:

1. **Voller Freigabe-Zyklus** — Nutzer A tippt einen Marker in eine
   bestehende Seite → „Review anfordern" → Review-Seite zeigt `.chip.rev`,
   den Marker als `ins.add` im Diff, eine stimmige Rail-Summary → Nutzer B
   (zweite, ECHTE Identität) „Freigeben & mergen" mit Kommentar →
   Leseansicht zeigt den Marker, `.chip.rel`, `GET .../draft` → 404, der
   Draft-Branch ist laut Forgejo-REST weg (Cleanup-Beweis auf zwei Ebenen).
2. **Leseansichts-Hinweise** — nach erneutem Bearbeiten `.notice.draft` +
   `.chip.work` für Autorin A, nach „Review anfordern" `.chip.rev` mit
   Review-Link.
3. **Konflikt-Flow** — ein direkter main-Commit (rohe Forgejo-REST-API,
   Admin/Seed-Token aus dem Stack-State-File) ändert dieselbe Quellzeile wie
   ein offener Draft anders → `.notice.conflict`, Merge-Button disabled →
   „Entwurf aktualisieren" → „Meine Fassung behalten" → Notice verschwindet,
   der eigene Text bleibt im Diff → Freigabe → Leseansicht enthält ihn.
4. **Neue Seite** — „+ Neue Seite" im Baum → Editor öffnet mit `# <Titel>` →
   Review → Freigeben (Nutzer B) → Seite erscheint im Seitenbaum UND in der
   Leseansicht.
5. **Responsive** — die Review-Route erzeugt bei 390×844 keinen
   horizontalen Scroll.
6. **Reset-Recovery** (aus dem Task-6-Review-Ledger nachgetragen, kein
   Brief-Flow) — ein `page.route`-Netzwerk-Stub lässt
   `POST .../draft/update` mit `502` + `preservedContent` fehlschlagen
   (simuliert `DraftUpdateContentLostError`) → `ResetRecoveryDialog` zeigt
   den geretteten Inhalt → „Inhalt in den Editor übernehmen" stellt ihn im
   Editor wieder her.

**Zwei echte Identitäten:** der Mock-IdP kennt normalerweise nur EINE aktive
Identität; `test/helpers/mock-idp.ts` trägt seit diesem Task einen
Test-Kontroll-Endpunkt `POST /test/user`, den `workflow.spec.ts` (eigener
Prozess, kann `start-stack.ts`s Mock-IdP-Instanz nicht direkt importieren)
nutzt, um vor dem zweiten Login auf die Reviewer-Identität umzuschalten — je
ein eigener Browser-Kontext (eigenes Session-Cookie) hält beide Identitäten
danach unabhängig auseinander. Nutzer B ist ein ECHTER zweiter
Forgejo-Collaborator mit Schreibrecht (`start-stack.ts`, analog zum
Autor-Nutzer) — „Freigeben & mergen" ist damit kein Self-Review.

`e2e/diagramme.spec.ts` (Phase 3e Task 6) deckt die Diagramm-Flows ab, gegen
eine eigene Seed-Seite „Architektur" (`start-stack.ts`s `seedRepo`, ein
bereits committetes `.drawio.svg` neben der Seite):

1. **Leseansicht** — das Diagramm rendert als gewöhnliches `<img>`, außerhalb
   des Editors gibt es weder `.diagram-node` noch `.diagram-edit`.
2. **Editor + draw.io** — der Bearbeiten-Button einer bestehenden
   Diagramm-NodeView ist im echten `contentEditable` anklickbar UND öffnet
   den Dialog, OHNE dass der Klick stattdessen (nur) den ganzen Bild-Node per
   `NodeSelection` selektiert (**Bugfix, per diesen Test gefunden**: die
   NodeView ist ein atomarer ProseMirror-Leaf ohne `contentDOM` — ein Klick
   auf den Button löste zusätzlich zum Öffnen auch eine `NodeSelection` aus,
   sichtbar als `ProseMirror-selectednode`-Klasse; behoben über
   `stopEvent: (event) => event.target === button` in `ui-extensions.ts`s
   NodeView). Ein Protokoll-Stub (`page.route` auf die per
   `NEXT_PUBLIC_DRAWIO_URL` konfigurierte Fake-Origin, s. u.) simuliert den
   kompletten init→load→save→export-Zyklus des echten `jgraph/drawio`-
   Containers — inklusive der Beobachtung, dass `save` KEIN `exit`-Feld trägt
   (der Dialog schließt trotzdem, s. oben „Diagramme"). Forgejo-REST
   bestätigt den neuen Inhalt auf dem Draft-Branch.
3. **Excalidraw-Neuanlage** — `/`-Menü → „Excalidraw" → `window.prompt`
   (`page.on('dialog')`) → die ECHTE `@excalidraw/excalidraw`-Komponente lädt,
   ein Rechteck wird tatsächlich gezeichnet (Werkzeug-Klick + Maus-Drag über
   der Canvas — Excalidraws Werkzeugauswahl ist technisch ein
   `<input type="radio" data-testid="toolbar-rectangle">` in einem `<label>`,
   kein `<button>`, und das sichtbare Icon überdeckt den Input selbst; der
   Test klickt deshalb das `<label>`) → „Speichern und schließen" → Forgejo-
   REST bestätigt nicht nur die Existenz der committeten Datei, sondern dass
   sie `payload-type:application/vnd.excalidraw+json` ENTHÄLT (Beweis, dass
   der Server-Sanitizer die Excalidraw-Metadaten erhalten hat) — und der
   Bearbeiten-Button lädt dieselbe Datei danach wieder in einen Excalidraw-
   Canvas, ohne Lade-Fehlerbanner.
4. **ifAbsent-Schutz** — ein zweites „Excalidraw"-Slash-Item mit demselben
   Namen auf derselben Seite löst den 409-Konfliktpfad aus: „Eine Datei mit
   diesem Namen existiert bereits.", der Dialog bleibt offen.

`start-stack.ts` setzt für den `next dev`-Prozess zusätzlich
`NEXT_PUBLIC_DRAWIO_URL=http://127.0.0.1:4599` (ein Port ohne echten Dienst —
der Test fängt jede iframe-Anfrage dorthin per `page.route` ab). Wahl (Flow 3):
ein ECHT gezeichnetes Rechteck statt einer leeren Szene — `exportEmbedScene`
trägt die Sanitizer-Beweis-Kommentare zwar auch bei einer leeren Szene, aber
nur eine echte Zeichen-Interaktion beweist, dass Toolbar/Canvas wirklich
funktionieren.

`e2e/resilienz.spec.ts` (Phase 4b Task 5) deckt das Störungs-Drehbuch aus
`deploy/BETRIEB.md` als automatisiertes Verhalten ab, gegen drei eigene,
von anderen Spec-Dateien unberührte Seiten (`resilienz-1/2/3`):

1. **Offline-Puffer + Nachschub** — ein `page.route`-Stub lässt den
   Autosave-PUT wie einen echten Verbindungsabbruch scheitern
   (`route.abort('connectionrefused')`); die State-Machine durchläuft den
   Backoff bis zum `offline`-Zustand (Statusband exakt „Änderungen lokal —
   Server nicht erreichbar"), der Puffer trägt den getippten Marker unter
   `f451.offline.<pageId>`. Route freigeben + ein zweiter ⌘S räumt den
   Puffer wieder, der Server-Draft enthält den Marker.
2. **Token-Widerruf, Inhalt überlebt** — Text ändern, OHNE vorher zu
   speichern, dann `context.clearCookies()`; der nächste Save trifft auf
   401 → Re-Login-Redirect MIT `?next=` zurück auf die Edit-Route, der
   Puffer wurde davor geschrieben. Nach Re-Login zeigt der
   Mount-Recovery-Dialog den geretteten Stand, „Übernehmen" stellt ihn im
   Editor wieder her, ein regulärer Save danach persistiert ihn und räumt
   den Puffer.
3. **Recovery verwerfen** — ein per `page.evaluate` VOR der Navigation
   präparierter Puffer-Eintrag (mit echtem `branch`/`baseSha` des aktuellen
   Drafts) löst denselben Dialog aus; „Verwerfen" räumt ihn, der Editor
   zeigt weiterhin den unveränderten Server-Stand.

Die Playwright-Suite umfasst damit 35 Tests über sechs Spec-Dateien
(`komfort` 9, `lese-ui` 4, `editor` 6, `workflow` 7, `diagramme` 5,
`resilienz` 4 — jede Spec-Datei zählt ihren eigenen `Login`-Test mit;
`komfort` Flow 9 kam mit Phase 4a Task 4 dazu — Nonce-CSP trägt `frame-src`
für draw.io/youtube-nocookie, keine Violations über die Flows 1–8 hinweg,
s. „Security-Header" oben).

```
export DOCKER_HOST='unix:///…/podman-machine-default-api.sock'   # bei Podman
export TESTCONTAINERS_RYUK_DISABLED=true                          # bei Podman
pnpm --filter @f451/web test:e2e
```

Details zum Stack-Aufbau (Testcontainer, Mock-IdP, `next dev`) s. Root-`README.md`
Abschnitt „End-to-End-Test (Playwright)".
