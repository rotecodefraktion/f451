# @f451/api

Backend der f451-Wiki-Plattform: rebuildbarer Postgres-Index über ein oder
mehrere Git-Repos (Forgejo/GitHub) plus die Lese-API dafür. Der Index ist
**Cache** — jederzeit aus dem Git-Repo neu aufbaubar (siehe „Reindexierung"
unten). Einziger dauerhafter Zustand außerhalb von Git sind `locks` (und
später Sessions).

## Module

- **`src/db/`** — Drizzle-Schema (`spaces`, `pages`, `edges`, `tags`, `locks`)
  und `createDb(connectionString)` (Verbindung + Migrationen). Migrationen
  liegen unter `drizzle/`, generiert per `pnpm db:generate`, angewendet per
  `pnpm db:migrate`.
- **`src/spaces/`** — `loadSpacesConfig(env)` liest `F451_SPACES` (Fail-Fast:
  wirft bei Fehlkonfiguration sofort beim Start) und `createProviderRegistry(env)`
  baut daraus die passenden `ForgejoProvider`/`GitHubProvider`-Instanzen
  (`@f451/git-provider`).
- **`src/indexer/`** — `indexSpace()` (Voll-Reindex: Baum lesen, parsen,
  Links/Hierarchie/Relations auflösen, HTML+Suchvektor cachen),
  `indexChangedFiles()` (inkrementelles Indexieren nach Webhook, inkl.
  Broken-Link-Heilung) und `checkDrift()` (HEAD-Abgleich-Job).
- **`src/templates/`** — `registry.ts` (Phase 3c Task 2): `listTemplates`/
  `readTemplateBody` lesen `_templates/*.md` direkt vom Provider (Space-Repo
  und optional das globale Templates-Repo, `F451_GLOBAL_TEMPLATES`) — diese
  Dateien werden bewusst NICHT vom Indexer erfasst.
- **`src/routes/`** — `webhooks.ts` (`POST /webhooks/forgejo` + `/webhooks/github`,
  HMAC-geprüft, stößt `indexChangedFiles` asynchron an), `admin.ts`
  (`POST /admin/reindex`, Token-geschützt), `pages.ts` + `search.ts` (Lese-API:
  Tree, Page, Raw, Suche), `templates.ts` (`GET /api/spaces/:space/templates`,
  siehe „Lese-API — Space-/Pages-Endpunkte" unten; Phase 3c Task 4: `POST
  /api/spaces/:space/templates` — „Als Template speichern", DIREKT-Commit auf
  `main`, siehe dort), `auth.ts` (Login/Callback/Logout, Provider-Verknüpfung —
  siehe „Auth" unten), `drafts.ts` (Draft-Lifecycle + Autosave + Media-Upload
  + Phase 3e Task 2: `PUT .../draft/diagram`, draw.io-/Excalidraw-Diagramme
  anlegen/überschreiben),
  `create-page.ts` (Phase 2d Task 5: `POST /api/pages`, neue Seite als
  Draft-only-Seite), `locks.ts` (Soft-Locks) und `workflow.ts` (Phase 2d Task 3:
  Review anfordern, Freigeben & mergen, Entwurf aktualisieren; Task 4:
  `GET .../review` liefert das visuelle Diff für die Review-Ansicht, siehe
  `@f451/markdown#diffMarkdown`) — siehe „Draft-API (Schreiben)" und
  „Workflow-API" unten. Alle Leseoperationen laufen ausschließlich gegen
  `ref='main'`.
- **`src/drafts/`** — `branch-name.ts` (git-sicheres `draft/<pageId>`-Mapping),
  `lifecycle.ts` (Anlegen/Lesen/Verwerfen, Zustandsableitung `working` ⇔
  Branch existiert; Phase 2d Task 2: `getWorkflowState` erweitert das additiv
  um `review` ⇔ offener PR, `cleanupMergedDraft` räumt Branch/Draft-Index/Lock
  nach einem Merge auf — Muster geteilt zwischen Webhook und der Release-Route),
  `save.ts` (Autosave mit SHA-409-Vertrag + inkrementelle Draft-Indexierung),
  `update.ts` (Phase 2d Task 3: Randfall Draft↔main auseinandergelaufen —
  `take-main`/`keep-mine`, siehe „Workflow-API" unten), `upload.ts` +
  `svg-sanitize.ts` (Media-Upload, Magic-Bytes-Prüfung, SVG-Sanitizing),
  `user-provider.ts` (Provider-Instanz mit dem Token des angemeldeten Nutzers —
  echte Autorschaft, kein Service-Account).
- **`src/auth/`** — `crypto.ts` (AES-256-GCM-Token-Verschlüsselung,
  Session-Id-Erzeugung), `sessions.ts` (Session-Lifecycle, httpOnly-Cookie,
  `requireSession`-preHandler), `oidc.ts` (Entra-Login mit PKCE/state/nonce via
  `openid-client`), `connect.ts` (Forgejo-/GitHub-Kontoverknüpfung, verschlüsselte
  Token-Ablage), `permissions.ts` (Berechtigungs-Vererbung von der Git-Plattform
  inkl. Schreibrechte-Probe `canWriteSpace`, 5-min-Cache). Details: Spec
  Abschnitt 7 (`docs/superpowers/specs/2026-07-09-doku-plattform-design.md`).

## Environment-Variablen

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `DATABASE_URL` | ja (für alles außer `/healthz`) | Postgres-Verbindung. Ohne sie antwortet `/readyz` mit 503 und Webhook-/Admin-/Lese-Routen werden gar nicht erst registriert. |
| `PORT` | nein (Default `3001`) | HTTP-Port. |
| `F451_SPACES` | nein* | JSON-Array konfigurierter Spaces: `[{"id","name","provider":"forgejo"\|"github","owner","repo","defaultLang"}]`. Fehlt sie, läuft die API im Minimalmodus (nur `/healthz`, `/readyz`) — kein Deployment-Fehler, nur reduzierter Funktionsumfang. |
| `F451_FORGEJO_URL` | ja, wenn ein Space `provider:"forgejo"` nutzt | Basis-URL der Forgejo-Instanz (ohne `/api/v1`). |
| `F451_FORGEJO_TOKEN` | ja, wenn ein Space `provider:"forgejo"` nutzt | Service-Account-Token (der Indexer liest/schreibt nie als Nutzer, sondern als Service-Account). |
| `F451_GITHUB_TOKEN` | ja, wenn ein Space `provider:"github"` nutzt | Service-Account-Token für die GitHub-API. |
| `F451_WEBHOOK_SECRET_FORGEJO` | ja, für Forgejo-Webhooks | HMAC-Secret, muss mit dem im Forgejo-Repo hinterlegten Webhook-Secret übereinstimmen. |
| `F451_WEBHOOK_SECRET_GITHUB` | ja, für GitHub-Webhooks | HMAC-Secret, muss mit dem im GitHub-Repo hinterlegten Webhook-Secret übereinstimmen. |
| `F451_ADMIN_TOKEN` | ja, für `/admin/reindex` | Bearer-Token. Fehlt es, lehnt der Endpunkt **jede** Anfrage mit 503 ab (Fail-Closed). Zusätzlich zum Admin-Token verlangt `/admin/*` bei aktiver Auth (s. u.) auch eine gültige Session. |
| `F451_OIDC_ISSUER` | nein* | Issuer-URL des OpenID-Providers (Entra ID). Gesetzt = Auth aktiv: `/api/*` und `/admin/*` erfordern ab dann eine Session; `F451_TOKEN_KEY` wird Pflicht. Fehlt sie, bleibt die API im 1c-Verhalten (alles offen, keine Auth-Routen). |
| `F451_OIDC_CLIENT_ID` | ja, wenn `F451_OIDC_ISSUER` gesetzt | Client-Id der bei Entra registrierten App. |
| `F451_OIDC_CLIENT_SECRET` | ja, wenn `F451_OIDC_ISSUER` gesetzt | Client-Secret der App-Registrierung. |
| `F451_OIDC_REDIRECT_URL` | ja, wenn `F451_OIDC_ISSUER` gesetzt | Öffentliche Callback-URL, exakt wie bei Entra hinterlegt: `https://<api-host>/auth/callback`. |
| `F451_TOKEN_KEY` | ja, wenn `F451_OIDC_ISSUER` gesetzt | 32 Byte, base64-kodiert (`openssl rand -base64 32`). Schlüssel zur AES-256-GCM-Verschlüsselung der Provider-Tokens (`provider_accounts`). Fehlt er bei konfiguriertem OIDC, bricht der Start sofort ab (Fail-Fast). |
| `F451_INSECURE_COOKIES` | nein | `1` deaktiviert `secure` auf Session-/Transaktions-Cookies (nur für lokale HTTP-Entwicklung; in Produktion **nicht** setzen). |
| `F451_OIDC_ALLOW_INSECURE` | nein | Phase 4a Task 3 (Auth-Härtung M2): `1` erlaubt http-Issuer bei der OIDC-Discovery, unabhängig von `F451_INSECURE_COOKIES`. Ohne gesetzte Variable gilt der Wert von `F451_INSECURE_COOKIES` als Default (abwärtskompatibel). In Produktion **nicht** setzen. |
| `F451_FORGEJO_OAUTH_CLIENT_ID` / `F451_FORGEJO_OAUTH_CLIENT_SECRET` | nein* | Aktivieren „Forgejo verbinden" (`GET /auth/connect/forgejo`). Verwenden dieselbe Instanz wie `F451_FORGEJO_URL` (Indexer-Service-Account und Nutzer-Verknüpfung teilen sich eine Forgejo-Instanz). Ohne sie ist die Forgejo-Verknüpfung nicht verfügbar. |
| `F451_GITHUB_OAUTH_CLIENT_ID` / `F451_GITHUB_OAUTH_CLIENT_SECRET` | nein* | Aktivieren „GitHub verbinden" (`GET /auth/connect/github`). Ohne sie ist die GitHub-Verknüpfung nicht verfügbar. |
| `F451_MAX_UPLOAD_MB` | nein (Default `10`) | Größenlimit in MiB für `POST /api/pages/:id/draft/media` (Phase 2a Task 5). Überschreitungen werden serverseitig als Streaming-Grenze durchgesetzt (kein Puffern übergroßer Uploads), Antwort `413`. |
| `F451_PUBLIC_BASE_URL` | in Produktion: ja | Öffentliche Basis-URL der f451-Oberfläche (Schema + Host, ohne Pfad — die URL, unter der Nutzer das Wiki im Browser erreichen). Seit Phase 4a Task 3 **sicherheitsrelevant**, nicht mehr nur kosmetisch: (1) Basis der OAuth-`redirect_uri` der Provider-Verknüpfungs-Routen (`/auth/connect/*`) — ohne sie wird die `redirect_uri` aus dem Host-Header gebaut (Angreifer-beeinflussbar, nur als Dev-Fallback gedacht); (2) „eigene Origin" des CSRF-Origin-Checks für mutierende Browser-Requests (POST/PUT/PATCH/DELETE mit fremdem `Origin`-Header → 403) — ohne sie vergleicht der Check gegen den Host-Header des jeweiligen Requests. **Fehlkonfiguration** (Wert ≠ echte Browser-Origin) blockiert alle mutierenden Browser-Requests mit 403 „Ungültige Origin". Zusätzlich (Phase 2d Task 3): `POST /api/pages/:id/review` hängt dem PR-Body einen Link zur Review-Ansicht an (`<F451_PUBLIC_BASE_URL>/wiki/<space>/<pageId>/review`); ohne sie bleibt der PR-Body linklos. |
| `F451_GLOBAL_TEMPLATES` | nein | JSON-Objekt `{"provider":"forgejo"\|"github","owner":"…","repo":"…"}` (Phase 3c Task 2) — ein providerweites Zusatz-Repo, dessen `_templates/*.md` `GET /api/spaces/:space/templates` zusätzlich zu den Space-eigenen Vorlagen listet. Fail-Fast bei invalidem JSON/fehlenden Feldern, unabhängig von `F451_SPACES`. Fehlt sie, liefert die Route nur Space-Templates (Bestandsverhalten). Ist das globale Repo zur Laufzeit nicht erreichbar, wird NUR diese Quelle übersprungen (warn-Log) — die Space-Templates bleiben unberührt (Lesen darf nie ganz ausfallen). |
| `F451_TRUST_PROXY` | nein (Default: kein Trust — `req.ip` = Socket-Adresse) | Phase 4a Task 2: hinter dem Reverse Proxy des Compose-Deployments (Spec §8) nötig, damit Rate-Limits (s. u.) und `req.ip` pro echter Client-IP statt pro Proxy-IP zählen. Zahl `n` = die letzten `n` Hops von `X-Forwarded-For` sind vertraut (Produktion: `1`, der eigene Proxy); `true` vertraut allen Hops (nur exotische Setups — das linkeste, client-spoofbare Glied würde sonst zur `req.ip`, die Rate-Limits wären umgehbar). Details/Einordnung: `deploy/BETRIEB.md`. |
| `F451_RATE_LIMIT_AUTH_MAX` | nein (Default `10`) | Phase 4a Task 2: Anfragebudget pro Minute **pro Auth-Route und Client-IP** (`@fastify/rate-limit`, eigener Zähler je Route) für die 6 Auth-/Connect-Routen (`GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /auth/connect/:provider`, `GET /auth/connect/:provider/callback`, `DELETE /auth/connect/:provider`). Überschreitung → `429 {status:'rate_limited', reason}`. Ungesetzt/ungültig → Default. Details: `deploy/BETRIEB.md`. |
| `F451_RATE_LIMIT_SEARCH_MAX` | nein (Default `60`) | Phase 4a Task 2: Anfragebudget pro Minute pro Client-IP für `GET /api/search` (inkl. `?ref=draft`). Überschreitung → `429 {status:'rate_limited', reason}`. Ungesetzt/ungültig → Default. Details: `deploy/BETRIEB.md`. |

*Alle Spaces-/Provider-/Webhook-/Admin-Variablen sind optional im Sinne von
„ohne sie läuft die API trotzdem, nur mit weniger Funktionsumfang". Ist
`F451_SPACES` gesetzt, aber z. B. ein benötigtes Provider-Token fehlt, wirft
der Start sofort einen Fehler (Fail-Fast — Fehlkonfiguration ist ein
Deployment-Fehler).

Siehe auch `deploy/wiki/.env.example` für ein vollständiges Beispiel und
`deploy/wiki/docker-compose.yml` für die Durchreichung an den `api`-Service.

## Reindexierung

Der Index lässt sich jederzeit gefahrlos wegwerfen und neu aufbauen — er ist
reine Ableitung aus dem Git-Repo. Zwei Wege:

1. **Admin-Endpunkt** — `POST /admin/reindex` mit Bearer-Token
   (`F451_ADMIN_TOKEN`), Body optional `{"space": "<space-id>"}` (sonst alle
   konfigurierten Spaces). Antwort ist ein Teilbericht-Array
   `[{space, report}|{space, error}]` — ein scheiternder Space verhindert nie
   die Reports der übrigen (Statuscode 200, wenn mindestens ein Space
   erfolgreich war, 502 nur wenn alle scheitern).

   ```bash
   curl -X POST http://localhost:3001/admin/reindex \
     -H "Authorization: Bearer $F451_ADMIN_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{}'
   ```

2. **Drift-Job** — läuft automatisch alle 5 Minuten (`src/server.ts`,
   `setInterval`) für alle konfigurierten Spaces: vergleicht den aktuellen
   `main`-HEAD-SHA mit dem zuletzt vollständig indexierten (`spaces.indexedHeadSha`)
   und stößt bei Abweichung (oder nach einem unvollständigen Lauf, siehe
   `filesSkippedIo` in `IndexReport`) automatisch einen Voll-Reindex des
   betroffenen Space an. Kein manueller Eingriff nötig — der Admin-Endpunkt ist
   für sofortige/manuelle Reindexierung (z. B. nach einer Konfigurationsänderung).

## Betriebsstatus — `GET /admin/status` (Phase 4a Task 5)

Liefert die In-Memory-Fehlerzähler (`src/ops/counters.ts` — `webhookErrors`,
`indexerErrors`, `driftErrors`, jeweils seit Prozessstart, plus `since`, dem
ISO-Zeitstempel des Prozessstarts bzw. der Instanz-Erzeugung) und die
Prozess-Uptime in Sekunden.
Dieselbe `OpsCounters`-Instanz beliefert sowohl diese Route als auch den
Indexer/die Webhook-Routen/den Drift-Job — die Zähler sind reines
Betriebssignal (kein Ersatz für strukturiertes Logging, siehe
`deploy/BETRIEB.md`), nicht persistiert, verlieren ihren Stand bei jedem
Neustart.

**Dasselbe Admin-Gate wie `POST /admin/reindex`** (`requireAdminToken`,
`src/routes/admin.ts`) — Bearer-Token gegen `F451_ADMIN_TOKEN`, zeitkonstant
verglichen: fehlt das Token serverseitig, antwortet der Endpunkt **fail-closed**
mit `503` (nie „offen"); stimmt das mitgeschickte Bearer-Token nicht, `401`.
Kein separates, schwächeres Auth-Muster für diesen nur lesenden Endpunkt — die
Zähler selbst sollen nicht unauthentifiziert nach außen.

```bash
curl -H "Authorization: Bearer $F451_ADMIN_TOKEN" http://localhost:3001/admin/status
# → 200 {"counters":{"webhookErrors":0,"indexerErrors":0,"driftErrors":0,"since":"…"},"uptime":123}
```

- `200` `{ counters: { webhookErrors, indexerErrors, driftErrors, since }, uptime }`
- `401` ungültiges/fehlendes Bearer-Token
- `503` `F451_ADMIN_TOKEN` nicht gesetzt (Endpunkt deaktiviert)

## Webhook-Einrichtung

Push-Events auf den `main`-Branch lösen inkrementelles Indexieren aus (nur die
geänderten Dateien werden gelesen, nicht der ganze Baum). Events auf andere
Branches oder von unbekannten Repos werden mit `202 ignoriert` quittiert.

**Forgejo** (Repo → Settings → Webhooks → Add Webhook → Forgejo):
- URL: `https://<api-host>/webhooks/forgejo`
- Content-Type: `application/json`
- Secret: Wert von `F451_WEBHOOK_SECRET_FORGEJO`
- Trigger: `Push events` **und** `Pull Request events` (Letzteres für den
  Nach-Merge-Cleanup, siehe unten — ohne diesen Trigger räumt nur die
  synchrone Release-Route auf, Interop mit einem nativen Merge im
  Forgejo-UI bleibt dann aus).

**GitHub** (Repo → Settings → Webhooks → Add webhook):
- Payload URL: `https://<api-host>/webhooks/github`
- Content type: `application/json`
- Secret: Wert von `F451_WEBHOOK_SECRET_GITHUB`
- Trigger: „Let me select individual events" → `Pushes` **und** `Pull requests`

Signaturen werden geprüft, bevor irgendetwas verarbeitet wird — fehlt die
Signatur oder stimmt sie nicht (`X-Gitea-Signature` bzw.
`X-Hub-Signature-256`, HMAC-SHA256 über den Raw-Body), antwortet der Endpunkt
mit `401` und der Payload wird verworfen.

**Event-Typ-Erkennung** (Phase 2d Task 2): Beide Routen lesen den Event-Typ-
Header (Forgejo/Gitea `X-Gitea-Event`, GitHub `X-GitHub-Event`) — fehlt er
oder ist er nicht `pull_request`, bleibt es beim Bestandsverhalten (`push`).

**`pull_request`-Event — Nach-Merge-Cleanup:** Wird ein Review-PR **nativ**
im Forgejo-/GitHub-UI gemergt (statt über `POST /api/pages/:id/release`,
Task 3 — der primäre, synchrone Pfad), räumt dieses Event denselben Bestand
auf: Draft-Branch, Draft-Index-Zeile (`ref='draft'`) und ein eventuell
gehaltener Lock werden gelöscht (`cleanupMergedDraft`, Reihenfolge DB vor
Branch wie beim manuellen Verwerfen; ein bereits vom Provider gelöschter
Branch — „Branch löschen"-Häkchen beim Merge — ist kein Fehlerfall). Erkannt
wird ein solcher Merge über `action === 'closed'` **und**
`pull_request.merged === true` **und** einen Head-Branch nach dem Muster
`draft/<pageId>`; ein geschlossener, aber NICHT gemergter PR (abgelehnt) wird
mit `202 ignoriert` quittiert — der Draft bleibt unverändert stehen, die
Autorin kann weiterarbeiten. Das Neu-Rendern der main-Seite übernimmt NICHT
dieses Event, sondern der ohnehin unmittelbar danach eintreffende
`push`-auf-`main`-Webhook (jeder Merge ist zugleich ein Push).

Die pageId wird dafür NICHT naiv aus dem Branch-Namen zurückgerechnet (das
ginge für den NORMALFALL schief — siehe unten), sondern per RÜCKWÄRTS-SUCHE
über die offenen Drafts des betroffenen Space ermittelt
(`findPageIdForDraftBranch`, `drafts/lifecycle.ts`, Fix-Runde 1): Kandidaten
sind alle `pages`-Zeilen mit `ref='draft'` sowie alle `locks`-Zeilen des Space;
für jede Kandidaten-Id wird `draftBranchName` erneut berechnet und mit dem
Head-Branch verglichen — ein Treffer liefert die echte pageId, auch wenn der
Branch-Name wegen git-unsicherer Zeichen einen Hash-Suffix trägt
(`drafts/branch-name.ts`). Kein Treffer (z. B. ein erneut zugestellter Webhook
nach bereits erfolgtem Cleanup) → nur der Branch wird (tolerant) entfernt,
ohne DB-Aufräumen, mit Log.

Hintergrund, warum das wichtig ist: Die Fallback-Id des Indexers für Seiten
OHNE Frontmatter-`id` ist `path:<spaceId>/<filePath>`
(`indexer/index-space.ts`) und enthält damit immer `:` und `/` — git-unsichere
Zeichen, die `draftBranchName` durch einen Hash-Suffix ersetzt. Seiten ohne
Frontmatter-`id` sind der NORMALFALL (nicht die Ausnahme), ein rein
präfix-strippendes Zurückrechnen der pageId aus dem Branch-Namen (frühere
Implementierung, Important-Review-Befund) traf diesen Fall also im Regelfall,
nicht im Ausnahmefall — Draft-Index-Zeile und Lock blieben nach einem nativen
Merge verwaist, obwohl der Branch korrekt gelöscht wurde.

## Auth

Vollständig beschrieben in der Spec, Abschnitt 7
(`docs/superpowers/specs/2026-07-09-doku-plattform-design.md`). Kurzfassung
für den Betrieb dieses Service:

- **Kein eigener Nutzerbestand, keine Passwörter.** Login ausschließlich über
  Azure Entra ID (OIDC). Die OIDC-`sub`-Claim ist die stabile User-Id.
- **Sessions** leben in Postgres (`sessions`-Tabelle), TTL 7 Tage mit
  Sliding-Refresh (verlängert sich bei jedem Zugriff, sobald weniger als 50 %
  der TTL übrig sind). Der Browser trägt nur eine zufällige Session-Id in
  einem `httpOnly`, `sameSite=lax`, `secure`-Cookie (`f451_session`) — dessen
  `maxAge` folgt bewusst derselben 7-Tage-TTL wie die Server-Session
  (persistentes Login, kein Cookie das beim Schließen des Browsers verschwindet).
- **Provider-Verknüpfung:** Um eine Forgejo- oder GitHub-gestützte Space lesen
  zu können, muss der Nutzer das jeweilige Konto einmalig per OAuth
  verknüpfen ("Forgejo verbinden" / "GitHub verbinden"). Das Access-Token wird
  AES-256-GCM-verschlüsselt in `provider_accounts` abgelegt
  (`F451_TOKEN_KEY`) — nie im Klartext in der DB, nie in Logs oder
  Fehlermeldungen.
- **Berechtigungs-Vererbung:** Es gibt kein eigenes Rollensystem. Ob ein Space
  für einen Nutzer sichtbar/lesbar ist, wird live gegen den Git-Provider
  geprüft (`GET /api/v1/repos/{owner}/{repo}` bzw. GitHub-Äquivalent, mit dem
  verknüpften Nutzer-Token). 200 → lesbar, alles andere (inkl. fehlender
  Verknüpfung) → nicht lesbar, mit `404` (nicht `403`) beantwortet — private
  Repos werden nicht als "existent, aber verboten" verraten. Ergebnisse werden
  pro `(userId, spaceId)` 5 Minuten gecacht, um nicht jede Anfrage gegen den
  Provider zu proben; ein Disconnect oder ein frisches Connect invalidieren
  den Cache des Nutzers sofort.
- **Rate-Limit** (Phase 4a Task 2, Spec §7): alle 6 Auth-/Connect-Routen
  (`GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`,
  `GET /auth/connect/:provider`, `GET /auth/connect/:provider/callback`,
  `DELETE /auth/connect/:provider`) tragen ein eigenes Anfragebudget PRO ROUTE
  und Client-IP (`@fastify/rate-limit`, Default `10`/Minute je Route,
  konfigurierbar über `F451_RATE_LIMIT_AUTH_MAX`, s. Env-Tabelle oben) —
  KEIN gemeinsames Gruppenbudget über alle sechs Routen. Überschreitung →
  `429 {status:'rate_limited', reason:'Zu viele Anfragen — bitte kurz warten.'}`.
  Hinter einem Reverse Proxy muss `F451_TRUST_PROXY` gesetzt sein, sonst
  zählt das Limit alle Nutzer gemeinsam über die Proxy-IP (s. Env-Tabelle).
- **Provider-Token-Refresh** (Phase 4b Task 4, Spec §9 „Token-Refresh
  automatisch"): der bei der Kontoverknüpfung gespeicherte
  `encryptedRefreshToken` wurde vorher NIE eingelöst — ein abgelaufenes
  Provider-Token führte direkt zum harten Re-Login statt zur stillen
  Erneuerung. `drafts/user-provider.ts#getUserProvider` ist die EINE
  zentrale Stelle, über die alle Schreib-Pfade (Draft/Save/Media/Diagramm/
  Workflow/Create-Page/Templates) an ihre `GitProvider`-Instanz kommen — sie
  liefert die Instanz mit `auth/token-refresh.ts#withTokenRefresh` ummantelt
  zurück: antwortet der Provider (Forgejo/GitHub) auf **irgendeinen**
  Methodenaufruf mit `401`, wird **genau EIN** Refresh-Versuch unternommen
  (`grant_type=refresh_token` gegen den jeweiligen Token-Endpoint, neue
  Access-/Refresh-Tokens werden über dieselbe AES-256-GCM-Verschlüsselung
  wie beim Connect-Flow persistiert) und der ursprüngliche Aufruf EINMAL mit
  dem neuen Token wiederholt. Lehnt der Provider den Refresh ab (widerrufen,
  abgelaufen, nicht konfiguriert) oder ist gar kein Refresh-Token gespeichert
  (z. B. GitHub — der Connect-Flow fordert dort nie einen an), propagiert der
  URSPRÜNGLICHE 401 unverändert weiter → bestehende Re-Login-Fallback-Strecke
  (Session bleibt gültig, aber die Provider-Verknüpfung muss neu hergestellt
  werden). Parallele Refresh-Versuche für denselben (Nutzer, Provider) werden
  auf EINEN tatsächlichen Provider-Aufruf dedupliziert (In-Prozess-Mutex,
  wichtig bei Forgejos rotierenden Refresh-Tokens — ein zweiter Versuch mit
  dem bereits verbrauchten Token würde sonst unnötig fehlschlagen).

### Flow

```
Login:
  Browser → GET /auth/login → 302 zum Entra-Authorize-Endpoint
          ← Entra: Nutzer meldet sich an, Redirect zurück mit ?code&state
  Browser → GET /auth/callback?code&state
          → Code-Tausch (PKCE), ID-Token-Validierung (Signatur/Issuer/Audience/nonce)
          → User-Upsert, Session anlegen, Set-Cookie f451_session
          ← 302 auf `/` (oder `?next=`, nur relative Pfade)

Provider-Verknüpfung (pro Provider, erfordert bereits eine Session):
  Browser → GET /auth/connect/forgejo → 302 zum Forgejo-Authorize-Endpoint
          ← Forgejo: Nutzer autorisiert die App, Redirect zurück mit ?code&state
  Browser → GET /auth/connect/forgejo/callback?code&state
          → Token-Tausch, Login-Name per API abrufen
          → Access-/Refresh-Token AES-256-GCM-verschlüsselt in provider_accounts speichern
          ← 302 auf `/`
  (analog für GET /auth/connect/github; DELETE /auth/connect/:provider löst die Verknüpfung wieder)

Geschützter Zugriff:
  Browser → GET /api/... (Cookie f451_session)
          → requireSession lädt req.user; ohne Session: 401
          → requireSpaceAccess probt (gecacht) das Nutzer-Token gegen den Provider
          → Space unbekannt/nicht lesbar → 404 (Tree/Suche gefiltert, Page/Raw 404)

Logout:
  Browser → POST /auth/logout → Session gelöscht, Cookie geleert → 204
```

### Entra-App-Registrierung

1. Azure Portal → **App registrations** → **New registration**.
2. **Redirect URI** (Platform: „Web"): `https://<api-host>/auth/callback` —
   muss exakt `F451_OIDC_REDIRECT_URL` entsprechen.
3. Unter **Certificates & secrets** ein Client-Secret erzeugen → `F451_OIDC_CLIENT_SECRET`.
4. **Application (client) ID** → `F451_OIDC_CLIENT_ID`; **Directory (tenant) ID**
   ergibt den Issuer → `F451_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`.
5. Unter **API permissions** reichen die Standard-`openid`/`email`/`profile`-Scopes
   (Delegated, `Microsoft Graph`) — keine zusätzlichen Admin-Consent-Rechte nötig.
6. `F451_TOKEN_KEY` unabhängig davon erzeugen: `openssl rand -base64 32`.

### Forgejo-OAuth-App (für „Forgejo verbinden")

1. Auf der Forgejo-Instanz (derselben wie `F451_FORGEJO_URL`) als Admin oder
   als der jeweilige Nutzer: **Settings → Applications → OAuth2 Applications**
   → **Create a new OAuth2 Application**.
2. **Application Name:** z. B. `f451`.
3. **Redirect URI:** `https://<api-host>/auth/connect/forgejo/callback` —
   die Callback-URL wird von der API selbst aus dem eingehenden Request
   gebildet (Protokoll + Host), nicht separat konfiguriert; sie muss hier
   trotzdem exakt hinterlegt sein, sonst lehnt Forgejo den Authorize-Request ab.
4. Die angezeigte **Client ID** / **Client Secret** → `F451_FORGEJO_OAUTH_CLIENT_ID`
   / `F451_FORGEJO_OAUTH_CLIENT_SECRET`.
5. Für GitHub analog: eine OAuth-App unter `https://github.com/settings/developers`
   mit **Authorization callback URL** `https://<api-host>/auth/connect/github/callback`
   anlegen → `F451_GITHUB_OAUTH_CLIENT_ID` / `F451_GITHUB_OAUTH_CLIENT_SECRET`.

## Lese-API — Space-/Pages-Endpunkte

Neben `GET /api/spaces`, `GET /api/spaces/:space/tree`, `GET /api/pages/:id`
und `GET /api/pages/:id/raw` (siehe „Module" oben):

`GET /api/pages/:id/raw?download=1` (Feature „Markdown-Export"): identisch
zum unparametrierten Aufruf, ergänzt aber `Content-Disposition: attachment;
filename="<Verzeichnis-der-Seite>.md"`, damit der Browser die Datei
herunterlädt statt sie inline zu öffnen. Ohne den Parameter bleibt der
Interop-Endpunkt unverändert.

### `GET /api/spaces/:space/broken-links` (Phase 3a)

Space-weiter Broken-Link-Report (Spec §5). Liefert pro Seite mit nicht
auflösbaren Verweisen `{ pageId, title, path, entries: [{ rawTarget,
type: 'link'|'relation', label }] }`, pfad-sortiert; `label` ist bei
`relation` der Relationstyp (z. B. `depends_on`). Nur `ref='main'`.
Unbekannter oder nicht lesbarer Space → 404 (kein Existenz-Orakel).

### `GET /api/spaces/:space/graph` und `GET /api/pages/:id/graph` (Phase 3b)

`GET /api/spaces/:space/graph?types=hierarchy,link,relation,tag` — Graph des Space (Spec §5). Knoten = alle `ref='main'`-Seiten (`{ id, title, path, status, tags, updatedAt }`), Kanten = `{ from, to, type, label }`; `types` (CSV, Default `hierarchy,link,relation`) schaltet Kantentypen, `tag`-Kanten werden zur Abfragezeit berechnet (Label = Tag). `status` ist für Schreibberechtigte um `working` (Entwurf existiert, aus dem Index) und `review` (offener PR, ein Provider-Call pro Aufruf; bei Provider-Fehler degradiert) angereichert — reine Leser sehen nur `released`/`archived`. Unbekannter/nicht lesbarer Space → 404 (kein Existenz-Orakel); unbekannter Kantentyp → 400.

`GET /api/pages/:id/graph?depth=1..4&types=…` — Nachbarschaft einer Seite (Default-Tiefe 2), BFS in beiden Richtungen (eingehende Kanten zählen — „wer hängt von mir ab?"). Antwort-Shape, `types`- und Status-Semantik wie beim Space-Graph. Unbekannte Seite → 404.

### `GET /api/spaces/:space/templates` (Phase 3c Task 2)

Listet die im Space verfügbaren Vorlagen (Spec §6): `_templates/*.md`-Dateien
(keine Unterordner, YAGNI) im Space-Repo sowie — falls `F451_GLOBAL_TEMPLATES`
konfiguriert ist — zusätzlich aus dem globalen Templates-Repo. Diese Dateien
werden vom Indexer NICHT erfasst (der matcht nur `index.md`) und tauchen daher
nie im Seitenbaum/in der Suche auf — ein eigenes, kleines Registry-Modul
(`src/templates/registry.ts`) liest sie bei jedem Aufruf direkt vom Provider.

Antwort: `200` `TemplateSummary[]`, jedes Element `{ id, name, description,
source: 'space'|'global' }`. `id` = `<source>:<dateiname-ohne-.md>` (z. B.
`space:meeting-notiz`, `global:adr`); `name` = `frontmatter.title` der Datei,
sonst der Dateiname; `description` = `frontmatter.description`, sonst `''`.
Sortierung: Space-Templates vor globalen, innerhalb einer Quelle nach `name`
(`localeCompare('de')`). Ist eine der beiden Quellen (Provider-Ausfall) nicht
erreichbar, wird NUR diese übersprungen (warn-Log) — die andere Quelle liefert
weiterhin ihr Ergebnis. Unbekannter oder nicht lesbarer Space → 404 (kein
Existenz-Orakel, Muster wie `broken-links`/`graph`).

`readTemplateBody` (`src/templates/registry.ts`) liest den Inhalt EINES
Templates per `id` und liefert `{ name, body }` mit `body` = Markdown OHNE den
Frontmatter-Block. Lehnt jede `id` ab, deren Datei-Teil nicht dem Muster
`[a-z0-9._-]+` entspricht oder `..` enthält (Pfad-Traversal-Schutz — die Id
fließt direkt in den `readFile`-Pfad), ebenso unbekannte Quellen-Präfixe und
ein `global:`-Präfix ohne konfiguriertes globales Repo — in allen Fällen
`null` statt eines Fehlers. Seit Phase 3c Task 3 nutzt `POST /api/pages`
(optionales `templateId`) diese Funktion, um eine neue Seite mit einem
Template-Body statt des Auto-`# <Titel>`-Anhangs anzulegen (siehe „Draft-API
(Schreiben)" unten).

### `POST /api/spaces/:space/templates` — „Als Template speichern" (Phase 3c Task 4)

Übernimmt den aktuellen Editor-Inhalt einer Seite als neue Space-Vorlage:
Body `{ name: string, description?: string, content: string }` (`content` =
der volle, aktuelle Editor-Markdown inkl. des Seiten-Frontmatters) →
committet `_templates/<slug>.md` (`<slug>` = `pathSegmentFromTitle(name)`,
dieselbe git-pfadsichere Slug-Formel wie bei der Seitenanlage,
`src/drafts/create-page.ts`) MIT dem eigenen Frontmatter (`title: <name>`,
optional `description:`) und dem Editor-Body OHNE das alte Seiten-Frontmatter
(`splitFrontmatter(content).body`).

**Direkt-Commit auf `main`, KEIN Draft-Branch/Review-Umweg** — bewusst anders
als jeder übrige Schreibpfad dieses Projekts (Autosave/Seitenanlage laufen
über `draft/<pageId>` + `POST .../review` + `POST .../release`). Begründung
(im Plan dokumentierte Entscheidung, Spec §6): eine Vorlage ist kein
Redaktionsinhalt — ein Review-Umweg für „ein Gerüst als Vorlage merken" wäre
unverhältnismäßig, und `_templates/*.md` wird vom Indexer ohnehin nicht
erfasst (kein Seiteninhalt, kein Broken-Link-/Suchindex-Bezug). Die
Rechteprüfung bleibt trotzdem **geerbt vom Provider, nicht privilegiert**: der
Commit läuft mit dem NUTZER-Token (`getUserProvider`, wie bei jedem anderen
Schreibpfad), nicht über die Service-Account-`providerRegistry` (die bleibt
dem GET-Lesepfad vorbehalten) — Forgejo/GitHub erzwingen das Push-Recht auf
`main` genauso wie bei jedem anderen direkten Push; ein Provider-403 beim
Schreiben wird 1:1 als `403` gemeldet (kein Bot-Bypass).

Gate-Kette identisch zur Seitenanlage (`resolveNewPageWriteContext`,
`src/routes/drafts.ts`, hier wiederverwendet statt dupliziert): Space
konfiguriert + lesbar (sonst `404`, kein Existenz-Orakel) → verknüpftes
Provider-Konto (sonst `403` mit `action: 'connect'`) → Schreibrecht (sonst
`403`, providerseitiges 403 beim Push eingeschlossen). Antwort: `201 { file,
path }`. `400 {status:'bad_request', reason}` — Handler-Validierung statt
strikter AJV-Constraints (Lehre aus Phase 3b: ein AJV-`required`/`minLength`
auf dem Body-Schema würde Fastifys generische Validierungsfehler-Form statt
des projektweiten `{status,reason}`-Vertrags liefern) — bei leerem/fehlendem
`name`, einem Namen ohne verwertbare Zeichen (slug-los, z. B. `"!!!"`),
fehlendem/falsch typisiertem `content` oder falsch typisierter `description`.
`409 { error, file }`, wenn unter dem Zielpfad bereits ein Template liegt
(reine Anlage, nie ein Überschreiben — kein `sha` beim `writeFile`). Jeder
sonstige Provider-Fehler → `502` (kein 500-Pfad, Lehre aus Task 3). NUR
registriert, wenn Auth aktiv ist (`canWrite`/`getUserProvider` gesetzt, Muster
Drafts-/Create-Page-Routen in `app.ts`) — `GET .../templates` bleibt
unverändert (Task-2-Bestand, offen bei fehlendem Auth).

## Draft-API (Schreiben)

Vollständig beschrieben in der Spec, Abschnitte 4/7/9. Kurzfassung als
Routen-Referenz für Phase 2c (Editor-UI), die auf dieser API aufbaut.

**Grundprinzip:** Jede Seite hat höchstens einen Draft — abgeleitet, nie
separat gespeichert: `working` ⇔ der Git-Branch `draft/<pageId>` existiert
(git-sicherer, deterministischer Name, siehe `src/drafts/branch-name.ts`);
`review` ⇔ zusätzlich ein offener Pull Request mit Head `draft/<pageId>` gegen
`main` existiert (Phase 2d Task 2, `getWorkflowState` in `src/drafts/lifecycle.ts`
— Ableitung über `listPullRequests`, KEIN eigenes Status-Feld in der DB, Spec
§4/9). Alle Schreiboperationen laufen mit dem **Token des angemeldeten Nutzers**
(`getUserProvider`, Nutzer-Konto muss verknüpft sein, s. „Auth" oben) — jeder
Commit im Draft-Branch trägt daher die echte Autorschaft des Nutzers, nie
eines Bot-/Service-Accounts.

**Workflow-Auskunft in der Lese-API (Phase 2d Task 2):** `GET /api/pages/:id`
liefert zusätzlich `workflow: { state: 'working'|'review', pr: {number, url}
| null, lock: {user, mine} | null } | null` — **NUR** für eingeloggte Nutzer
mit (gecachtem, 5 min) Schreibrecht auf den Space der Seite; Leser und
Anonyme bekommen immer `null` (kein Informationsleck über Entwürfe an
Nur-Leser). Scheitert die Provider-Anfrage beim Zustandsermitteln, liefert
das Feld ebenfalls `null` (geloggt) statt den ganzen Request scheitern zu
lassen — Lesen darf laut Spec §9 nie ausfallen, die Seite selbst kommt in
diesem Fall weiterhin unverändert aus dem Index. `lock` ist dieselbe (billige,
DB-only) Auskunft wie bei der Draft-Antwort, aber ohne `heartbeatAt` (reine
Notice-Anzeige, kein Autosave-Vertrag).

**Gates** (identisch für alle Routen dieses Abschnitts, `resolveWriteContext`
in `src/routes/drafts.ts`): Session erforderlich (sonst `401`) → Seite/Space
bekannt und für den Nutzer lesbar (sonst `404`, kein Existenz-Orakel für
private Spaces) → Provider-Konto verknüpft (sonst `403`,
`{"error": "...", "action": "connect"}`) → das verknüpfte Konto darf das
Repository schreiben (`permissions.push`, sonst `403` ohne `action`).

### `POST /api/pages` — neue Seite anlegen (Phase 2d Task 5)

Legt eine **noch nie released** Seite an — es entsteht bewusst KEIN Commit
auf `main` (das passiert erst über den normalen Review-/Release-Workflow
oben): die neue Seite existiert bis zu ihrem ersten Release ausschließlich
als **Draft-only-Seite** (`ref='draft'`-Indexzeile, kein `ref='main'`-Gegenstück).
Sie ist danach sofort über den Editor-Pfad erreichbar (`GET`/`PUT
/api/pages/:id/draft`, Locks, `POST .../review`, …) — `resolveWriteContext`
(s. o.) fällt für eine unbekannte `id` zusätzlich auf eine vorhandene
`ref='draft'`-Zeile zurück, genau für diesen Fall.

Body: `{ space: string, parentId?: string, title: string }`. `parentId`
referenziert eine bestehende Seite (main **oder** draft-only) — die neue
Seite landet in deren Verzeichnis; ohne `parentId` an der Space-Wurzel.
Zielpfad: `<Verzeichnis>/<slug(title)>/index.md` (`slug` = `@f451/markdown`s
Unicode-Slugifizierung). Initialinhalt: `---\ntitle: <Titel>\n---\n\n# <Titel>\n`
(kein Frontmatter-`id` — die Seiten-Id wird wie bei jeder anderen Seite ohne
`id:` aus dem Pfad abgeleitet, `path:<space>/<Pfad>`, **exakt dieselbe Formel**
wie der main-Indexer, `src/indexer/index-space.ts#derivePageId` — dadurch
bleibt die Id über den vollen Zyklus Anlage → Autosave → Review → Release
stabil).

Gates: Space konfiguriert + für den Nutzer lesbar (sonst `404`) → Provider-
Konto verknüpft (sonst `403` `action: "connect"`) → Schreibrecht (sonst
`403`) — dieselbe Gate-Kette wie oben, nur ausgehend vom `space`-Feld statt
einer bereits bekannten `pageId` (`resolveNewPageWriteContext` in
`src/routes/drafts.ts`).

- `201` `{ id, space, path, branch, baseSha, content }` — dieselbe Form wie
  `POST /api/pages/:id/draft`, der Editor kann die Antwort direkt öffnen.
- `400` Titel ergibt einen leeren Slug (z. B. nur Satzzeichen/Symbole)
- `403` kein verknüpftes Konto / kein Schreibrecht
- `404` Space nicht konfiguriert/nicht lesbar, oder `parentId` unbekannt
- `409` `{ error, pageId }` — unter dem Zielpfad existiert bereits eine Seite
  (main **oder** draft-only); `pageId` erlaubt dem Client, direkt dorthin zu
  verlinken statt eine zweite Seite am selben Pfad anzulegen.
- `502` Provider nicht erreichbar

### `POST /api/pages/:id/draft`

Legt den Draft-Branch vom aktuellen `main`-HEAD an, falls er noch nicht
existiert — **idempotent**: existiert er bereits, liefert derselbe Aufruf
200 mit dem unveränderten Bestand (kein Reset auf main).

- `200` `{ branch, baseSha, content, lock: {user, heartbeatAt, mine} | null }`
  (`baseSha` = Git-Blob-SHA der Datei auf dem Draft-Branch, für den
  nächsten `PUT`; `mine` wird serverseitig gegen die anfragende userId
  berechnet — der Client bekommt nie eine fremde userId, siehe
  „`PUT`/`DELETE /api/locks/:pageId`" unten)
- `403` kein verknüpftes Konto / kein Schreibrecht
- `404` Seite unbekannt oder für den Nutzer nicht lesbar
- `502` Provider nicht erreichbar

### `GET /api/pages/:id/draft`

Liefert denselben Bestand wie `POST`, ohne einen Draft anzulegen.

- `200` wie oben
- `403` / `404` / `502` wie oben — `404` zusätzlich, wenn (noch) kein Draft existiert

### `PUT /api/pages/:id/draft` — Autosave, 409-Vertrag

Body: `{ content: string, baseSha: string, message?: string }` — `baseSha`
ist der Blob-SHA, auf dem der Client aufsetzt (aus der letzten `POST`/`GET`/
`PUT`-Antwort). Committet mit `message` (Default `docs: <Titel> (Entwurf)`)
auf den Draft-Branch.

- **`200`** `{ newSha, savedAt }` — Save erfolgreich, `newSha` ist der neue
  Blob-SHA (deterministisch aus dem committeten Inhalt berechnet, kein
  zusätzlicher Roundtrip) und wird zum `baseSha` des nächsten `PUT`.
- **`409`** — `baseSha` weicht vom aktuellen Stand des Draft-Branches ab
  (jemand anders hat zwischenzeitlich gespeichert, oder direkt per Git
  gepusht). Antwort trägt den **aktuellen** Stand, NICHT nur eine
  Fehlermeldung — kein Pfad überschreibt still:

  ```json
  {
    "error": "Entwurf \"home\" wurde seit dem geladenen Stand bereits geändert.",
    "currentSha": "3a7c…",
    "currentContent": "---\nid: home\n---\n# Home\n\n<aktueller Stand>\n"
  }
  ```

  Der Client baut daraus die Zusammenführungsansicht (Phase 2c) — der
  eigene, gerade nicht gespeicherte Inhalt bleibt lokal erhalten, `PUT`
  einfach erneut mit `baseSha: currentSha` und einem lokal zusammengeführten
  `content` aufrufen.
- `403` / `404` (kein Draft) / `502` wie oben.

Nach jedem erfolgreichen Save wird die Seite inkrementell mit `ref='draft'`
indexiert — sofort danach auffindbar über `GET /api/search?ref=draft`
(s. u.), unabhängig von `main`.

### `DELETE /api/pages/:id/draft`

Verwirft den Draft vollständig: Branch gelöscht, Draft-Index-Zeilen
(`ref='draft'`) der Seite entfernt, ein eventuell gehaltener Lock gelöst.

- `204` erfolgreich verworfen
- `403` / `404` (kein Draft) / `502` wie oben

### `POST /api/pages/:id/draft/media`

Multipart-Upload (`multipart/form-data`, Feld `file`) in den bestehenden
Draft (legt NIE selbst einen Draft an — vorher `POST .../draft` aufrufen).
Whitelist `png`/`jpg`/`jpeg`/`gif`/`webp`/`svg` (Bilder) UND
`pdf`/`docx`/`xlsx`/`pptx`/`zip`/`txt`/`csv`/`md` (Datei-Anhänge), Größenlimit
`F451_MAX_UPLOAD_MB` (Default 10 MiB). Rasterbilder werden per Magic-Bytes
gegen die behauptete Extension geprüft (eine `.png`-Datei mit fremdem Inhalt
→ `415`); dasselbe gilt für PDF (`%PDF-`-Signatur) und die ZIP-Container
docx/xlsx/pptx/zip (`PK\x03\x04`-Signatur) — txt/csv/md sind reine
Textformate ohne Magic-Bytes-Konzept und laufen ohne Signaturprüfung durch
(Größenlimit gilt weiterhin). SVGs werden serverseitig sanitisiert (Skripte,
Event-Handler, `javascript:`-Hrefs entfernt — draw.io-/Excalidraw-Metadaten
bleiben erhalten). Dateiname wird slugifiziert, Namenskollisionen bekommen
einen `-1`/`-2`-Suffix. Commit nach `<Seitenordner>/_media/<Name>` auf den
Draft-Branch.

- `200` `{ path: "_media/<name>", markdown: "![](_media/<name>)", kind: "image" }`
  für Bilder, `{ path, markdown: "[<originalname>](_media/<name>)", kind: "file" }`
  für Datei-Anhänge (Editor fügt Bilder per `setImage` ein, Datei-Anhänge als
  gewöhnlichen Markdown-Link — `markdown` selbst ist nur dokumentativ, der
  Editor-Client baut den Insert aus `path`/`kind` und dem lokal bekannten
  Original-Dateinamen)
- `400` kein/ungültiges Multipart oder Feld `file` fehlt
- `403` / `404` (kein Draft) wie oben
- `413` Datei größer als das Limit
- `415` Dateityp nicht erlaubt oder Magic-Bytes-Prüfung fehlgeschlagen
- `422` SVG nach dem Sanitizing leer/ungültig
- `502` Provider nicht erreichbar

### `PUT /api/pages/:id/draft/diagram` (Phase 3e Task 2)

Legt ein Diagramm (draw.io/Excalidraw) im bestehenden Draft an ODER
überschreibt es **in place** — anders als `POST .../draft/media` oben (immer
Neuanlage mit Kollisions-Suffix) kennt der Editor hier den Zielnamen bereits.
JSON-Body (bewusst OHNE AJV-Schema, s. Code-Kommentar an der Route — ein
Validierungsfehler würde sonst selbst einen 500er statt eines 400ers
produzieren; die Validierung läuft manuell im Handler):

```json
{ "path": "_media/<name>.drawio.svg", "content": "<svg …>", "ifAbsent": false }
```

- `path` muss `_media/<name>` sein (ein Pfadsegment, alphanumerisch
  beginnend) mit Suffix `.drawio.svg` oder `.excalidraw.svg`.
- `content` ist der rohe SVG-Text — durchläuft denselben Sanitizer
  (`sanitizeSvg`) wie der Media-Upload (Metadaten-Kommentare bleiben
  erhalten, s. oben).
- `ifAbsent: true` (Neuanlage per Slash-Item) lässt die Anfrage mit `409`
  scheitern, falls die Datei bereits existiert — ohne (oder mit `false`)
  überschreibt sie eine bestehende Datei in place (Bearbeiten-Button-Flow).

Commit nach `<Seitenordner>/_media/<Name>` auf den Draft-Branch (Message
„Diagramm … angelegt"/„… aktualisiert").

- `200` `{ path: "_media/<name>" }`
- `400` `path`/`content` fehlt oder kein String, oder `path` strukturell
  ungültig (kein `_media/<name>`, Traversal, leerer Name)
- `403` / `404` (kein Draft) wie oben
- `409` `ifAbsent: true` UND die Datei existiert bereits
- `413` Diagramm größer als `F451_MAX_UPLOAD_MB`
- `415` Suffix nicht `.drawio.svg`/`.excalidraw.svg`
- `422` SVG nach dem Sanitizing leer/ungültig
- `502` Provider nicht erreichbar

### `GET /media/:pageId/*`

Liefert eine Binärdatei aus `<Seitenordner>/_media/<Wildcard>` aus (Zusatz-
Task Phase 1e). Standardmäßig von `main` — mit `?ref=draft` (Task 1,
Phase 2c-Vorarbeiten) vom Draft-Branch (`draft/<pageId>`) stattdessen, damit
frisch hochgeladene Draft-Bilder (`POST .../draft/media`) im Editor rendern,
bevor der Draft gespeichert/gemerged ist.

- `200` binärer Inhalt. Bilder (png/jpg/jpeg/gif/webp/svg) inline mit
  passendem `Content-Type`. Dokument-Anhänge (pdf/docx/xlsx/pptx/zip/txt/
  csv/md, s. Upload-Whitelist oben) mit korrektem `Content-Type` UND
  `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…` (RFC
  5987, für Namen mit Sonderzeichen). Wirklich unbekannte Extensions ebenso
  als Download, aber mit `application/octet-stream`. Sicherheits-Header
  (`X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
  default-src 'none'`) sind immer gesetzt.
- `404` unbekannte Seite/Datei — bei `?ref=draft` zusätzlich, wenn der
  aufrufende Nutzer kein Schreibrecht auf den Space hat (Gate ist
  **Schreibrecht**, konsistent zur Draft-Suche unten, NICHT Leserecht) oder
  ohne Auth-Wiring überhaupt (fail-closed) — kein Existenz-Orakel: identisch
  zu „unbekannte Seite".

### `PUT /api/locks/:pageId` / `DELETE /api/locks/:pageId`

Soft-Lock mit Heartbeat (Spec Abschnitt 4) — **reiner Hinweis-Charakter,
blockiert nichts**. TTL 2 Minuten.

Besitz wird über die stabile, eindeutige **userId** verglichen (FK auf
`users.id`), NICHT über den Anzeigenamen (`userName`, aus dem OIDC-`name`-
Claim) — der ist nicht eindeutig, zwei Konten mit demselben Anzeigenamen
konnten sich sonst gegenseitig Locks übernehmen/löschen (P1-Fix Phase 2a).
`userName` bleibt als reines Anzeigefeld erhalten.

- `PUT` → `200` `{ heldBy, expiresAt, mine }`. Ohne bestehenden (oder mit
  abgelaufenem) Lock übernimmt der aufrufende Nutzer ihn; hält ein ANDERER
  Nutzer einen noch frischen Lock, bleibt dieser bestehen — die Antwort
  meldet trotzdem `200` mit DESSEN `heldBy`/`expiresAt` (kein Fehler, nur
  Auskunft). `mine` wird serverseitig gegen die anfragende userId berechnet
  — der Client bekommt NIE eine fremde userId, nur diese vorberechnete
  Auskunft „ist das mein Lock?".
- `DELETE` → `204`, löst NUR den eigenen Lock (ein fremder oder nicht
  bestehender Lock bleibt unberührt, idempotent).
- Beide: `403` (kein Schreibrecht) / `404` (Seite unbekannt).
- Der aktuelle Lock ist zusätzlich Teil jeder Draft-Antwort (`POST`/`GET
  .../draft` → `lock: {user, heartbeatAt, mine} | null`).

### `GET /api/search?ref=draft`

Dieselbe Such-Route wie die Lese-API (`q`, `space`, `tag`), zusätzlicher
Parameter `ref` (`main` Default, `draft` für den Draft-Index). Filtert nach
**Schreibrecht**, nicht nach Leserecht (Drafts sind Teil des Schreib-
Workflows) — ein Nur-Lese-Collaborator sieht seinen Space, bekommt aber
keine Treffer aus `ref=draft`. Die Lese-API (`GET /api/pages/:id`,
`GET /api/search` ohne `ref`) bleibt unverändert **main-only** — Draft-Inhalt
taucht dort nie auf.

Jeder Treffer (main UND draft) trägt seit Task 1 (Phase 2c-Vorarbeiten)
zusätzlich `path` — den `index.md`-Pfad der Seite (aus `pages.path`). Der
Editor braucht ihn als eindeutiges Wikilink-Target für das `[[`-Autocomplete.

**`prefix`** (boolean, optional, Phase 3a): Tipp-Suche — das letzte Wort der
Anfrage matcht als Wortanfang (`tsquery :*`) gegen den ungestemmten
simple-Anteil des Suchvektors. Default `false`.

**Rate-Limit** (Phase 4a Task 2, Spec §7): `GET /api/search` (mit oder ohne
`ref=draft`) trägt ein eigenes Anfragebudget pro Client-IP (`@fastify/rate-limit`,
Default `60`/Minute, konfigurierbar über `F451_RATE_LIMIT_SEARCH_MAX`, s.
Env-Tabelle oben) — unabhängig vom Auth-Routen-Budget. Überschreitung →
`429 {status:'rate_limited', reason:'Zu viele Anfragen — bitte kurz warten.'}`.

## Workflow-API (Phase 2d Task 3 + 4)

`routes/workflow.ts` — der Rest des Schreib-Workflows nach dem Draft (Spec
§4): Review-PR eröffnen, Freigeben & mergen (inkl. synchronem Cleanup), den
Randfall „Draft und main sind auseinandergelaufen" auflösen (Task 3), sowie
das visuelle Diff für die Review-Ansicht (Task 4, `GET .../review`). Dieselbe
Gate-Kette wie die Draft-/Lock-Routen (`resolveWriteContext`,
`routes/drafts.ts`) — Session, Space-Sichtbarkeit, verknüpftes Konto,
Schreibrecht, siehe „Draft-API (Schreiben)" oben.

**Freigabe-Recht wird NICHT separat geprüft** (Spec §7: Berechtigungen werden
geerbt, nie dupliziert) — `POST /release` mergt mit dem Token des aufrufenden
Nutzers; ein Provider-`403` DABEI ist bereits die Antwort „kein Freigabe-Recht".

### `POST /api/pages/:id/review`

Eröffnet den Review-PR (Head `draft/<pageId>`, Base `main`). Body optional
`{ reviewers?: string[] }` (Forgejo-/GitHub-Login-Namen).

Der PR-Body enthält standardmäßig nur Titel + Seiten-Id. Ist `F451_PUBLIC_BASE_URL`
konfiguriert (siehe „Konfiguration" unten), wird zusätzlich ein klickbarer Link
zur Review-Ansicht angehängt: `<F451_PUBLIC_BASE_URL>/wiki/<space>/<pageId>/review`
(Segmente einzeln `encodeURIComponent`-kodiert, wie bei `apps/web/lib/urls.ts`).

- **`200`** `{ number, url, state: 'review', mergeable: boolean | null }` —
  **idempotent**: existiert bereits ein offener PR mit demselben Head/Base,
  wird dessen Bestand zurückgegeben (keine doppelte Anlage, keine erneute
  Reviewer-Zuweisung). `mergeable` wird nach dem Anlegen bis zu ~5 s gepollt
  (`getPullRequest`, kurzes Budget — reine Anzeige-Auskunft, kein Merge-
  Versuch); bleibt es danach `null`, berechnet der Provider die Mergebarkeit
  noch (der Client kann später erneut `POST /review` aufrufen, idempotent).
- `403` / `404` wie bei den Draft-Routen (Gate-Kette).
- `409` `{error: 'kein Entwurf vorhanden'}` — kein Draft-Branch für die Seite.
- `422` — `reviewers` enthält einen unbekannten Login-Namen (oder ein anderer
  Provider-Fehler bei der Reviewer-Zuweisung): der **PR bleibt trotzdem
  bestehen**, nur die Reviewer-Zuweisung ist gescheitert (Server-Meldung im
  `error`-Feld).
- `502` Provider nicht erreichbar.

### `POST /api/pages/:id/release`

Freigeben & mergen. Body optional `{ comment?: string }`.

1. Best-effort-**Approve** vor dem Merge (`submitPullRequestReview`,
   `event: 'approve'`). Nur die **tolerierte Fehlerklasse** — `ConflictError`,
   worüber sich sowohl das Self-Review-Verbot als auch „bereits approved"
   providerseitig äußern (409/422, siehe `@f451/git-provider#toProviderError`)
   — wird still geschluckt (geloggt, nicht abgebrochen): der Merge selbst
   bleibt die autoritative Freigabe-Aktion. **Jeder andere Fehler** (Netzwerk,
   Rate-Limit, 5xx, …) läuft ebenfalls nicht ab (Merge bleibt autoritativ und
   folgt trotzdem), aber die Antwort trägt dann zusätzlich `approveWarning`
   (siehe unten) — der Reviewer darf nicht im Glauben bleiben, seine Freigabe
   sei da, wenn sie tatsächlich fehlgeschlagen ist. Ohne `comment` wird ein
   Standardtext gesendet (Forgejo lehnt ein `APPROVE` ohne Body mit einem
   eigenen Fehler ab).
2. **Merge** mit dem Nutzer-Token.
3. Bei Erfolg **synchron**: `cleanupMergedDraft` (Branch, Draft-Index-Zeile,
   Lock) **und** Neu-Indexierung der Seite vom neuen `main`-HEAD
   (`indexChangedFiles` mit genau dem einen Seitenpfad) — die Leseansicht
   zeigt den neuen Stand sofort, ohne auf den `pull_request`-Webhook zu warten
   (der bleibt der Interop-/Fallback-Pfad für native Merges im Forgejo-/
   GitHub-UI, siehe „Webhook-Einrichtung" oben). Scheitert dieser Schritt
   ausnahmsweise, bleibt die Antwort trotzdem `200` (der Merge ist bereits
   geschehen und irreversibel) — nur geloggt, der Webhook holt in diesem
   seltenen Fall nach.

- **`200`** `{ mergeSha, approveWarning?: string }` — `approveWarning` ist NUR
  gesetzt, wenn der Best-effort-Approve mit einer NICHT tolerierten
  Fehlerklasse gescheitert ist (Punkt 1 oben); der Merge war trotzdem
  erfolgreich.
- `403` / `404` wie bei den Draft-Routen (Gate-Kette) **oder** — beim Merge-
  Versuch selbst — `{error: 'Kein Freigabe-Recht auf dieses Repository'}`,
  wenn das Nutzer-Token nicht mergen darf (Spec: Merge-Recht = Freigabe-Recht).
- `409` `{error: 'kein offener Pull Request vorhanden'}` (kein offener PR) —
  oder `{error, reason: 'conflict'}`, wenn der PR nicht mergebar ist (die UI
  zeigt daraus die Konflikt-Notice und verweist auf `POST /draft/update`).
- `502` Provider nicht erreichbar.

### `POST /api/pages/:id/review/request-changes`

„Änderungen anfragen" (Mockup-Aktion). Body **Pflicht** `{ comment: string }`.

- `204` — Änderungen angefordert (`submitPullRequestReview`,
  `event: 'request_changes'`).
- `403` / `404` wie bei den Draft-Routen (Gate-Kette).
- `409` `{error: 'kein offener Pull Request vorhanden'}`.
- `422` — Provider-Fehler 1:1 durchgereicht (z. B. der PR-Autor fordert bei
  sich selbst Änderungen an — von Providern typischerweise abgelehnt).
- `502` Provider nicht erreichbar.

### `POST /api/pages/:id/draft/update`

Löst den Randfall „Draft und main sind auseinandergelaufen" (Spec §4). Body
`{ strategy: 'take-main' | 'keep-mine' }`:

- **`take-main`** — verwirft den Draft vollständig, legt ihn frisch von `main`
  neu an (Draft == main danach).
- **`keep-mine`** — verwirft den Draft-Branch ebenfalls, committet den zuvor
  gelesenen Inhalt aber sofort wieder auf den frisch von `main` abgeleiteten
  Draft (derselbe Save-Pfad wie Autosave, deterministischer Blob-SHA).

Beide Strategien verwerfen den Draft-Branch (`discardDraft`) — ein zuvor
offener Review-PR wird dabei vom Provider automatisch geschlossen (Head-
Branch gelöscht). War ein PR offen, wird danach ein neuer eröffnet (dieselbe
Anlage-Logik wie `POST /review`, idempotent).

- **`200`** `{ baseSha, content, state: 'working' | 'review', pr: {number, url}
  | null, warning?: string }`.
- `403` / `404` (kein Draft vorhanden) wie bei den Draft-Routen (Gate-Kette).
- `502` Provider nicht erreichbar — Body `{status:'error', reason, preservedContent?}`.

**Content-Verlust-Fenster + Recovery (Finding 3, Fix-Runde 1):** der alte
Draft-Branch wird beim Verwerfen VOR der Neuanlage gelöscht (`discardDraft`
läuft zuerst) — schlägt einer der beiden Folgeschritte (`createOrGetDraft`
bei `take-main`/`keep-mine`, oder zusätzlich `saveDraft` bei `keep-mine`)
danach fehl (z. B. ein transienter Provider-Ausfall), gibt es in diesem
Moment keinen Draft-Branch mehr — ohne Sonderbehandlung würde die Antwort ein
generisches `502` ohne den bearbeiteten Inhalt sein, die Nutzerarbeit wäre
**still verloren**. Stattdessen trägt die `502`-Antwort in diesem Fall
zusätzlich `preservedContent`: den Inhalt, der unmittelbar VOR dem Verwerfen
auf dem (jetzt gelöschten) Draft-Branch stand, byte-identisch. **Recovery**:
der Client hebt `preservedContent` clientseitig auf und ruft
`POST /draft/update` erneut auf (oder — sobald ein Draft wieder existiert,
z. B. nach einem erneuten `POST /api/pages/:id/draft` — speichert
`preservedContent` direkt per `PUT /api/pages/:id/draft`); nichts geht
dauerhaft verloren, es kostet nur einen weiteren Versuch. Ein `502` VOR dem
Verwerfen (z. B. `discardDraft` selbst scheitert) hat dagegen KEIN
`preservedContent` — der alte Draft-Branch existiert in diesem Fall
unverändert weiter, es gibt nichts zu retten.

**Bekannte Einschränkung — Media-Verlust:** Bilder, die über
`POST .../draft/media` in den (jetzt verworfenen) Draft-Branch hochgeladen,
aber nie nach `main` gemergt wurden, gehen bei **beiden** Strategien
unwiderruflich verloren (`keep-mine` bewahrt nur den Markdown-**Text**, nicht
die Binärdateien selbst) — **kein stiller Verlust**: liegen solche Dateien vor,
trägt die Antwort ein `warning`-Feld mit den betroffenen Pfaden, die UI zeigt
es an. Der Autor muss betroffene Bilder danach erneut hochladen.

**Der Lock des Bearbeiters wird beim Verwerfen mit gelöscht** (`discardDraft`
räumt Branch, Draft-Index **und** Lock auf) — kein Sonder-Handling nötig, der
Editor heartbeatet ohnehin bei jeder Interaktion erneut (`PUT /api/locks/:pageId`).

### `GET /api/pages/:id/review` (Phase 2d Task 4)

Liefert das **visuelle Diff** für die Review-Ansicht: main-Stand vs. Draft-
Branch, blockweise gerendert über `diffMarkdown` (`@f451/markdown`, siehe
`packages/markdown/src/diff.ts`). Arbeitet auf den ROHEN Markdown-Ständen
(`provider.readFile(…, 'main')` / `readFile(…, draftBranch)`), nicht auf dem
Index-HTML — der Draft-Index existiert erst nach dem ersten Autosave und sein
HTML ist mit einem Ein-Seiten-Resolver gebaut; der Diff rendert seine Blöcke
selbst über die geteilte Pipeline.

- **`200`** `{ pr: {number, url, state, mergeable, title}, authorName: string,
  diff: MarkdownDiff, page: {id, space, title} }`.
  - `authorName` kommt aus dem letzten Commit-Autor des Draft-Branchs
    (`listCommits(…, {ref: draftBranch, limit: 1})`) — `PullRequestInfo` trägt
    laut `@f451/git-provider`-Vertrag keinen Autor, der letzte Commit ist der
    beste verfügbare Ersatz (i. d. R. identisch mit dem PR-Ersteller).
  - `diff.blocks[].html` ist bereits vollständig sanitisiert (siehe
    `packages/markdown/README.md` bzw. den Modul-Kommentar in `diff.ts`) — die
    Route reicht es unverändert durch, kein weiteres Escaping/Sanitizing hier.
  - `resolveImage` wird an `diffMarkdown` durchgereicht (`/media/<pageId>/…`,
    dieselbe Pfadregel wie beim normalen Seiten-Rendering). `resolveLink`
    wird seit Finding 2 (Fix-Runde 1) ebenfalls verdrahtet: ein Space-weiter
    `LinkResolver` (`indexer/resolve-links.ts`) wird pro Aufruf aus dem
    DB-Index aufgebaut (`ref IN ('main', 'draft')`, Dedupe auf `id` —
    main-Zeile gewinnt bei Konflikt, Draft-only-Zeilen decken ganz neue,
    noch nicht gemergte Seiten ab). `resolveLink`/`resolveImage` selbst sind
    geteilte Konstruktionen (`buildResolveLink`/`buildResolveImage`), die
    auch `upsertPage` (`indexer/index-space.ts`) nutzt.
- `403` / `404` wie bei den Draft-Routen (Gate-Kette).
- **`404`** `{status: 'not_found', reason: 'kein offenes Review'}` — **kein**
  offener PR mit Head `draft/<pageId>`/Base `main` (unabhängig davon, ob
  überhaupt ein Draft-Branch existiert: ohne offenen PR gibt es nichts zu
  reviewen).
- `502` Provider nicht erreichbar.

**Draft-only-Seiten (Phase 2d Task 5, „+ Neue Seite") vor ihrem ersten
Release** (Fix, Task 8 — per E2E gefunden): eine solche Seite hat noch KEINE
Datei auf `main`. `readFile(…, 'main')` wirft dafür providerseitig einen
`NotFoundError` — der wird HIER gezielt aufgefangen und als leeres
main-Dokument behandelt (`content: ''`), NICHT wie ein echter Provider-Ausfall
in ein 502 übersetzt. Der Diff zeigt dann den kompletten Draft-Inhalt als
`added`-Blöcke (Vergleich gegen ein leeres Dokument, wie ein Diff gegen
`/dev/null`) — ohne diesen Fang war „Neue Seite → Review anfordern" nicht
möglich.

**Backlog — Reviewer-Liste:** `PullRequestInfo` (`@f451/git-provider`) trägt
aktuell keine Reviewer-Liste; Forgejo/GitHub liefern `requested_reviewers` in
der PR-Antwort zwar mit, aber `packages/git-provider` ist bewusst **nicht**
Teil dieses Tasks (kein Dateiscope, siehe Task-4-Brief) — eine Erweiterung um
`PullRequestInfo.reviewers?: string[]` (beide Provider + eigener MockAgent-Test
für `packages/git-provider`) bleibt für einen Folgetask offen. `GET /review`
liefert bis dahin keine Reviewer-Liste.

**Backlog / bekannte Vereinfachungen der Diff-Engine** (Erster-Run, siehe
`packages/markdown/src/diff.ts`-Kommentar für Details):

- Ein geänderter **Absatz** zeigt einen Wort-Diff der **Markdown-Quelle**
  (nicht des gerenderten Rich-Texts) — `**fett**` erscheint im Diff als
  Zeichenkette, nicht als fett dargestellter Text. So bleiben
  Formatierungsänderungen selbst sichtbar, ohne einen eigenen Rich-Text-Diff
  bauen zu müssen.
- Der Tabellen-Zellvergleich richtet sich rein nach Zeilen-/Spaltenindex —
  **keine** Umordnungserkennung (eine verschobene Zeile erscheint als
  Zeile-entfernt + Zeile-neu, nicht als „verschoben").
- `resolveLink` ist in `GET /review` seit Finding 2 (Fix-Runde 1) verdrahtet
  (Space-weiter `LinkResolver` aus dem DB-Index, s. o.) — Wikilinks/relative
  Links auf existierende Space-Seiten (main **oder** Draft-only) lösen im
  Diff auf; nur wirklich nicht existierende Ziele erscheinen weiterhin als
  `broken-link`.
- Kein Syntax-Highlighting im Codeblock-Diff, keine „Moved"-Erkennung auf
  Block-Ebene (YAGNI, Plan Global Constraints).

## Fehlerformat (Phase 4a Task 1)

Jede Fehlerantwort dieser API — ob aus einem Handler selbst (`reply.code(…).send(…)`)
oder aus einem geworfenen/Fastify-internen Fehler — trägt dasselbe Shape
`{ status: string, reason: string }`. Zwei zentrale Stellen sorgen dafür, dass
das auch für Fehler gilt, die NICHT von den Handlern selbst formuliert werden
(`src/error-format.ts`, `src/app.ts`):

- **`app.setErrorHandler(formatErrorReply)`** — greift für alles, was Fastify
  NACH dem Routing wirft (AJV-Validierungsfehler, `bodyLimit`, JSON-Parse-Fehler,
  Rate-Limit-Überschreitung, unbehandelte Exceptions in Handlern). Übersetzt
  Fastifys Alt-Format (`{statusCode,error,message}`) durchgängig ins
  `{status,reason}`-Format:
  - AJV-Validierungsfehler → `400 {status:'bad_request', reason: <AJV-Meldung>}`.
  - `413` (Body über dem konfigurierten Limit) → `413 {status:'payload_too_large', reason:'Request-Body zu groß.'}`.
  - `429` (Rate-Limit, s. „Rate-Limit" bei Auth/Suche oben) →
    `429 {status:'rate_limited', reason:'Zu viele Anfragen — bitte kurz warten.'}`.
  - Jeder andere `4xx` (z. B. `415` bei ungültigem `Content-Type`,
    `FST_ERR_CTP_INVALID_MEDIA_TYPE`/`FST_ERR_CTP_EMPTY_JSON_BODY`) — der
    semantische Statuscode BLEIBT erhalten (`415` bleibt `415`, kein Zwang auf
    `400`), nur der Body wird auf `{status:'bad_request', reason:'Ungültiger Request-Body.'}` normalisiert.
  - Echte `5xx` → vollständig serverseitig geloggt, nach außen generisch
    `500 {status:'error', reason:'Interner Fehler.'}` (kein Message-Leak).
  - Handler, die ihre Fehlerantwort selbst senden (z. B. Webhook-`{status:'ignored'}`,
    502-Provider-Fehler-Pfade), laufen NIE durch diesen Handler — deren
    Verhalten ist unverändert.
- **`app.setNotFoundHandler(...)`** — unbekannte Routen (kein Handler
  registriert) werfen KEINEN Fehler, Fastify antwortet sonst direkt mit
  seinem Alt-Format; der eigene Handler liefert stattdessen
  `404 {status:'not_found', reason:'Unbekannte Route.'}`. Betrifft NUR nicht
  registrierte Pfade — bestehende, fachliche 404s einzelner Routen (z. B.
  „Seite unbekannt") behalten ihre eigene `reason`, `/api/openapi.json`/`/api/docs`
  bleiben unverändert erreichbar.
- **`frameworkErrors: handleFrameworkError`** (Fastify-Konstruktor-Option,
  `app.ts`) — die einzige Stelle für drei Fehlerklassen, die Fastify VOR dem
  Routing wirft und die weder `setErrorHandler` noch `setNotFoundHandler`
  erreichen: `FST_ERR_BAD_URL` (`400`, kaputtes Percent-Encoding, z. B. `/%zz`),
  `FST_ERR_MAX_PARAM_LENGTH` (`414`, ein Pfadparameter über `maxParamLength`,
  Default 100 — real erreichbar bei langen percent-encodeten `path:`-Ids) und
  `FST_ERR_ASYNC_CONSTRAINT` (`500`, im Projekt unerreichbar — keine
  Route-Constraints konfiguriert). Auch hier bleibt der semantische
  Statuscode erhalten (`414` bleibt `414`), nur der Body wird auf
  `{status:'bad_request', reason:'Ungültige URL.'}` normalisiert (`5xx` wie
  im 500-Zweig oben: geloggt, generischer Body).

## Tests

Ein Großteil der Tests (Indexer, Webhooks, Admin, Lese-API, Lifecycle) läuft
gegen echte Postgres- und Forgejo-Testcontainer. Vor jedem Testlauf in dieser
Shell:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
export DOCKER_HOST='unix:///var/folders/7t/gskm3ybx0qv56mfh1s_k3sxh0000gn/T/podman/podman-machine-default-api.sock'
export TESTCONTAINERS_RYUK_DISABLED=true
pnpm test
```

Podman (`podman machine start`) muss dabei laufen. `TESTCONTAINERS_RYUK_DISABLED=true`
ist nötig, weil der Ryuk-Aufräum-Container von Testcontainers unter Podman
nicht zuverlässig startet — Container werden stattdessen in den
`afterAll`-Hooks der jeweiligen Testdateien selbst gestoppt.

`test/lifecycle.test.ts` ist der End-to-End-Beweis für das Zusammenspiel aller
Module: Repo seeden → Voll-Reindex → Seite per API lesbar → externe Änderung +
Webhook → Seite aktualisiert → externe Löschung + Webhook → 404 →
Wegwerfbarkeits-Beweis (alle Index-Tabellen leeren → `POST /admin/reindex` →
identischer Zustand).

**`test/helpers/mock-idp.ts`** trägt seit Phase 2d Task 8 einen Test-Kontroll-
Endpunkt `POST /test/user` (`{sub?, email?, name?}`), der die vom Mock-IdP
beim NÄCHSTEN Login zurückgegebene Identität umschaltet — gebraucht von
`apps/web/e2e/workflow.spec.ts`, das zwei ECHTE, unabhängige Identitäten
(Autorin/Reviewerin) in zwei getrennten Browser-Kontexten einloggt, aber den
Mock-IdP selbst (läuft im `start-stack.ts`-Subprozess) nicht direkt aus dem
separaten Playwright-Testprozess ansteuern kann. Kein Produktionscode-Pfad,
ausschließlich Test-Infrastruktur.

`test/auth-lifecycle.test.ts` ist das Auth-Äquivalent: Mock-IdP-Login (eigener,
im Test gestarteter OIDC-Provider, `test/helpers/mock-idp.ts`) → `/api/me` →
Space ohne Provider-Verknüpfung unsichtbar (leere Space-Liste, Tree/Page 404)
→ Forgejo-Connect-Flow (der OAuth-Endpunkt selbst ist gemockt, liefert aber
als Ergebnis ein echtes Access-Token eines im Testcontainer angelegten
Forgejo-Nutzers) → Space sichtbar, Seite lesbar → Logout → 401. Zusätzlich
eine grep-Probe, dass das Klartext-Token in keiner Log-Zeile auftaucht (der
Fastify-Logger schreibt für diesen Test auf einen eigenen Stream statt stdout).
Die übrigen `auth-*.test.ts`-Dateien decken die Einzelbausteine isoliert ab
(Krypto, Sessions, OIDC-Login, Provider-Verknüpfung, Berechtigungs-Vererbung).

`test/draft-lifecycle.test.ts` ist das Draft-Äquivalent (Phase 2a Task 6,
Abnahme-Kriterium der Phase): Draft anlegen → Lock heartbeaten → zweimal
speichern (zweiter Save mit dem `newSha` des ersten) → Git-Log zeigt den
Nutzer als echten Commit-Autor → ein ZWEITER Forgejo-Nutzer pusht direkt
(ohne die API) auf denselben Draft-Branch → Save mit dem jetzt veralteten
`baseSha` → `409` mit dem aktuellen (extern gepushten) Stand, Branch bleibt
dabei unverändert (kein stilles Überschreiben) → Bild-Upload → Draft über
`GET /api/search?ref=draft` auffindbar → Verwerfen → Branch, Draft-Index-
Zeilen (`ref='draft'`, per direkter DB-Abfrage geprüft) und Lock vollständig
weg. Die granularen Einzelfälle (alle Berechtigungs-Gates, Lock-Übernahme,
SVG-Sanitizing im Detail, Magic-Bytes …) sind bereits in
`drafts-routes.test.ts`, `locks-routes.test.ts` und
`drafts-media-routes.test.ts` abgedeckt — dieser Test beweist das
Zusammenspiel der echten `buildApp`-Komposition, nicht die Einzelbausteine
erneut.
