# Betrieb

Betriebsdoku für das f451-Deployment: Architektur, Umgebungsvariablen, Restore
nach Totalverlust, Störungsverhalten und Monitoring. Zielgruppe: wer den Stack
betreibt (nicht: wer daran entwickelt — dafür `apps/api/README.md` und
`apps/web/README.md`). Alle Angaben sind gegen den Code verifiziert (Grep über
`process.env.F451_*` in `apps/api/src/`), nicht aus `.env.example` abgeschrieben.

## 1. Architektur-Überblick

Zwei Docker-Compose-Stacks, getrennt nach Lebenszyklus und Kritikalität (Spec
§8), davor in Produktion ein Reverse Proxy (Caddy/Traefik) als TLS-Eingang —
der Proxy selbst ist NICHT Teil dieser Compose-Stacks.

1. **`deploy/git/`** — Forgejo (Git-Infrastruktur, Quelle der Wahrheit für
   Wiki-Inhalte). Ein Service (`forgejo`), ein Volume:
   - **`forgejo-data`** — Repos + Forgejo-Konfiguration + Forgejo-eigene
     SQLite-DB. **Das einzige backup-kritische Volume** des gesamten
     Deployments (Spec §8). Ohne Backup dieses Volumes sind Wiki-Inhalte
     unwiederbringlich verloren.

2. **`deploy/wiki/`** — die Anwendung selbst: fünf Services.
   - `web` (Next.js, Build-Zeit-Konfiguration `API_URL`, siehe Abschnitt 2) —
     proxyt `/api`, `/auth`, `/admin`, `/media` intern an `api`, `/drawio`
     an den `drawio`-Container (draw.io-Embed same-origin, siehe Abschnitt 2)
     und `/mcp` an den `mcp`-Container (Abschnitt 8).
   - `api` (Fastify) — Indexierung, Lese-/Schreib-API, Webhooks, Admin-Endpunkte,
     Drift-Job, Session-Sweeper.
   - `postgres` — Index (Seiteninhalt/Suchvektor/Kanten), Sessions,
     Provider-Token (verschlüsselt), Locks. Volume **`pg-data`**.
   - `drawio` (self-hosted draw.io, Phase 3e) — kein persistentes Volume, rein
     zustandslos.
   - `mcp` (MCP-Server für KI-Agenten, Abschnitt 8) — zustandslos, kein Volume,
     **kein Port-Export**; erreichbar ausschließlich über `web` unter `/mcp`.

   **`pg-data` ist NICHT backup-kritisch im selben Sinn wie `forgejo-data`:**
   der komplette Seiteninhalt (Text, HTML, Suchvektor, Kanten) ist reine
   Ableitung aus dem Git-Repo und wird durch `POST /admin/reindex` bzw. den
   Drift-Job aus Forgejo neu aufgebaut (Abschnitt 3). Ein Verlust von `pg-data`
   bedeutet NUR: alle Sessions sind weg (Nutzer müssen sich neu einloggen —
   Sessions sind laut `auth/sessions.ts` ausdrücklich „flüchtige Betriebsdaten"),
   alle offenen Locks sind weg (unkritisch, TTL-basiert), und der Index ist
   leer, bis ein Reindex läuft. Ein Backup von `pg-data` ist trotzdem sinnvoll
   (spart die Reindex-Zeit + verschlüsselte Provider-Tokens der
   Kontoverknüpfung „Forgejo/GitHub verbinden" müssten sonst neu verknüpft
   werden), aber NICHT die einzige Quelle für irgendetwas.

   **The one exception is `user_settings`** (migration 0013, personal themes):
   a user has no Git repository, so this table is the only copy of their
   personal theme. Losing `pg-data` loses every personal theme, like the
   sessions. The backup is the user's own export,
   `GET /api/me/theme?format=yaml` (the settings page's download button); the
   same file goes back in with `PUT /api/me/theme` (`Content-Type:
   application/yaml`).

## 2. Env-Referenz

Vollständig, gegen `apps/api/src/server.ts` (+ `spaces/config.ts`, dorthin
gereicht) verifiziert — jede `F451_*`-Lesestelle im Code hat eine Zeile unten.
Web-seitig gibt es genau EINE `NEXT_PUBLIC_*`-Variable (grep über
`apps/web/{src,middleware.ts,lib}`).

### API (`deploy/wiki/docker-compose.yml`, Service `api`)

| Variable | Pflicht | Default | Wirkung |
|---|---|---|---|
| `DATABASE_URL` | ja (fest im Compose gesetzt, kein Allowlist-Eintrag nötig) | — | Postgres-Verbindung. Ohne sie: `/readyz` → 503, Webhook-/Admin-/Lese-/Schreib-Routen werden gar nicht registriert (Minimalmodus). |
| `F451_SPACES` | nein | — (Minimalmodus) | JSON-Array konfigurierter Spaces. Fehlt sie, laufen nur `/healthz`/`/readyz`. |
| `F451_FORGEJO_URL` | ja, wenn ein Space `provider:"forgejo"` nutzt ODER `F451_FORGEJO_OAUTH_CLIENT_ID` gesetzt ist | — | Basis-URL der Forgejo-Instanz (ohne `/api/v1`). EINE Quelle für Service-Account-Registry, Schreibrechte-Probe UND Nutzer-Provider-Factory. |
| `F451_FORGEJO_TOKEN` | ja, wenn ein Space `provider:"forgejo"` nutzt | — | Service-Account-Token (Indexer liest/schreibt nie als Nutzer). |
| `F451_GITHUB_TOKEN` | ja, wenn ein Space `provider:"github"` nutzt | — | Service-Account-Token für die GitHub-API. |
| `F451_WEBHOOK_SECRET_FORGEJO` | nein, aber ohne sie schlägt JEDE Forgejo-Webhook-Signaturprüfung fehl (401) | — | HMAC-Secret, muss mit dem im Forgejo-Repo hinterlegten Secret übereinstimmen. |
| `F451_WEBHOOK_SECRET_GITHUB` | nein, analog | — | HMAC-Secret für GitHub-Webhooks. |
| `F451_ADMIN_TOKEN` | nein, aber ohne sie sind `POST /admin/reindex` UND `GET /admin/status` fail-closed (503) deaktiviert | — | Bearer-Token für beide Admin-Endpunkte (dasselbe Gate). In Produktion praktisch Pflicht (Restore-Prozedur Abschnitt 3 braucht ihn). |
| `F451_GLOBAL_TEMPLATES` | nein | — | JSON-Objekt `{"provider","owner","repo"}` — providerweites Zusatz-Vorlagen-Repo. |
| `F451_INSTANCE_CONFIG` | no | — (no instance theme, the built-in default applies) | JSON object `{"provider","owner","repo"}` — instance repo holding `_meta/theme.yaml`; may name the same repo as `F451_GLOBAL_TEMPLATES`. Its provider must also be used by a space in `F451_SPACES` (service-account registry). |
| `F451_OIDC_ISSUER` | nein | — (Auth deaktiviert, außer `F451_GITHUB_LOGIN=1` ist gesetzt) | Gesetzt = Auth aktiv (`/api/*`, `/admin/*`, `/media/*` erfordern Session). **Ohne sie UND ohne `F451_GITHUB_LOGIN=1` ist die gesamte API ungeschützt** — in Produktion praktisch Pflicht (mindestens eine der beiden). |
| `F451_TOKEN_KEY` | ja, wenn `F451_OIDC_ISSUER` ODER `F451_GITHUB_LOGIN=1` gesetzt (sonst Fail-Fast beim Start) | — | 32 Byte base64 (`openssl rand -base64 32`), AES-256-GCM-Schlüssel für Provider-Tokens. |
| `F451_OIDC_CLIENT_ID` | ja, wenn `F451_OIDC_ISSUER` gesetzt | — | Entra-App-Registrierung, Client-Id. |
| `F451_OIDC_CLIENT_SECRET` | ja, wenn `F451_OIDC_ISSUER` gesetzt | — | Entra-App-Registrierung, Client-Secret. |
| `F451_OIDC_REDIRECT_URL` | ja, wenn `F451_OIDC_ISSUER` gesetzt | — | `https://<api-host>/auth/callback`, exakt wie bei Entra hinterlegt. |
| `F451_OIDC_PROVIDER_NAME` | nein | — | Name on the sign-in button (`Sign in with <name>`), e.g. `Microsoft Entra`, `Forgejo`. Unset → neutral `Sign in`. |
| `F451_SIGNIN_NOTE` | nein | — | Plain-text note under the sign-in buttons (e.g. demo credentials); `\n` becomes a line break. |
| `F451_INSECURE_COOKIES` | nein | `0` (aus) | `1` deaktiviert `secure` auf Session-/Transaktions-Cookies. **Nur lokale HTTP-Entwicklung — in Produktion NICHT setzen.** |
| `F451_COOKIE_PREFIX` | nein | `f451` | Prefix of the auth cookie names (`<prefix>_session`, `_oidc_tx`, `_connect_tx`). Set a different value per instance when two stacks run on the same host — browsers do not separate cookies by port. |
| `F451_OIDC_ALLOW_INSECURE` | nein | Wert von `F451_INSECURE_COOKIES` | `1` erlaubt http-Issuer bei der OIDC-Discovery, unabhängig vom Cookie-Modus. **In Produktion NICHT setzen** (Entra spricht ohnehin nur HTTPS). |
| `F451_FORGEJO_OAUTH_CLIENT_ID` / `_SECRET` | nein (Paar) | — (Verknüpfung deaktiviert) | Aktiviert „Forgejo verbinden". Braucht zusätzlich `F451_FORGEJO_URL`. |
| `F451_GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | nein (Paar) | — (Verknüpfung deaktiviert) | Aktiviert „GitHub verbinden". Mit `F451_GITHUB_LOGIN=1` doppelt dieselbe App als Sign-in-App — die Authorization-callback-URL muss dann `https://<api-host>/auth/` erlauben (deckt sowohl `/auth/github/callback` als auch `/auth/connect/github/callback` ab). |
| `F451_GITHUB_LOGIN` | nein | `0` (aus) | `1` aktiviert „Sign in with GitHub" (#8) — braucht zusätzlich `F451_GITHUB_OAUTH_CLIENT_ID`/`_SECRET` (Fail-Fast, wenn nur `F451_GITHUB_LOGIN=1` gesetzt ist) und `F451_TOKEN_KEY`, auch OHNE `F451_OIDC_ISSUER` (GitHub-only-Instanzen). Der angemeldete Account wird sofort als GitHub-Verknüpfung übernommen — kein separater „GitHub verbinden"-Schritt nötig. |
| `F451_MAX_UPLOAD_MB` | nein | `10` | Größenlimit (MiB) für Media-Uploads in Entwürfe. |
| `F451_RATE_LIMIT_AUTH_MAX` | nein | `10` | Anfragen/Minute PRO Auth-Route und Client-IP (6 Routen, je EIGENER Zähler — kein Gesamtbudget). |
| `F451_RATE_LIMIT_SEARCH_MAX` | nein | `60` | Anfragen/Minute für `GET /api/search` pro Client-IP; Aufrufe mit API-Token zählen pro Nutzer. |
| `F451_RATE_LIMIT_API_TOKEN_MAX` | nein | `300` | Anfragen/Minute für alle Aufrufe mit API-Token (`/api`, `/media`), pro Nutzer über alle seine Tokens. Überschreitung → 429 mit `Retry-After`. |
| `F451_TRUST_PROXY` | nein, aber siehe Warnung unten | — (kein Proxy vertraut) | Anzahl vertrauter Reverse-Proxy-Hops für `X-Forwarded-For` (Zahl `n`) oder `true` (NUR exotische Setups, siehe unten). Steuert, welche IP als Client-IP für die Rate-Limits gilt. |
| `F451_PUBLIC_BASE_URL` | in Produktion: ja | — (Host-Header-Fallback) | Öffentliche Basis-URL (Schema+Host, ohne Pfad) — Basis der OAuth-`redirect_uri` UND „eigene Origin" des CSRF-Origin-Checks. **Fehlkonfiguration blockiert ALLE mutierenden Browser-Requests mit 403.** |

**`F451_TRUST_PROXY` — Hop-Zahl hängt von der REALEN Proxy-Kette ab, nicht vom
Compose-Deployment allein:** dieses Compose-Deployment terminiert TLS nicht
selbst — ein externer Reverse Proxy (Caddy/Traefik) reicht Requests an `web`
weiter, `web` wiederum proxyt `/api`/`/auth`/`/admin`/`/media` intern an `api`
(Next.js-Rewrite). Es gibt daher zwei mögliche Ketten:
- **Caddy → `api` direkt** (falls der externe Proxy die API-Pfade OHNE Umweg
  über `web` an `api:3001` weiterleitet): **1** Hop.
- **Caddy → `web` → `api`** (Next.js proxyt intern, das ist der
  Standardfall bei diesem Stack): korrekt ist **1**, WENN der interne
  `web`→`api`-Proxy-Schritt `X-Forwarded-For` unverändert vom externen Proxy
  durchreicht (Next.js tut das bei einfachen Rewrites i. d. R.), oder **2**,
  WENN `web` selbst eine eigene `X-Forwarded-For`-Kopfzeile anhängt (dann
  zählt der externe UND der interne Hop separat). **Vor Produktivbetrieb
  manuell verifizieren:** einen Request mit einer gefälschten
  `X-Forwarded-For`-Kopfzeile durch die komplette Kette schicken und prüfen,
  ob `req.ip` in den Logs die ECHTE Client-IP zeigt (korrekte Hop-Zahl) oder
  die gefälschte (Hop-Zahl zu hoch — Rate-Limits umgehbar) bzw. immer dieselbe
  Proxy-IP (Hop-Zahl zu niedrig — Rate-Limits treffen alle Nutzer gemeinsam).

### Web (`deploy/wiki/docker-compose.yml`, Service `web`, Laufzeit)

| Variable | Pflicht | Default | Bedeutung |
|---|---|---|---|
| `F451_IMPRINT_URL`, `F451_PRIVACY_URL` | nein (für öffentliche Instanzen in DE faktisch ja) | — | Links to the legal notice and privacy policy, shown next to the attribution notice on every page including sign-in. |
| `F451_CUSTOM_STYLESHEET` | nein | — | Same-origin path of an extra stylesheet loaded after f451's own CSS (base colour/font tokens, self-hosted `@font-face`). Serve it from the reverse proxy; example `deploy/demo/theme/`. |

### Web (`deploy/wiki/docker-compose.yml`, Service `web`, BUILD-Zeit)

| Variable | Pflicht | Default | Wirkung |
|---|---|---|---|
| `API_URL` | nein (nicht `F451_`/`NEXT_PUBLIC_`, hier der Vollständigkeit halber) | `http://api:3001` | Next-Standalone-Build-Ziel für Server-seitige API-Aufrufe. Wird zur BUILD-Zeit eingebrannt — Laufzeit-Änderung wirkungslos. |
| `DRAWIO_INTERNAL_URL` | nein | `http://drawio:8080` | Interner Docker-Netzwerkname des `drawio`-Containers, an den der Next-Rewrite `/drawio/:path*` proxyt (`apps/web/next.config.ts`). Wie `API_URL` zur BUILD-Zeit in die Rewrite-Regeln gebacken (und als Laufzeit-env gespiegelt). Analog zu `API_URL` der INTERNE Name, weil der Next-Server (nicht der Browser) die Verbindung aufbaut. |
| `NEXT_PUBLIC_DRAWIO_URL` | nein | *(leer → relativer Proxy-Pfad `/drawio`)* | **Standardfall: NICHT setzen.** Dann liefert `drawioBaseUrl()` die RELATIVE URL `/drawio`, der draw.io-Embed lädt SAME-ORIGIN über den `/drawio`-Rewrite (oben) — funktioniert über JEDE Deployment-URL ohne Rebuild und ohne Host-IP, und die CSP kommt mit `frame-src 'self'` aus. **Nur setzen**, um den Proxy zu umgehen und den Editor gegen eine ABSOLUTE draw.io-Origin laufen zu lassen (z. B. `https://embed.diagrams.net` oder eine externe Instanz). Dann gilt: BUILD-Zeit-Konfiguration (ins Client-Bundle gebacken); der Wert muss die vom BROWSER erreichbare draw.io-Adresse sein (NICHT `localhost`, wenn der Browser auf einem anderen Rechner als der Docker-Host läuft); er fließt zugleich in die `frame-src`-CSP (`apps/web/middleware.ts`) ein und muss zu `drawioBaseUrl()` konsistent bleiben — ein späteres Ändern ohne Neu-Build hält die alte URL in Bundle UND CSP. |

## 3. Restore-Prozedur

Nach Totalverlust (Spec §8): der Index ist reine Ableitung aus Forgejo, NUR
`forgejo-data` muss aus einem Backup zurückgespielt werden.

1. **Beide Stacks stoppen** (falls noch laufend):
   ```bash
   docker compose -f deploy/wiki/docker-compose.yml down
   docker compose -f deploy/git/docker-compose.yml down
   ```
2. **`forgejo-data` aus dem Backup zurückspielen** — Volume-Inhalt 1:1
   wiederherstellen (Backup-Werkzeug/Ablage sind hier bewusst nicht
   vorgeschrieben — Spec §8 fordert nur, dass DIESES Volume gesichert wird,
   nicht WIE). Beispiel mit einem Tar-Backup:
   ```bash
   docker volume create git_forgejo-data
   docker run --rm -v git_forgejo-data:/data -v /pfad/zum/backup:/backup \
     alpine sh -c "cd /data && tar xzf /backup/forgejo-data.tar.gz"
   ```
3. **Git-Stack starten, Forgejo gesund abwarten:**
   ```bash
   docker compose -f deploy/git/docker-compose.yml up -d
   docker compose -f deploy/git/docker-compose.yml ps   # forgejo: healthy
   ```
4. **Wiki-Stack starten** (Postgres startet leer — kein Problem, siehe
   Abschnitt 1; `server.ts` führt beim Start KEINE automatische Migration
   durch, daher vorher explizit migrieren — das Produktions-Image enthält
   dafür den kompilierten Migrationslauf `dist/db/migrate-cli.js`, nicht das
   `pnpm db:migrate`-Skript aus der Entwicklung, das auf `tsx`
   [Dev-Dependency, nicht im Image] angewiesen ist):
   ```bash
   docker compose -f deploy/wiki/docker-compose.yml up -d postgres
   docker compose -f deploy/wiki/docker-compose.yml run --rm api node dist/db/migrate-cli.js
   docker compose -f deploy/wiki/docker-compose.yml up -d
   docker compose -f deploy/wiki/docker-compose.yml ps   # api/web: healthy
   ```
   **Dieser Migrationslauf ist kein reiner Restore-Schritt** — er muss nach
   JEDEM Update des `api`-Images ausgeführt werden (bevor die neuen Container
   den Traffic übernehmen), weil er alle noch nicht angewendeten Migrationen
   in einem Rutsch nachzieht. Aktuell u. a. relevant: `0005` (`pages.last_author`,
   Metadaten-Feature „zuletzt geändert von") und `0006` (`pages.order_key`,
   Baum-Umsortierung) — beide werden von genau diesem Kommando mit abgedeckt,
   keine gesonderte Aktion nötig.
5. **Einmaliger ID-Backfill nach diesem Update** — siehe Abschnitt 3a. Dieser
   Schritt gehört NICHT zur eigentlichen Restore-Prozedur (er hängt am
   Feature-Rollout „stabile Seiten-Id", nicht am Datenverlust), ist aber nach
   einem Restore auf einen Stand VOR diesem Feature genauso einmalig
   nachzuholen wie bei jedem anderen Deployment dieses Updates.
6. **Vollständigen Reindex aller Spaces anstoßen** — der Index ist nach dem
   Neustart leer (frische DB), `GET /api/pages/...` liefert bis dahin 404. Der
   Drift-Job holt das zwar automatisch binnen 5 Minuten nach (Abschnitt 4b),
   aber nach einem Restore sollte NICHT gewartet werden:
   ```bash
   curl -X POST https://<api-host>/admin/reindex \
     -H "Authorization: Bearer $F451_ADMIN_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{}'
   ```
   `$F451_ADMIN_TOKEN` ist der Wert aus `.env` (Abschnitt 2) — ohne korrektes
   Bearer-Token antwortet der Endpunkt mit 401 (falsches Token) oder 503
   (Token gar nicht konfiguriert, Fail-Closed). Die Antwort ist ein
   Teilbericht je Space (`[{space, report}|{space, error}]`, siehe
   `apps/api/README.md` Abschnitt „Reindexierung") — `200`, wenn mindestens
   ein Space erfolgreich war, `502` nur wenn ALLE angefragten Spaces
   scheitern (dann `GET /admin/status` UND die API-Logs prüfen, Abschnitt 5).
7. **Verifizieren:** `GET /api/spaces` liefert die konfigurierten Spaces,
   eine bekannte Seite ist über `GET /api/pages/:id` lesbar, `GET
   /admin/status` zeigt `counters.indexerErrors: 0` für den gerade
   gelaufenen Reindex (> 0 heißt: mindestens eine Datei konnte nicht gelesen
   werden — Provider-/Netzwerkproblem, erneut reindexieren). Zusätzlich prüfen:
   `report.idConflicts` jedes Space sollte leer sein (Issue #7) — ein Eintrag
   `{id, path, ownerSpace}` heißt, diese Seite trägt im Frontmatter dieselbe
   `id` wie eine bereits einem ANDEREN Space gehörende Seite; Ids sind
   instanzweit gedacht (nicht nur je Space), Seiten-`id`s aus unterschiedlichen
   Spaces dürfen sich also nie überschneiden. Der Indexer übernimmt eine so
   kollidierende Seite NICHT (der zuerst indexierte Space bleibt Eigentümer,
   `pagesWithErrors` zählt den Konflikt mit) — betroffen ist nur die
   nachrückende Seite, sie fehlt so lange im Index, bis die `id` im Frontmatter
   von Hand korrigiert wird (kein automatischer Reparaturpfad, da nicht
   entscheidbar, welche der beiden Seiten die „richtige" Id behalten soll).

Sessions/Provider-Verknüpfungen sind NICHT Teil dieser Prozedur (Abschnitt 1)
— Nutzer melden sich nach einem `pg-data`-Verlust einmalig neu an und
verknüpfen ggf. ihr Forgejo-/GitHub-Konto erneut.

## 3a. Einmaliger ID-Backfill (Pflichtschritt nach diesem Update)

Phase 3.1 („stabile Seiten-Id") gibt jeder Seite eine unveränderliche
Frontmatter-`id` (Format `p-<10-stelliges base36>`) — Voraussetzung dafür,
dass Verschieben/Umbenennen (Phase 3.2) laufende Entwürfe/Sperren nicht
abreißt und alte URLs auf die neue umgeleitet werden. Bestandsseiten, die vor
diesem Update geschrieben wurden, haben noch KEINE `id` im Frontmatter — dafür
gibt es den Backfill.

**Wann:** EINMALIG nach dem Ausrollen dieses Updates (wie eine Datenmigration,
nicht wiederkehrend) — nachdem der neue Wiki-Stack läuft (s. Abschnitt 3,
Schritt 4/5). Pro Space einzeln oder für alle Spaces in einem Rutsch.

**Wie:**
```bash
curl -X POST https://<api-host>/admin/backfill-ids \
  -H "Authorization: Bearer $F451_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'                          # alle Spaces
# oder gezielt EIN Space:
curl -X POST https://<api-host>/admin/backfill-ids \
  -H "Authorization: Bearer $F451_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"space":"<space-id>"}'
```
Braucht das Admin-Token (`F451_ADMIN_TOKEN`) UND — wie `POST /admin/reindex`
— eine eingeloggte Session (dasselbe bekannte Verhalten, s. Issue #24: `/admin/*`
verlangt bei aktivem OIDC zusätzlich zum Bearer-Token eine Session,
`apps/api/test/admin-session-gate.test.ts`). Ein reiner Bearer-Aufruf ohne
Session (z. B. plain `curl` von außerhalb des Browsers) bekommt daher
reproduzierbar `401` — den Aufruf im eingeloggten Admin-Kontext absetzen
(z. B. per Browser-DevTools-Fetch mit vorhandenem Session-Cookie), nicht per
reinem curl/Bearer.

**Eigenschaften:**
- **Idempotent** — gefahrlos mehrfach ausführbar. Seiten mit bereits
  vorhandener `id` werden nie erneut angefasst (Antwort zählt sie nur unter
  `alreadyHadId`).
- Seiten mit offenem Entwurf-Branch oder aktiver Sperre werden übersprungen
  (Antwort: `skipped`) und beim NÄCHSTEN Lauf automatisch nachgezogen, sobald
  Entwurf/Sperre weg sind — kein manuelles Nacharbeiten nötig.
- Nach dem Backfill wechseln die Seiten-URLs auf das stabile Format
  `/wiki/<space>/p-<id>`; alte, pfadbasierte URLs werden automatisch dorthin
  umgeleitet (keine kaputten Links/Lesezeichen).

## 3b. Einmaliger Reindex nach diesem Update (Issue #9, Alert-/YouTube-Beschriftungen)

Callout-Titel (Hinweis/Tipp/Wichtig/Warnung/Achtung) und die YouTube-
Abspiel-Beschriftung werden seit diesem Update NICHT mehr als fester
deutscher Text ins gespeicherte HTML gerendert (`pages`-Tabelle) — sie folgen
jetzt der UI-Sprache (de/en-Umschalter) und kommen erst beim Anzeigen per CSS
herein (s. `packages/markdown/src/alerts.ts`, `render.ts`,
`apps/web/app/layout.tsx`). Seiten, die VOR diesem Update zuletzt indexiert
wurden, tragen den alten deutschen Text noch als echten Textknoten im
gespeicherten HTML — eine CSS-`:empty`-Bedingung verhindert dabei zuverlässig
eine DOPPELTE Anzeige (altes HTML zeigt weiterhin genau EINEN Titel, nur eben
unabhängig von der gewählten UI-Sprache immer den deutschen). Erst ein
einmaliger `POST /admin/reindex` (Kommando wie in Abschnitt 3, Schritt 6)
rendert diese Seiten mit dem neuen, sprachneutralen HTML neu — danach folgt
auch ihr Callout-/YouTube-Titel der UI-Sprache.

## 4. Störungs-Drehbuch

Drei Szenarien aus Spec §9 („Lesen darf nie ausfallen, Schreiben darf nie
still Daten verlieren"). Dies ist DOKUMENTATION des Erwartungsverhaltens mit
manuellen Prüfschritten — seit Phase 4b Task 5 (Spec-§11-Abnahme) ist jedes
der drei Szenarien zusätzlich automatisiert abgedeckt (s. jeweiliger Verweis
unten); die manuellen Schritte bleiben als Betriebs-Referenz für Vor-Ort-
Diagnose bestehen.

### (a) Forgejo gestoppt / nicht erreichbar

**Erwartungsverhalten (Spec §9):** Lesen läuft vollständig aus Index +
gerendertem HTML weiter — die API braucht Forgejo für `GET`-Lese-Endpunkte
NICHT (Seiteninhalt, Suche, Graph, Broken-Links kommen ausschließlich aus
Postgres). Der Editor zeigt einen Fehlzustand, sobald ein schreibender
Vorgang (Draft öffnen/speichern, Lock) tatsächlich den Provider braucht (4b:
Autosave-Puffer im `localStorage`, noch nicht Teil dieses Tasks). Workflow-
Aktionen (Review anfordern, Freigeben & mergen, Provider-Direktzugriffe)
antworten mit `502` — kein stiller Fehlschlag.

**Manuelle Prüfschritte:**
1. `docker compose -f deploy/git/docker-compose.yml stop forgejo`
2. `GET /api/spaces/:space/tree` und `GET /api/pages/:id` einer bereits
   indexierten Seite aufrufen → weiterhin `200` mit dem letzten indexierten
   Stand.
3. Im Web-UI eine Seite zum Bearbeiten öffnen (`POST
   /api/pages/:id/draft` — der Autosave danach nutzt `PUT`) → Fehler, da der
   Provider für Branch-Anlage/-Schreiben gebraucht wird (Provider-Fehler wird
   zu `502` durchgereicht).
4. `docker compose -f deploy/git/docker-compose.yml start forgejo` — Lesen
   war währenddessen nie unterbrochen, Schreiben funktioniert sofort wieder.

**Automatisiert abgedeckt durch** `apps/api/test/provider-down.test.ts`
(`GET /api/spaces/:space/tree` und `GET /api/pages/:id` bleiben bei
Provider-Totalausfall `200`, `POST /api/pages/:id/draft` liefert `502
{status,reason}`) sowie `apps/web/e2e/resilienz.spec.ts` Flow 1
(Offline-Puffer + Nachschub im Editor, byte-exaktes Statusband).

### (b) Webhooks verworfen (z. B. Netzwerkproblem zwischen Forgejo und API)

**Erwartungsverhalten (Spec §9):** der HEAD-Abgleich-Job (`checkDrift`, alle 5
Minuten, `apps/api/src/server.ts`) vergleicht je Space den aktuellen
`main`-HEAD-SHA mit dem zuletzt vollständig indexierten
(`spaces.indexedHeadSha`) und stößt bei Abweichung automatisch einen
Voll-Reindex an — ein verpasster Webhook heilt binnen 5 Minuten von selbst,
ohne manuellen Eingriff.

**Beobachtbar über:**
- Log-Zeile bei erkanntem Drift (Pino-JSON, `msg` enthält den Space —
  `checkDrift` selbst loggt nicht direkt, aber der resultierende Reindex
  läuft über denselben Pfad wie `POST /admin/reindex`; ein FEHLGESCHLAGENER
  Abgleich eines Space loggt explizit: `drift: HEAD-Abgleich für Space
  "<id>" fehlgeschlagen`, Level `warn`).
- `GET /admin/status` — `counters.driftErrors` erhöht sich bei jedem
  gescheiterten Abgleich EINES Space (Provider nicht erreichbar o. Ä.);
  `counters.indexerErrors` erhöht sich, wenn ein vom Drift-Job ausgelöster
  Reindex einzelne Dateien wegen eines IO-Fehlers überspringen musste.

**Manuelle Prüfschritte:**
1. Eine Seite direkt in Forgejo ändern, OHNE dass die API einen Webhook
   dafür erhält (z. B. `F451_WEBHOOK_SECRET_FORGEJO` testweise falsch
   konfigurieren, sodass die HMAC-Prüfung fehlschlägt und die Änderung nie
   verarbeitet wird).
2. `GET /api/pages/:id` zeigt zunächst noch den alten Stand.
3. Bis zu 5 Minuten warten (oder — nur zum Testen — `POST /admin/reindex`
   manuell anstoßen, das ist der „manuelle Hammer" für denselben Effekt).
4. `GET /api/pages/:id` zeigt den neuen Stand; `GET /admin/status` zeigt den
   Zählerstand VOR und NACH dem Test zum Vergleich.

**Automatisiert abgedeckt durch** `apps/api/test/drift.test.ts` (Szenario
„Drift erkannt": ein Commit landet DIREKT über den Provider, ohne Webhook —
`indexedHeadSha` bleibt bis zum nächsten `checkDrift`-Lauf nachweislich auf
dem alten Stand und wird erst durch die Heilung nachgezogen).

### (c) Token widerrufen / Session gelöscht

**Erwartungsverhalten (Spec §9):** ein widerrufenes Entra-Token (Offboarding)
wirkt sofort auf NEUE Logins, auf bestehende Sessions binnen der Token-TTL
(~1 h). Eine ungültige/abgelaufene Session führt zu einer sauberen
Re-Login-Aufforderung (`401`, Header `WWW-Authenticate: session`) — der
Editor-Inhalt überlebt den Re-Login (4b: `localStorage`-Persistenz, noch
nicht Teil dieses Tasks). Abgelaufene Sessions werden zusätzlich stündlich
serverseitig aufgeräumt (`deleteExpiredSessions`-Sweeper, Phase 4a Task 3
M3, `apps/api/src/server.ts`) — kein unbegrenzt wachsender `sessions`-Bestand.

**Manuelle Prüfschritte:**
1. Eingeloggt eine geschützte Route aufrufen (`GET /api/me`) → `200`.
2. Die Session-Zeile in Postgres direkt löschen (simuliert Ablauf/Widerruf):
   ```sql
   delete from sessions where user_id = '<user-id>';
   ```
3. Dieselbe Route erneut aufrufen → `401`, `WWW-Authenticate: session`
   gesetzt (kein `500`, keine Fehlermeldung mit Implementierungsdetails).
4. Im Web-UI: die Anwendung leitet auf den Login um, statt eine kaputte
   Seite zu zeigen.

**Automatisiert abgedeckt durch** `apps/web/e2e/resilienz.spec.ts` Flow 2
(Session-Cookie gelöscht → Redirect mit `?next=`, Inhalt überlebt im
`localStorage`-Puffer, Re-Login → Mount-Recovery-Dialog → „Übernehmen" →
Save persistiert) und Flow 3 (Recovery „Verwerfen" — Server-Stand bleibt
maßgeblich).

## 5. Monitoring

- **`GET /healthz`** — `200 {status:"ok"}`, immer (kein DB-Zugriff). Prozess
  läuft.
- **`GET /readyz`** — `200 {status:"ok"}`, wenn `SELECT 1` gegen Postgres
  gelingt; sonst `503 {status:"unavailable",reason:"..."}`. Für
  Orchestrierungs-Readiness-Probes (im Compose-Deployment die
  `healthcheck:`-Definition des `api`-Service).
- **`GET /admin/status`** (Task 5, Betrieb) — dasselbe Admin-Gate wie `POST
  /admin/reindex` (Bearer-Token `F451_ADMIN_TOKEN`; ohne Token 503,
  falsches Token 401). Antwort:
  ```json
  { "counters": { "webhookErrors": 0, "indexerErrors": 0, "driftErrors": 0, "since": "2026-…T…Z" }, "uptime": 12345 }
  ```
  - `counters.webhookErrors` — echte Fehlerpfade beim Verarbeiten eines
    Webhooks (asynchrones Indexieren nach einem Push, Nach-Merge-Cleanup nach
    einem nativ gemergten Review-PR). NICHT gezählt: ignorierte/erwartete
    202-Antworten (unbekanntes Repo, kein `main`-Branch, kaputtes JSON, PR
    nicht gemergt) — das sind keine Fehler, sondern erwartete Zustände.
  - `counters.indexerErrors` — Dateien, die beim Lesen wegen eines
    transienten IO-/Netzwerkfehlers übersprungen werden mussten
    (`readPageFileSafe`, `apps/api/src/indexer/index-space.ts`); zählt für
    Voll-Reindex (`POST /admin/reindex`), inkrementelles Webhook-Indexieren
    UND den Drift-Job gemeinsam, weil sich alle drei diese Funktion teilen.
  - `counters.driftErrors` — ein Space-HEAD-Abgleich im Drift-Job ist
    komplett gescheitert (z. B. Provider nicht erreichbar), NICHT bloß „kein
    Drift festgestellt".
  - `since` — Zeitstempel, seit dem gezählt wird. Die Zähler sind
    **bewusst in-memory**: ein Prozess-Neustart (Deploy, Crash, manueller
    Restart) setzt alle drei auf 0 zurück. Für ein Betriebssignal
    „läuft gerade etwas schief?" ausreichend, für ein historisches Audit-Log
    NICHT geeignet — Prometheus-Export ist laut Spec §11 eine spätere
    Ausbaustufe, hier bewusst nicht gebaut.
- **Log-Format** — strukturiertes Pino-JSON auf stdout (`level`, `time`,
  `pid`, `hostname`, `reqId` je Request, `msg`, plus Kontextfelder wie `err`).
  **Redaction** (`apps/api/src/app.ts`, `buildApp`): die Pfade
  `req.headers.authorization`, `req.headers.cookie` und
  `req.headers["x-hub-signature-256"]` werden in JEDER Logzeile durch
  `"[Redacted]"` ersetzt, sollten sie je auftauchen — Verteidigung in der
  Tiefe, denn Fastifys eingebauter Request-Serializer loggt Header ohnehin
  nie (die automatischen „incoming request"/„request completed"-Zeilen
  enthalten nur `method`/`url`/`host`/`remoteAddress`/`remotePort`,
  niemals `headers`). Die Redaction greift zusätzlich für jeden künftigen
  oder manuellen Log-Aufruf, der Header abweichend vom Standard mitschickt.

## 6. Lokaler Betrieb OHNE Entra (Entwicklung)

Die Auth ist „OIDC, konfigurierbar" (Spec §7) — für lokale Entwicklung dient der
**mitgelieferte Forgejo als OIDC-Login-Provider** (statt Azure Entra). Forgejo
bringt einen eingebauten OIDC-Provider mit
(`/.well-known/openid-configuration`), sodass kein Cloud-IdP nötig ist. Es gibt
**keine eigene Nutzerverwaltung** — die Konten liegen in Forgejo.

> **Nur für Entwicklung.** Dieser Modus setzt `F451_INSECURE_COOKIES=1` und
> `F451_OIDC_ALLOW_INSECURE=1` (HTTP). NIEMALS in Produktion — dort ist Entra
> der IdP (Abschnitt 2).

### Einrichtung (ein Skript)

    # 1. Forgejo-Dev-Instanz starten
    docker compose -f deploy/git/docker-compose.yml up -d

    # 2. OAuth2-App registrieren, Demo-Space „betrieb" seeden, deploy/wiki/.env schreiben
    ./scripts/dev-local-setup.sh

Das Skript ist idempotent: es legt (falls nötig) das Admin-Konto
`wiki-admin`/`admin1234`, die Org `dev-docs`, die OAuth2-App `f451-wiki-dev`
und das Demo-Repo `dev-docs/betrieb` (Seiten `index`, `onboarding`,
`richtlinien` + Diagramm) an und schreibt eine fertige `deploy/wiki/.env`.
Ein bereits vorhandenes Client-Secret wird wiederverwendet (keine Rotation,
die eine laufende API entkoppeln würde).

### Host-Dev-Flow starten (empfohlen — kein Split-Horizon)

Browser und API sehen `localhost:3300` einheitlich, deshalb funktioniert der
OIDC-Login ohne weitere Tricks:

    set -a; source deploy/wiki/.env; set +a
    export DATABASE_URL=postgres://…            # eigene Postgres-Instanz
    pnpm --filter @f451/api db:migrate
    # Terminal A:
    PORT=3001 pnpm --filter @f451/api dev
    # Terminal B:
    API_URL=http://127.0.0.1:3001 pnpm --filter @f451/web dev

Dann `http://localhost:3000` → **Anmelden** → Forgejo-Login
(`wiki-admin`/`admin1234`). Damit der Space **lesbar** wird, einmal
„Forgejo verbinden" (zweiter OAuth-Flow) — Leserechte werden vom echten
Repo-Zugriff geerbt (Spec §7).

Reproduzierbarer End-to-End-Login-Smoke (echter Browser):

    # aus apps/web (dort ist playwright aufgelöst); F451_ADMIN_TOKEN aus .env
    (cd apps/web && node ../../scripts/dev-local-smoke.mjs)

### Container-Weg (`compose up`)

Läuft alles in Containern, muss der OIDC-Issuer für Browser **und** API unter
derselben URL erreichbar sein. `localhost` erfüllt das nicht (im API-Container
zeigt `localhost` auf den Container selbst). Lösung: `host.docker.internal`
beidseitig auflösbar machen —

    echo '127.0.0.1 host.docker.internal' | sudo tee -a /etc/hosts

— und in `deploy/wiki/.env` `F451_OIDC_ISSUER`, `F451_OIDC_REDIRECT_URL`,
`F451_PUBLIC_BASE_URL` sowie Forgejos `ROOT_URL` auf
`http://host.docker.internal:3300`/`:8080` umstellen. Der Host-Dev-Flow oben
ist ohne diesen Eingriff robuster und daher für Entwicklung empfohlen.

## 7. Deployment-E2E-Gate

Alle übrigen Tests (vitest, Playwright gegen `next dev`, Testcontainers) laufen
NIE gegen die **gebauten Produktions-Docker-Images** und NIE über die
**vollständige Nutzerreise inkl. Bearbeiten/Speichern**. Deshalb fiel eine
ganze Klasse von Deployment-/Laufzeitfehlern (siehe
`docs/superpowers/HANDOFF-2026-07-16-deployment-e2e.md`) erst beim echten
Ausprobieren im ausgelieferten Stack auf. Der Deployment-E2E-Gate
(`scripts/deploy-e2e.mjs`) schließt genau diese Lücke: ein echter Chromium
(Playwright) fährt gegen den laufenden, GEBAUTEN Stack die volle Reise —

Login → „Forgejo verbinden" → Ansehen → Bearbeiten → Tippen → Autosave
(Server-Beleg: Draft-Branch+Commit auf Forgejo) → Moduswechsel (WYSIWYG↔Markdown)
→ Review anfordern (Server-Beleg: offener PR) → Review-Diff → Freigeben & mergen
→ Merge sichtbar (Server-Beleg: Marker im `main`-Commit).

Jeder der 11 Schritte hat sowohl einen DOM- als auch, wo zutreffend, einen
unabhängigen Server-Beleg über die Forgejo-REST-API (kein
`page.evaluate(fetch(...))` als Ersatz für einen echten Klick/Tastatureingabe).
Ein Bruch in JEDEM Schritt beendet den Lauf mit Exit-Code ≠0 und schreibt
Screenshot, DOM-Dump, Konsolen-/Netzwerk-Mitschnitt nach `e2e-artifacts/`
(gitignored) — **Exit≠0 ist die Definition von „Bruch"**, ein grüner Lauf ohne
diese Artefakte bedeutet „die komplette Reise hat im echten Deployment
funktioniert".

### Selbst-zurücksetzend (idempotent)

Jeder Lauf tippt einen frischen, pro Lauf eindeutigen Marker in die Seed-Seite
(`path:betrieb/index.md`) und merged ihn über Review→Release auf `main` — ohne
Aufräumen würden sich die Marker in der H1 über mehrere Läufe hinweg
akkumulieren. Deshalb stellt eine `resetState()`-Phase am ANFANG jedes Laufs
(vor dem Login-Schritt, reine Forgejo-API — keine Browser-Aktion) den
deterministischen Ausgangszustand her: alle offenen PRs in `dev-docs/betrieb`
schließen, alle `draft/*`-Branches löschen, `index.md` auf `main` — falls
abweichend — exakt auf `scripts/seed/index.md` zurücksetzen (inkl. des
`> [!NOTE]`-Alert-Blocks, der die Editor-Crash-Regression aus Issue #22
absichert). Derselbe Aufruf läuft zusätzlich als Best-Effort-Teardown am Ende
jedes Laufs, damit der Stand schon zwischen zwei Läufen sauber ist. Ein
Admin-Reindex (`POST /admin/reindex`) wird dabei ebenfalls versucht, ist aber
NICHT hart erzwungen: in jedem Deployment mit aktivem OIDC verlangt `/admin/*`
zusätzlich zum Bearer-Token eine Session (by-design, siehe
`apps/api/test/admin-session-gate.test.ts`) — ein reiner Bearer-Aufruf vor dem
Login bekommt daher reproduzierbar 401. Das ist unschädlich: Entwürfe lesen
laut `apps/api/src/drafts/lifecycle.ts` immer direkt vom Git-Provider, nie aus
dem Postgres-Index: nur die (im Gate unbelegte) Leseansicht bleibt bis zum
nächsten periodischen Drift-Abgleich (Abschnitt 4b) kosmetisch veraltet.

### Ausführen

Voraussetzung: der Ziel-Stack läuft bereits (`docker compose ... up -d`,
Abschnitt 6 bzw. Produktions-Äquivalent) — der Gate selbst startet NICHTS.

    pnpm e2e:deploy
    # entspricht: node scripts/deploy-e2e.mjs
    # Ziel-URLs per Env überschreibbar: WEB_BASE, FORGEJO_BASE, FORGEJO_USER/_PASS
    # FORGEJO_TOKEN fällt automatisch auf deploy/wiki/.env#F451_FORGEJO_TOKEN zurück.

Für den kompletten Von-Null-Durchstich (Forgejo-Stack + `dev-local-setup.sh` +
Wiki-Stack-Rebuild inkl. DB-Migration + Gate) in einem Kommando:

    pnpm e2e:deploy:full
    # entspricht: bash scripts/deploy-e2e-full.sh
    # WEB_BASE/FORGEJO_URL per Env überschreibbar (Default: die im HANDOFF
    # dokumentierte LAN-Instanz) — deploy/wiki/.env bleibt maschinenspezifisch
    # und wird von dev-local-setup.sh idempotent neu geschrieben.

Der Image-Rebuild in `e2e:deploy:full` dauert je nach Maschine mehrere
Minuten — für einen schnellen Gate-Lauf gegen einen bereits laufenden Stack
genügt `pnpm e2e:deploy`.

### Discovery-E2E (ergänzend)

`scripts/discovery-e2e.mjs` prüft — anders als der lineare Happy-Path oben —
die GANZE App aus Anwendersicht in 24 Bereichen: alle Seiten + Wikilinks +
Bilder/Diagramme, Suche, Graph, Verweis-Report, Theme-Toggle, Verbindungen
(inkl. Trennen/Wiederverbinden), den kompletten Editor (Toolbar, alle 5
Alert-Typen, Tabelle, Codeblock, Zitat, Trennlinie, draw.io-Neuanlage UND
-Bestandsdiagramm, Excalidraw, Wikilink-Autocomplete, Moduswechsel
WYSIWYG↔Markdown, Befund-Panel, Bild-Upload), Neue-Seite-Anlage, Review
„Änderungen anfragen" sowie Logout/Re-Login.

Jeder der 24 Bereiche läuft **continue-on-error** in einem eigenen
try/catch: ein Bruch wird als Befund gesammelt (inkl. Screenshot, DOM-Dump,
Konsolen-/Netzwerk-Mitschnitt in `e2e-artifacts/discovery/`), der Lauf geht
sofort mit dem NÄCHSTEN Bereich weiter — Ziel ist, in EINEM Lauf ALLE Brüche
zu finden, nicht nur den ersten.

    pnpm run e2e:discovery
    # entspricht: node scripts/discovery-e2e.mjs
    # Voraussetzung wie oben: der Ziel-Stack läuft bereits.
    # Exit-Code ≠0, sobald mindestens ein Bereich gebrochen ist.
    # Ergebnistabelle + Rohbefunde: e2e-artifacts/discovery/findings.json

Bekannte Abdeckungsgrenzen (ehrlich benannt, kein grün Gefaktes):

- **Review „Änderungen anfragen"** läuft mit dem Ein-Nutzer-Dev-Seed als
  Self-Request (Autor fordert an eigenem Entwurf Änderungen an) — der echte
  Reviewer-Flow bräuchte einen ZWEITEN Nutzer und ist damit strukturell nicht
  abgedeckt; geprüft wird nur, dass die App darauf sauber reagiert (Erfolg
  ODER dokumentiertes 409/422, kein Crash/500).
- Kein Mobile-/Responsive-Test (nur ein Desktop-Viewport).
- Media-Upload prüft nur den Positivfall (ein valides Bild lädt erfolgreich);
  keine Fehlerfälle (zu groß, falscher Typ, abgebrochener Upload).

## 8. MCP-Server (Zugriff für KI-Agenten)

Der Service `mcp` stellt das Wiki als Werkzeuge für KI-Agenten bereit
(Plan: `docs/superpowers/plans/2026-07-18-mcp-server.md`). Er ist ein
**zustandsloser Übersetzer MCP↔HTTP**: er wrappt ausschließlich die f451-API
und hat keine eigene DB- oder Forgejo-Verbindung. Dadurch gelten für Agenten
exakt dieselben Rechte, derselbe Review-Workflow und dieselbe Indexierung wie
für Menschen im Browser — es gibt keinen zweiten Weg an den Regeln vorbei.

### Erreichbarkeit

Der Container exportiert **keinen Port**. Agenten sprechen ihn über die
App-Origin an, wo der Next-Rewrite `/mcp` intern auf `mcp:3002` zeigt:

```
URL:    https://<wiki-host>/mcp
Header: Authorization: Bearer f451_pat_…
```

Der MCP spricht die API seinerseits intern über `F451_API_URL`
(`http://api:3001`) an — nicht über den öffentlichen Proxy.

### Authentifizierung

Jeder Nutzer erzeugt sich in der App unter **Einstellungen → Verbindungen**
ein persönliches Zugriffs-Token (`f451_pat_…`, Scope `read` oder `write`).
Der Klartext wird genau einmal angezeigt; gespeichert ist nur der SHA-256-Hash.

**Der MCP-Dienst hält selbst kein Secret.** Er liest den Token pro Request aus
dem `Authorization`-Header und reicht ihn 1:1 an die API weiter — deshalb ist
er multi-user-tauglich, ohne Nutzer voneinander zu wissen. Geprüft wird
ausschließlich in `apps/api` (Hash-Lookup, Ablauf, Widerruf, Scope).

Aus demselben Grund läuft der Transport **zustandslos**
(`sessionIdGenerator: undefined`) und erzeugt Server- und Transport-Instanz pro
Request neu: Ein sitzungsbehafteter Transport würde Instanzen über Requests
hinweg wiederverwenden und damit den Token eines Nutzers an den nächsten binden.

### Zwei Voraussetzungen fürs Schreiben

1. Token mit Scope `write` (ein `read`-Token wird bei jedem Nicht-GET mit 403
   abgewiesen).
2. **Ein verbundenes Forgejo-/GitHub-Konto.** Der API-Token weist nur den
   Nutzer aus; committet wird mit dessen hinterlegtem Provider-Token, damit
   Änderungen unter seinem Konto erscheinen. Fehlt die Verknüpfung, scheitert
   jeder Schreibversuch mit 403 — das ist kein Defekt, sondern nur im Browser
   behebbar (Einstellungen → Verbindungen → Verbinden). Ein Agent kann das
   nicht selbst nachholen.

### Werkzeuge

| Lesen | Schreiben |
|---|---|
| `search_wiki`, `list_spaces`, `get_tree` | `create_page`, `edit_page` |
| `read_page` (gerendert), `get_page_source` (Markdown) | `update_page_draft`, `discard_page_draft` |
| `get_graph`, `list_broken_links` | `request_review`, `release_page`, `request_changes` |

Schreiben läuft immer über den Review-Workflow: Draft → Review-PR → Freigabe.
Ein direkter Schreibzugriff auf die veröffentlichte Fassung existiert nicht.

**SHA-Vertrag:** `update_page_draft` setzt auf einem `baseSha` auf und
scheitert mit einem Konflikt, wenn der Draft sich zwischenzeitlich bewegt hat.
Da der Dienst zustandslos ist, ist `baseSha` optional — ohne Angabe ermittelt
er den aktuellen Stand selbst. Ein Konflikt wird bewusst **nicht** automatisch
aufgelöst: die Fehlermeldung liefert `currentSha`/`currentContent`, damit der
Agent neu aufsetzt, statt fremde Änderungen still zu überschreiben.

### Störungsbild

| Symptom | Ursache |
|---|---|
| `401` schon vor jedem Tool-Aufruf | Kein oder kein `f451_pat_`-Token im Header. |
| „Token ungültig, abgelaufen oder widerrufen" | Token in der UI widerrufen oder abgelaufen → neues erzeugen. |
| „Kein verbundenes Forgejo-/GitHub-Konto" | Siehe Voraussetzung 2 oben — muss ein Mensch im Browser erledigen. |
| „nur Lese-Rechte (Scope read)" | Token mit Scope `write` erzeugen. |
| `405` auf GET/DELETE `/mcp` | Erwartet: der Dienst läuft zustandslos und akzeptiert nur POST. |
| Zu viele Anfragen (429) | Rate-Limits der API greifen auch für Agenten (u.a. Suche 60/min) — siehe Merkposten unten. |

**Merkposten Rate-Limits:** Die API-Limits sind auf menschliches Tempo
ausgelegt. Ein Agent, der „lies den ganzen Baum" ausführt, kann sie auslösen.
Ein eigenes, pro Token/Nutzer zählendes Limit für Token-Auth ist noch nicht
umgesetzt; bei Bedarf zusammen mit `F451_TRUST_PROXY` nachziehen, sonst zählen
alle Agenten in denselben Topf.

### Prüfen, ob der Dienst lebt

```bash
docker compose -f deploy/wiki/docker-compose.yml --env-file deploy/wiki/.env \
  exec mcp wget -qO- http://127.0.0.1:3002/healthz     # {"status":"ok"}

# Werkzeugliste über die App-Origin (Token aus der UI einsetzen):
curl -s https://<wiki-host>/mcp \
  -H "Authorization: Bearer f451_pat_…" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 9. Seitenversionierung

Etappe 1 (Design: `docs/superpowers/specs/2026-07-19-seitenversionierung-design.md`)
gibt freigegebenen Seiten eine menschenlesbare Versionsnummer (Semver,
`1.2.0`) mit Changelog im Frontmatter. Etappe 2 (Versionsliste, Diff gegen
eine frühere Fassung, Rekonstruktion beim Reindex) ist NOCH NICHT gebaut —
dieser Abschnitt beschreibt ausschließlich den aktuellen Stand.

### Aktivierung (pro Space)

Kein globaler Schalter — jeder Space entscheidet für sich, über
`versioning: true` als Top-Level-Schlüssel in `_meta/schema.yaml` des
jeweiligen Space-Repos, neben dem bestehenden `fields:`-Schlüssel:

```yaml
fields:
  - key: ...
    ...
versioning: true
```

Fehlt die Datei oder der Schlüssel, bleibt der Space unversioniert
(Default `false`) — bestehendes Verhalten für alle Spaces ohne diese Zeile
bleibt exakt unverändert. Geschrieben werden kann die Datei entweder über
den Schema-Editor im Web-UI oder — wie hier beim Aktivieren für den
Demo-Space `betrieb` geschehen — per Direkt-Commit auf `main` über die
Provider-API; die API lädt `_meta/schema.yaml` gecacht für 5 Minuten
(`apps/api/src/spaces/metadata-schema.ts`), ein Neustart der `api` leert den
Cache sofort.

### Reservierte Frontmatter-Schlüssel

`version` und `changelog` sind seit diesem Feature reservierte Top-Level-
Frontmatter-Schlüssel (systemverwaltet, s. o.) — sie können in
`_meta/schema.yaml` eines Space NICHT als eigenes Metadatenfeld (`- key:
version, type: text` o. Ä.) deklariert werden. Der Schema-Parser
(`packages/markdown/src/schema.ts`) weist einen solchen Eintrag mit einer
Fehlermeldung zurück, statt ihn stillschweigend zu übernehmen — ein
gleichnamiges Metadatenfeld würde sonst seinen Wert beim Lesen verlieren
und beim nächsten Speichern über das Metadaten-Formular aus der Datei
entfernt werden.

### Bedeutung der Nummer

Die Version bezeichnet den **letzten freigegebenen Stand** — sie steigt
ausschließlich beim Freigeben eines Review-PR (`POST
/api/pages/:id/release`), wo der Freigebende im Freigabe-Dialog die
Sprunggröße (`patch`/`minor`/`major`) und eine Changelog-Notiz wählt.

Wird eine Seite **direkt in Git bearbeitet**, am Review-Workflow vorbei
(z. B. Commit direkt auf `main` über die Provider-Oberfläche), bleibt die
Versionsnummer stehen — sie steigt NICHT automatisch. Die Leseansicht
erkennt diesen Fall (Vergleich des zuletzt indexierten Blob-SHA gegen den
SHA, unter dem die Version zuletzt vergeben wurde, Spalte
`pages.last_blob_sha`) und zeigt stattdessen den Hinweis „geändert seit
X" — ein bewusst sichtbares Signal, dass der angezeigte Inhalt neuer ist
als die zuletzt vergebene Versionsnummer, statt die Nummer stillschweigend
falsch wirken zu lassen.

### `page_versions` ist ein Cache — mit einer offenen Lücke bis Etappe 2

Wie der übrige Index (Abschnitt 1) ist auch die neue Tabelle
`page_versions` als **ableitbarer Cache** konzipiert, kein
backup-kritischer Datenbestand — das Backup-Konzept aus Abschnitt 1 gilt
unverändert weiter, `pg-data` bleibt NICHT das einzige Volume, das gesichert
werden muss.

**Offen und hier bewusst nicht beschönigt:** der Rekonstruktionspfad aus
der Git-Historie (Reindex baut `page_versions` aus den Commits neu auf)
ist Teil von Etappe 2 und existiert noch nicht. Bis Etappe 2 nachgezogen
ist, gilt daher: **geht `pg-data` verloren, sind die Zuordnungen
Version→Git-Merge-SHA unwiederbringlich weg**, bis Etappe 2 diesen
Rekonstruktionspfad nachliefert — ein `POST /admin/reindex` bringt die
Versionstabelle NICHT zurück. Nicht verloren sind dabei die Versionen
selbst: Versionsnummer und Changelog stehen weiterhin im Frontmatter jeder
Seite (Quelle der Wahrheit, s. Design-Doku „Entschiedene Eckpunkte") und
sind über die Git-Historie jederzeit von Hand nachvollziehbar — nur die
komfortable Versionsliste/-diff in der App (Etappe 2) fehlt bis dahin für
Versionen, die vor dem Datenverlust vergeben wurden.

### Bekannte Grenze: Verschieben/Umbenennen

Die (künftige) Rekonstruktion aus der Git-Historie scannt pfadbasiert.
Wird eine Seite verschoben oder umbenannt, verliert die Rekonstruktion
dadurch die Versionen von VOR dem Rename — sie tauchen in einer
rekonstruierten Versionsliste nicht mehr auf, obwohl sie im Frontmatter-
Changelog der Seite weiterhin stehen. Diese Grenze betrifft nur die
Rekonstruktion (Etappe 2), nicht das Frontmatter selbst.

### Migration

Neu in Etappe 1: `apps/api/drizzle/0008_dapper_vivisector.sql` (Tabelle
`page_versions`, Spalte `pages.last_blob_sha`). Wie jede Migration läuft sie
über den regulären Migrationslauf (Abschnitt 3, Schritt 4) —
`docker compose ... run --rm api node dist/db/migrate-cli.js` vor dem
Hochfahren der neuen Container, keine gesonderte Aktion nötig.

## 10. Classifications and release archive

Design: `docs/superpowers/specs/2026-10-01-security-klassen-und-release-archiv-design.md`.
User-facing description: Admin Guide pages *Classifications* and *Releases*.

- **Migrations:** `0010` adds `api_tokens.max_classification` (default
  `internal`), `0011` the table `page_releases`. Both run with the regular
  migration step before starting the new containers.
- **Classifications** are switched on per space with a `classification:` block
  in `_meta/schema.yaml`; without it nothing changes. The class itself lives in
  each page's frontmatter, so it needs no backup beyond Git.
- **Release archive:** frozen copies live in Git under
  `<page folder>/_releases/<version>/` and are covered by the Forgejo backup
  like every page. `page_releases` is a derived cache: a full reindex
  (`POST /admin/reindex`) rebuilds it from the `_releases/` folders, marks
  copies changed after freezing as `tampered` and drops rows whose copy was
  deleted.
