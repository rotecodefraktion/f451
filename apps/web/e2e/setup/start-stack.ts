/**
 * E2E-Stack-Starter (Plan Task 6): startet als EIGENSTÄNDIGES tsx-Skript den
 * kompletten Lese-Stack für die Playwright-Tests und hält ihn am Leben, bis das
 * Skript ein SIGTERM/SIGINT erhält (durch `global-teardown.ts`).
 *
 * Bewusst ein Subprozess (über tsx), NICHT direkt aus Playwrights globalSetup
 * importiert: die API und die Workspace-Pakete (`@f451/git-provider` exportiert
 * `./src/index.ts`) sind TypeScript-Quellen mit NodeNext-`.js`-Import-Spezifizierern;
 * nur ein TS-Loader wie tsx löst diese auf. Playwrights eigener Transform greift
 * nicht in `node_modules`. Deshalb spiegelt dieses Skript das Verdrahtungsmuster
 * aus `apps/api/test/auth-lifecycle.test.ts` als Standalone-Prozess wider.
 *
 * Ablauf:
 *   1. Postgres- + Forgejo-Container starten (Testcontainer-Helfer der API).
 *   2. Ein kleines Wiki-Repo seeden (4 Seiten inkl. echtem SVG-Bild und einer
 *      Seite mit rohem HTML-Block für die Editor-Flows, Phase 2c Task 7; seit
 *      Phase 2d Task 8 zusätzlich 4 eigene `workflow-*`-Seiten für
 *      `workflow.spec.ts`, s. `seedRepo`).
 *   3. Mock-IdP starten (redirectet sofort — kein interaktives IdP-UI).
 *   4. Die API via `buildApp` mit Mock-IdP + Auth + Spaces auf festem Port starten.
 *   5. Space initial via `indexSpace` indexieren.
 *   6. Einen ZWEITEN Forgejo-Nutzer (Nicht-Admin) anlegen und ihm per
 *      Collaborator-API Schreibrecht (`write`) auf das Wiki-Repo geben (Muster
 *      aus `apps/api/test/draft-lifecycle.test.ts`) — dessen Token, NICHT das
 *      Admin-Token, wird als Provider-Verknüpfung des E2E-Nutzers hinterlegt.
 *      Damit committet der Editor (Phase 2c) mit einer echten, vom Seed-Repo-
 *      Owner UNABHÄNGIGEN Identität (Abnahme-Kriterium „Commit-Autor = Seed-
 *      Nutzer, per API/Forgejo verifizierbar") statt implizit als Admin
 *      durchzurutschen — mit dem Admin-Token hätte JEDE Schreibrechte-Prüfung
 *      trivial funktioniert, auch eine kaputte. Nutzer + Forgejo-Verknüpfung
 *      direkt in die DB schreiben, damit der Space nach dem Login sichtbar ist
 *      (der Verknüpfungs-Flow selbst ist NICHT Teil der E2E-Flows — er ersetzt
 *      den interaktiven Forgejo-OAuth-Login, der eine echte Login-Session im
 *      Container bräuchte). ZUSÄTZLICH (Phase 2d Task 8) ein ZWEITER, davon
 *      unabhängiger Nutzer (Reviewer/Freigeber, `E2E_REVIEWER_USER`) nach
 *      demselben Muster — `workflow.spec.ts` schaltet den Mock-IdP per
 *      `POST /test/user` auf diese Identität um, bevor sie sich in einem
 *      zweiten Browser-Kontext einloggt.
 *   7. `next dev` auf Port 3000 mit `API_URL` auf die API starten.
 *   8. State-File für Playwright schreiben (Signal „bereit") — trägt seit
 *      Task 8 zusätzlich `idpIssuer`/`forgejoBaseUrl`/`forgejoToken`/
 *      `repoOwner`/`repoName`/`reviewer`, damit `workflow.spec.ts` (eigener
 *      Prozess, kein direkter Modul-Import möglich, s. Kommentar oben) die
 *      Mock-IdP-Identität umschalten UND einen direkten main-Commit über die
 *      rohe Forgejo-REST-API provozieren kann (Konflikt-Flow).
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'

import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'

import { buildApp } from '../../../api/src/app.js'
import { createDb, type DbHandle } from '../../../api/src/db/client.js'
import { indexSpace } from '../../../api/src/indexer/index-space.js'
import { encryptToken } from '../../../api/src/auth/crypto.js'
import { users, providerAccounts } from '../../../api/src/db/schema.js'
import type { SpaceConfig } from '../../../api/src/spaces/config.js'
import { startPg, type PgTestInstance } from '../../../api/test/helpers/pg-container.js'
import { startMockIdp, type MockIdp } from '../../../api/test/helpers/mock-idp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const WEB_DIR = resolve(HERE, '../..')
const STATE_FILE = resolve(HERE, '../.stack-state.json')

const API_PORT = 3521
const WEB_PORT = 3000
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
const API_URL = `http://127.0.0.1:${API_PORT}`

// Phase 3e Task 6: Fake-Origin des draw.io-iframe-Protokoll-Stubs, den
// `diagramme.spec.ts` per `page.route` bedient — ein Port ohne echten Dienst
// dahinter, absichtlich verschieden von `drawioBaseUrl()`s Produktions-
// Fallback (`https://embed.diagrams.net`), damit der Origin-Check im Client
// (`createDrawioProtocol`) eindeutig gegen DIESE URL geht.
const DRAWIO_STUB_ORIGIN = 'http://127.0.0.1:4599'

// 32-Byte-Schlüssel (base64) für die Token-Verschlüsselung — deterministisch,
// da dieser Stack pro Lauf frisch aufgebaut wird.
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

// Der Nutzer, den der Mock-IdP beim Login zurückgibt.
const E2E_USER = { sub: 'e2e-user', email: 'e2e@example.org', name: 'E2E Tester' } as const

// Zweite Identität (Phase 2d Task 8): Reviewer/Freigeber der Workflow-E2E-Flows
// (`workflow.spec.ts`) — eigener Forgejo-Collaborator (s. Punkt 6c unten), NICHT
// derselbe Nutzer wie `E2E_USER`, damit „Freigeben & mergen" eine ECHTE fremde
// Identität ist (kein implizites Self-Review). Der Mock-IdP gibt diese Identität
// erst zurück, sobald `workflow.spec.ts` sie per `POST /test/user` aktiviert hat
// (s. `mock-idp.ts`) — bis dahin bleibt `E2E_USER` der Standard-Login.
const E2E_REVIEWER_USER = { sub: 'e2e-reviewer', email: 'reviewer@example.org', name: 'E2E Reviewerin' } as const

// Ein einprägsamer, in genau EINER Seite vorkommender Suchbegriff für Flow 3.
const SEARCH_TERM = 'Zauberwort'

let pg: PgTestInstance | undefined
let forgejo: ForgejoTestInstance | undefined
let idp: MockIdp | undefined
let dbHandle: DbHandle | undefined
let app: Awaited<ReturnType<typeof buildApp>> | undefined
let nextProc: ChildProcess | undefined
let cleaningUp = false

async function seedRepo(provider: ForgejoProvider, repo: RepoRef): Promise<void> {
  const put = (path: string, content: string) =>
    provider.writeFile(repo, path, content, { branch: 'main', message: `seed: ${path}` })

  // Startseite (Wurzel).
  await put(
    'index.md',
    `---
id: home
title: Handbuch
lang: de
tags:
  - start
---
# Handbuch

Willkommen im f451-Handbuch. Siehe [[betrieb]] und das [[deployment]].
`,
  )

  // Betrieb-Übersicht.
  await put(
    'betrieb/index.md',
    `---
id: betrieb
title: Betrieb
lang: de
tags: [betrieb]
---
# Betrieb

Betriebshinweise. Weiter zum [[deployment]].
`,
  )

  // Ein echtes SVG mit intrinsischer Größe — als Text schreibbar (writeFile
  // kodiert UTF-8), im MIME-Whitelist der Media-Route (image/svg+xml) und im
  // Browser mit naturalWidth > 0 ladbar. Liegt in `_media/` neben der Seite,
  // damit die Media-Route es aus `<Seitenordner>/_media/<datei>` ausliefert.
  await put(
    'betrieb/deployment/_media/arch.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#3b82f6"/>
  <text x="120" y="66" fill="#ffffff" font-size="20" text-anchor="middle">Architektur</text>
</svg>
`,
  )

  // Deployment-Seite mit h2-Überschrift (für das Inhaltsverzeichnis), Bild und
  // dem eindeutigen Suchbegriff.
  await put(
    'betrieb/deployment/index.md',
    `---
id: deployment
title: Deployment
lang: de
tags: [ops]
---
# Deployment

Diese Seite beschreibt das ${SEARCH_TERM} des Deployments.

## Architektur

Der Aufbau im Überblick:

![Diagramm](_media/arch.svg)

## Schritte

1. Bauen
2. Ausrollen
`,
  )

  // Seite mit einem rohen HTML-Block (Phase 2c Task 7, Flow 4:
  // Moduswechsel-Schutz) — `checkEditorSupport` stuft rohes HTML als
  // 'unsupported' ein (kind dominiert, s. `@f451/editor`), der Editor MUSS
  // deshalb im Roh-Modus starten (`canEdit:false`). Der HTML-Block steht als
  // eigener Block (Leerzeilen davor/danach), damit remark ihn als Block-HTML
  // parst statt als Inline-Text innerhalb eines Absatzes.
  await put(
    'legacy/index.md',
    `---
id: legacy
title: Legacy-Seite
lang: de
tags: [legacy]
---
# Legacy-Seite

Diese Seite enthält einen rohen HTML-Block, den der WYSIWYG-Editor nicht
darstellen kann.

<div class="legacy">
  <p>Alter, direkt eingebetteter HTML-Block.</p>
</div>

Ende der Seite.
`,
  )

  // Vier eigene Seiten für `workflow.spec.ts` (Phase 2d Task 8) — bewusst NICHT
  // die von `editor.spec.ts` bereits verwendeten Seiten (`betrieb`/`deployment`)
  // wiederverwendet: dieselbe Playwright-Konfiguration (`workers: 1`) fährt den
  // Stack NUR EINMAL für den gesamten Lauf hoch, alle Spec-Dateien teilen sich
  // also Postgres/Forgejo — `editor.spec.ts` hinterlässt dort absichtlich OFFENE
  // Entwürfe (s. dortiger Kopfkommentar). Eigene, unberührte Seiten machen die
  // Workflow-Flows unabhängig von der Ausführungsreihenfolge der Spec-Dateien.
  await put(
    'workflow-a/index.md',
    `---
id: workflow-a
title: Workflow A
lang: de
tags: [workflow]
---
# Workflow A

Ursprünglicher Einleitungssatz für den Workflow-Test.

Ein zweiter Absatz mit weiterem Text.
`,
  )

  await put(
    'workflow-conflict/index.md',
    `---
id: workflow-conflict
title: Workflow Konflikt
lang: de
tags: [workflow]
---
# Workflow Konflikt

Ursprüngliche Konfliktzeile für den Test.

Ein weiterer Absatz.
`,
  )

  await put(
    'workflow-responsive/index.md',
    `---
id: workflow-responsive
title: Workflow Responsive
lang: de
tags: [workflow]
---
# Workflow Responsive

Ursprünglicher Text für den Responsive-Test.
`,
  )

  await put(
    'workflow-reset/index.md',
    `---
id: workflow-reset
title: Workflow Reset
lang: de
tags: [workflow]
---
# Workflow Reset

Ursprünglicher Text für den Reset-Recovery-Test.
`,
  )

  // Phase 3a: Fixture für den Verweis-Report — verweist absichtlich auf eine
  // fehlende Seite. Erscheint auch im Seitenbaum (Zählungen beachten).
  await put(
    'report-fixture/index.md',
    `---
id: report-fixture
title: Report-Fixture
lang: de
---
# Report-Fixture

Diese Seite verweist auf eine fehlende Seite: [[nicht-vorhanden]].
`,
  )

  // Phase 3c Task 7: Space-Vorlage für die Komfort-Flows „Neue Seite aus
  // Vorlage" / „Als Vorlage speichern" — Muster identisch zum Templates-API-Test
  // (`apps/api/test/templates.test.ts`), KEIN `id`-Frontmatter (Vorlagen sind
  // keine Seiten, s. `apps/api/src/templates/registry.ts`) und liegt unter
  // `_templates/`, taucht deshalb NICHT im Seitenbaum auf.
  await put(
    '_templates/meeting-notiz.md',
    `---
title: Meeting-Notiz
description: Gerüst für Besprechungsnotizen
---
# {{titel}}

Datum: {{datum}} · Autor: {{autor}}

## Agenda
`,
  )

  // Phase 3d Task 5: Seed-Seite für den YouTube-Embed-Flow (`komfort.spec.ts`
  // Flow 8) — eine URL allein auf einer Zeile wird eingebettet, dieselbe URL
  // im Fließtext eines Satzes bleibt ein normaler Link (Regressionsgrenze).
  await put(
    'youtube-demo/index.md',
    `---
id: youtube-demo
title: Video-Demo
lang: de
---
# Video-Demo

Einleitung vor dem Video.

https://www.youtube.com/watch?v=dQw4w9WgXcQ

Text nach dem Video mit https://youtu.be/dQw4w9WgXcQ im Satz.
`,
  )

  // Phase 3e Task 6: Seed-Seite für die Diagramm-E2E-Flows (`diagramme.spec.ts`)
  // — ein bereits committetes `.drawio.svg` (Muster identisch zu `arch.svg`
  // oben, nur mit dem draw.io-typischen `content`-Attribut, das das
  // eingebettete `mxfile`-XML trägt). Der `content`-Wert muss nur STRUKTURELL
  // plausibel sein: der E2E-drawio-Stub lädt ihn nie in echtes draw.io, er
  // muss nur `sanitizeSvg` überstehen (gültiges SVG, `content`-Attribut
  // vorhanden) — Flow 1 (Leseansicht) prüft, dass ein Diagramm-Bild als
  // GEWÖHNLICHES `<img>` rendert (kein `.diagram-node`/`.diagram-edit` in der
  // Leseansicht, das ist reines Editor-NodeView-Verhalten), Flow 2 öffnet es
  // im Editor zum Bearbeiten.
  await put(
    'architektur/_media/deployment.drawio.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" content="&lt;mxfile&gt;&lt;diagram id=&quot;d1&quot; name=&quot;Seite-1&quot;&gt;dZFNDoIwEEZP0z0BEliDf9GFCTGuKx2hSWFIqQI9vUXKT4zpavq+mUnfDMFJ2R0UbYoLMhAk9FhH8JaEYRAEkX16Yu+EJ/HGgFxxNhctIOUGHPQcfXIG7aZQIwrNmy3MsK4h0xtGlcJ2W/ZAsZ3a0Bx+QJpR8UvvnOliolEYLPwIPC/myYHnkqniubEDbUEZtitk98NuIWchLqjg2eEkyM/UGyd7ZfNfsjXBjKrx0nqU9Qc=&lt;/diagram&gt;&lt;/mxfile&gt;">
  <rect x="10" y="10" width="80" height="40" fill="none" stroke="currentColor"/>
  <text x="50" y="35" text-anchor="middle" font-size="12">Start</text>
</svg>
`,
  )
  await put(
    'architektur/index.md',
    `---
id: architektur
title: Architektur
lang: de
tags: [ops]
---
# Architektur

Übersicht des Systemaufbaus.

![Deployment](_media/deployment.drawio.svg)
`,
  )

  // Phase 4b Task 5: drei eigene Seiten für `resilienz.spec.ts` (Spec-§11-
  // Abnahme, Störungs-Drehbuch) — Muster identisch zu den `workflow-*`-Seiten
  // oben: eigene, von anderen Spec-Dateien UNBERÜHRTE Seiten, damit die
  // Reihenfolge der Spec-Dateien keine Rolle spielt (derselbe Stack läuft NUR
  // EINMAL für den gesamten Playwright-Prozess, `workers: 1`).
  await put(
    'resilienz-1/index.md',
    `---
id: resilienz-1
title: Resilienz Offline-Puffer
lang: de
tags: [resilienz]
---
# Resilienz Offline-Puffer

Ursprünglicher Text für den Offline-Puffer-Test.
`,
  )

  await put(
    'resilienz-2/index.md',
    `---
id: resilienz-2
title: Resilienz Token-Widerruf
lang: de
tags: [resilienz]
---
# Resilienz Token-Widerruf

Ursprünglicher Text für den Token-Widerruf-Test.
`,
  )

  await put(
    'resilienz-3/index.md',
    `---
id: resilienz-3
title: Resilienz Recovery Verwerfen
lang: de
tags: [resilienz]
---
# Resilienz Recovery Verwerfen

Ursprünglicher Text für den Recovery-Verwerfen-Test.
`,
  )
}

/**
 * Zweiter, bewusst minimaler Space (Topbar-Space-Wechsler, `space-switcher.spec.ts`):
 * einzige Aufgabe ist, dass `GET /api/spaces` ≥2 Einträge liefert, damit der
 * Wechsler überhaupt ein Dropdown zeigt (bei nur einem Space rendert
 * `SpaceSwitcher` bewusst kein Menü, s. `components/space-switcher.tsx`).
 * Öffentliches Repo, KEIN Collaborator nötig: Lesezugriff hängt laut
 * `apps/api/src/auth/permissions.ts#probeSpace` an einem einfachen
 * `GET .../repos/{owner}/{repo}` == 200 — das erfüllt jedes öffentliche Repo
 * für jeden Token-Inhaber, unabhängig vom Collaborator-Status (der nur für
 * Schreibrechte zählt, s. `canWriteSpace` dort).
 */
async function seedSecondSpace(provider: ForgejoProvider, repo: RepoRef): Promise<void> {
  await provider.writeFile(
    repo,
    'index.md',
    `---
id: home
title: Betrieb
lang: de
---
# Betrieb

Zweiter Space — dient ausschließlich dem Topbar-Space-Wechsler-Test
(\`space-switcher.spec.ts\`), keine weiteren Seiten nötig.
`,
    { branch: 'main', message: 'seed: index.md' },
  )
}

async function main(): Promise<void> {
  // Falls ein früherer Lauf abgebrochen ist: altes State-File entfernen.
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE)

  // 1. Container.
  ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
  dbHandle = createDb(pg.connectionString)
  await dbHandle.migrate()

  const provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })

  // 2. Repo + Seed.
  const repo = await forgejo.createRepo('e2e-handbuch', { private: false })
  await seedRepo(provider, repo)

  const space: SpaceConfig = {
    id: 'e2e-handbuch',
    name: 'Handbuch',
    provider: 'forgejo',
    owner: repo.owner,
    repo: repo.repo,
    defaultLang: 'de',
    repoRef: repo,
  }

  // 2b. Zweiter, minimaler Space (s. `seedSecondSpace` oben) — MUSS an Index 1
  //     bleiben (nicht vor `space`): `/wiki` redirectet auf `spaces[0]`,
  //     mehrere bestehende Flows (`lese-ui.spec.ts` Flow 1 u. a.) erwarten
  //     genau `/wiki/e2e-handbuch` nach Login/Redirect.
  const repo2 = await forgejo.createRepo('e2e-betrieb', { private: false })
  await seedSecondSpace(provider, repo2)
  const space2: SpaceConfig = {
    id: 'e2e-betrieb',
    name: 'Betrieb',
    provider: 'forgejo',
    owner: repo2.owner,
    repo: repo2.repo,
    defaultLang: 'de',
    repoRef: repo2,
  }

  // 3. Mock-IdP.
  idp = await startMockIdp({ sub: E2E_USER.sub, email: E2E_USER.email, name: E2E_USER.name })

  // 4. API programmgesteuert bauen — Mock-IdP als OIDC-Issuer, Redirect zurück
  //    auf die WEB-Origin (der Next-Proxy reicht /auth/* an die API durch, so
  //    dass das kurzlebige OIDC-Transaktions-Cookie auf localhost:3000 sitzt).
  app = buildApp({
    databaseUrl: pg.connectionString,
    spaces: [space, space2],
    providerRegistry: () => provider,
    forgejoBaseUrl: forgejo.baseUrl,
    // Task 3 (Auth-Härtung/CSRF-Origin-Check, Spec §7): produktionsnah gesetzt
    // (Spec §8: hinter dem Reverse Proxy ist `F451_PUBLIC_BASE_URL` immer
    // konfiguriert) — der Browser sieht/sendet ausschließlich `WEB_ORIGIN`
    // (Next-Proxy reicht `/auth/*`/`/api/*`/... an die API durch), das ist
    // also die einzig korrekte "eigene Origin" für den neuen CSRF-Hook UND
    // die Basis für `buildConnectRedirectUri` (M1) — beide sollen NICHT vom
    // (proxy-internen) Host-Header-Fallback abhängen.
    publicBaseUrl: WEB_ORIGIN,
    auth: {
      tokenKey: TOKEN_KEY,
      insecureCookies: true,
      // Task 3 (Auth-Härtung M2, Spec §7): seit der Entkopplung von
      // `insecureCookies` steuert ausschließlich dieses Feld, ob die
      // OIDC-Discovery http-Issuer erlaubt (hier: der Mock-IdP).
      oidcAllowInsecure: true,
      oidc: {
        issuer: idp.issuer,
        clientId: 'e2e-client',
        clientSecret: 'e2e-secret',
        redirectUrl: `${WEB_ORIGIN}/auth/callback`,
      },
      connect: {
        forgejo: {
          baseUrl: forgejo.baseUrl,
          clientId: 'e2e-forgejo-client',
          clientSecret: 'e2e-forgejo-secret',
        },
      },
    },
  })
  await app.listen({ port: API_PORT, host: '127.0.0.1' })

  // 5. Initiale Indexierung (Service-Account/Admin).
  await indexSpace({ db: dbHandle.db, provider }, space)
  await indexSpace({ db: dbHandle.db, provider }, space2)

  // 6a. Zweiter Forgejo-Nutzer (Nicht-Admin) mit Collaborator-Schreibrecht
  //     (Muster `apps/api/test/draft-lifecycle.test.ts`) — s. Kopfkommentar
  //     „Ablauf" Punkt 6, warum NICHT das Admin-Token verwendet wird.
  const writer: ForgejoTestUser = await forgejo.createUser('e2e-writer')
  await forgejo.addCollaborator(repo, writer.username, 'write')

  // 6b. Nutzer + Forgejo-Verknüpfung direkt setzen (siehe Kopfkommentar). Der
  //    Login-Callback macht später ein `onConflictDoUpdate` auf denselben
  //    users-Datensatz — das Vorab-Anlegen kollidiert also nicht. Das Token ist
  //    das des Collaborator-Nutzers (NICHT das Admin-Token) — er darf das Repo
  //    lesen UND beschreiben (`permissions.push`), Space sichtbar UND Drafts
  //    schreibbar über die Provider-Probe in permissions.ts.
  await dbHandle.db
    .insert(users)
    .values({ id: E2E_USER.sub, email: E2E_USER.email, displayName: E2E_USER.name })
    .onConflictDoNothing()
  await dbHandle.db
    .insert(providerAccounts)
    .values({
      userId: E2E_USER.sub,
      provider: 'forgejo',
      providerLogin: writer.username,
      encryptedAccessToken: encryptToken(writer.token, TOKEN_KEY),
    })
    .onConflictDoNothing()

  // 6c. Zweite Identität (Reviewer/Freigeber, Phase 2d Task 8, s. Kommentar bei
  //     `E2E_REVIEWER_USER`): eigener Forgejo-Collaborator mit Schreibrecht
  //     (identisches Muster wie 6a/6b für den Autor-Nutzer) + eigene
  //     users/providerAccounts-Zeile — `workflow.spec.ts` schaltet den Mock-IdP
  //     per `POST /test/user` auf diese Identität um, bevor sie sich in einem
  //     ZWEITEN Browser-Kontext einloggt (echte, vom Autor unabhängige Session).
  const reviewer: ForgejoTestUser = await forgejo.createUser('e2e-reviewer')
  await forgejo.addCollaborator(repo, reviewer.username, 'write')
  await dbHandle.db
    .insert(users)
    .values({ id: E2E_REVIEWER_USER.sub, email: E2E_REVIEWER_USER.email, displayName: E2E_REVIEWER_USER.name })
    .onConflictDoNothing()
  await dbHandle.db
    .insert(providerAccounts)
    .values({
      userId: E2E_REVIEWER_USER.sub,
      provider: 'forgejo',
      providerLogin: reviewer.username,
      encryptedAccessToken: encryptToken(reviewer.token, TOKEN_KEY),
    })
    .onConflictDoNothing()

  // 7. next dev starten (Tokens-CSS zuvor generieren — `next dev` direkt löst
  //    das predev-Skript nicht aus).
  await runSyncTokens()
  nextProc = spawn(resolve(WEB_DIR, 'node_modules/.bin/next'), ['dev', '--port', String(WEB_PORT)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      API_URL,
      PORT: String(WEB_PORT),
      NODE_ENV: 'development',
      // Phase 3e Task 6: Port OHNE Dienst dahinter — `diagramme.spec.ts` fängt
      // die iframe-Requests per `page.route` ab (Protokoll-Stub, s. dort) und
      // braucht dafür eine feste, von `drawioBaseUrl()`s Produktions-Fallback
      // (`embed.diagrams.net`) verschiedene Origin.
      NEXT_PUBLIC_DRAWIO_URL: DRAWIO_STUB_ORIGIN,
    },
    stdio: 'inherit',
  })
  nextProc.on('exit', (code) => {
    if (!cleaningUp) {
      console.error(`[start-stack] next dev unerwartet beendet (code ${code})`)
      void cleanup(1)
    }
  })

  await waitForHttp(`${WEB_ORIGIN}/`, 120_000)

  // 8. Bereit-Signal — inkl. der von `workflow.spec.ts` benötigten Zusatzdaten
  //    (s. Kopfkommentar Punkt 8): IdP-Basis-URL für die Identitätsumschaltung,
  //    Forgejo-Zugang + Repo-Koordinaten für den direkten main-Commit
  //    (Konflikt-Flow) und die Reviewer-Identität selbst.
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        ready: true,
        pid: process.pid,
        webOrigin: WEB_ORIGIN,
        apiUrl: API_URL,
        searchTerm: SEARCH_TERM,
        idpIssuer: idp.issuer,
        forgejoBaseUrl: forgejo.baseUrl,
        forgejoToken: forgejo.token,
        repoOwner: repo.owner,
        repoName: repo.repo,
        reviewer: E2E_REVIEWER_USER,
      },
      null,
      2,
    ),
  )
  console.log(`[start-stack] bereit — Web ${WEB_ORIGIN}, API ${API_URL}`)
}

function runSyncTokens(): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('pnpm', ['--filter', '@f451/web', 'run', 'sync-tokens'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`sync-tokens exit ${code}`))))
    p.on('error', rej)
  })
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      // Jede HTTP-Antwort < 500 heißt: der Server lauscht und antwortet.
      if (res.status < 500) return
      lastErr = new Error(`Status ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timeout beim Warten auf ${url}: ${String(lastErr)}`)
}

async function cleanup(exitCode: number): Promise<void> {
  if (cleaningUp) return
  cleaningUp = true

  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (err) {
      console.error(`[start-stack] cleanup: ${label} fehlgeschlagen:`, err)
    }
  }

  const withTimeout = (fn: () => Promise<unknown>, ms: number) =>
    Promise.race([
      Promise.resolve().then(fn),
      new Promise((_res, rej) => setTimeout(() => rej(new Error(`Timeout nach ${ms}ms`)), ms)),
    ])

  try {
    if (nextProc && nextProc.pid && !nextProc.killed) {
      try {
        process.kill(nextProc.pid, 'SIGTERM')
      } catch {
        /* schon weg */
      }
    }
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE)
    // Reihenfolge: erst die Verbraucher der Postgres-Verbindung schließen
    // (app + DB-Pool), DANN die Container stoppen — sonst feuert der Pool einen
    // asynchronen Verbindungsfehler, wenn der Container unter ihm wegbricht.
    // Jeder Schritt mit Timeout, damit ein Hänger den Container-Stop nicht
    // blockiert (sonst würde der Teardown-SIGKILL sie leaken lassen).
    await step('app.close', () => withTimeout(() => app?.close() ?? Promise.resolve(), 10_000))
    await step('db.close', () => withTimeout(() => dbHandle?.close() ?? Promise.resolve(), 10_000))
    await step('idp.stop', () => withTimeout(() => idp?.stop() ?? Promise.resolve(), 10_000))
    await step('forgejo.stop', () => withTimeout(() => forgejo?.stop() ?? Promise.resolve(), 30_000))
    await step('pg.stop', () => withTimeout(() => pg?.stop() ?? Promise.resolve(), 30_000))
  } finally {
    process.exit(exitCode)
  }
}

// Während des Teardowns kann der Postgres-Pool noch asynchrone Verbindungs-
// fehler emittieren (Container/Netz verschwindet) — die dürfen den geordneten
// Exit nicht mit einem Crash-Dump abbrechen.
process.on('uncaughtException', (err) => {
  if (cleaningUp) return
  console.error('[start-stack] uncaughtException:', err)
  void cleanup(1)
})
process.on('unhandledRejection', (err) => {
  if (cleaningUp) return
  console.error('[start-stack] unhandledRejection:', err)
  void cleanup(1)
})

process.on('SIGTERM', () => void cleanup(0))
process.on('SIGINT', () => void cleanup(0))

main().catch((err) => {
  console.error('[start-stack] Start fehlgeschlagen:', err)
  void cleanup(1)
})
