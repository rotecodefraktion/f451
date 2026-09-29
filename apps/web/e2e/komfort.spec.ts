import { test, expect, type Page } from '@playwright/test'

/**
 * Phase-3a-Abnahme (Task 5): die Komfort-Flows gegen den echten Stack (API +
 * Mock-IdP + Forgejo-/Postgres-Container + `next dev`), der von
 * `e2e/setup/start-stack.ts` hochgefahren wird.
 *
 *   1. Login über den Mock-IdP (Sequenz identisch zu `lese-ui.spec.ts` Flow 1
 *      — der Login-Zustand wird für die folgenden Flows gebraucht).
 *   2. ⌘K-Präfix-Suche: ein unvollständiges Wort findet die Deployment-Seite
 *      nur über den `prefix=true`-Zweig (Phase 3a Task 1).
 *   3. Verweis-Report: die Seed-Seite „Report-Fixture" verweist auf eine
 *      fehlende Seite — der Report listet den kaputten Verweis, der
 *      Seitentitel verlinkt zurück zur betroffenen Seite.
 *   4. Graph-Ansicht (Phase 3b Task 7): Knoten/Kanten rendern, der
 *      Kantentyp-Toggle „Hierarchie" blendet die Hierarchie-Kanten per CSS
 *      aus, ein Knoten-Klick öffnet das Detail-Popover — inklusive
 *      Regression für den Escape-Dialog-Fix (Task 5: Escape für den
 *      offenen ⌘K-Dialog darf das Popover nicht mitschließen) — und
 *      „Öffnen" navigiert zur Leseansicht.
 *   5. Mini-Graph „Verknüpfte Seiten" in der Rail der Leseansicht (Task 6):
 *      sichtbar, und ein Nachbar-Link im SVG navigiert zur Nachbar-Seite.
 *   6. Neue Seite aus Vorlage (Phase 3c Task 7): die Seed-Vorlage
 *      „Meeting-Notiz" füllt {{titel}}/{{autor}}/{{datum}} im neu angelegten
 *      Entwurf, keine rohen Platzhalter bleiben stehen.
 *   7. „Als Vorlage speichern …" (Phase 3c Task 7): der Editor-Inhalt der
 *      eben angelegten Seite wird als neue Vorlage „Sync-Gerüst" gesichert
 *      (Erfolgszeile mit Ziel-Pfad) und erscheint danach in der Vorlagen-
 *      Auswahl des Neue-Seite-Dialogs.
 *   8. YouTube-Embed (Phase 3d): die Seed-Seite „Video-Demo" bettet die
 *      alleinstehende URL als Thumbnail ein (kein iframe vor dem Klick), die
 *      Satz-URL bleibt unangetastet, ein Klick lädt den youtube-nocookie-
 *      iframe, und der Editor zeigt den eigenen Block-Node statt Textzeile.
 *   9. Security-Header (Phase 4a Task 4): die Startseiten-Antwort trägt eine
 *      `content-security-policy` mit `frame-src` genau auf youtube-nocookie
 *      UND die per `NEXT_PUBLIC_DRAWIO_URL` konfigurierte draw.io-Stub-Origin
 *      (`start-stack.ts`) — UND über die komplette Flow-1–8-Session (Theme-
 *      Script, ⌘K-Dialog, Graph-SVG, Vorlagen-Dialog, YouTube-iframe-Klick)
 *      ist KEINE CSP-Violation in der Browser-Konsole aufgelaufen (Listener
 *      s. `beforeAll`/`cspViolations` unten).
 *
 * `describe.serial` mit EINER geteilten Seite: Flow 2–8 setzen den
 * Login-Zustand aus Flow 1 voraus; Flow 5 baut auf der Deployment-Seite auf,
 * auf der Flow 4 endet; Flow 7 baut auf der im Editor geöffneten Seite aus
 * Flow 6 auf; Flow 9 wertet die über ALLE vorherigen Flows gesammelten
 * Konsolen-Meldungen aus, muss also als LETZTER Test laufen.
 */
const SPACE = 'e2e-handbuch'

// `start-stack.ts` setzt für `next dev` `NEXT_PUBLIC_DRAWIO_URL` auf genau
// diese Origin (dort `DRAWIO_STUB_ORIGIN`, s. Kommentar dort) — dieselbe
// Duplizierung wie in `diagramme.spec.ts` (eigener Prozess, kein direkter
// Modul-Import möglich).
const DRAWIO_STUB_ORIGIN = 'http://127.0.0.1:4599'

test.describe.configure({ mode: 'serial' })

let page: Page
// Sammelt JEDE „Refused to .../Content Security Policy"-Konsolenmeldung, die
// während der Flows 1–8 auffällt (Theme-Script, YouTube-iframe, Graph-SVG,
// ⌘K-Dialog, Vorlagen-Flow) — Flow 9 wertet sie als Testversagen. Chrome
// meldet CSP-Verstöße als `console.error`-Einträge mit „Refused to"/„Content
// Security Policy" im Text (kein eigenes `securitypolicyviolation`-DevTools-
// Protokollereignis, das Playwright direkt exponiert).
const cspViolations: string[] = []

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext()
  page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (/content security policy|refused to/i.test(text)) cspViolations.push(text)
  })
})

test.afterAll(async () => {
  await page.context().close()
})

test('Flow 1: Login-Gate → Mock-IdP-Login → Wiki', async () => {
  // Unangemeldet auf eine geschützte Route → Server leitet auf die Login-Seite.
  await page.goto('/wiki')
  await expect(page).toHaveURL(/\/\?next=/)
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()

  // Login anstoßen — der Mock-IdP redirectet ohne Interaktion durch bis zurück
  // ins Wiki. Auf das Ende der Redirect-Kette warten.
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}`))

  // Eingeloggt: Avatar-Button in der Topbar ist da, die Startseite ist gerendert.
  await expect(page.locator('button.avatar')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Handbuch', level: 1 })).toBeVisible()
})

test('Flow 2: ⌘K-Präfix-Suche — „Zauberwo" findet die Deployment-Seite', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  const searchInput = page.getByRole('combobox', { name: 'Suchbegriff' })
  await expect(searchInput).toBeVisible()

  // „Zauberwort" steht nur auf der Deployment-Seite; „Zauberwo" ist als
  // unvollständiges Wort NUR über den Präfix-Zweig (prefix=true) findbar —
  // vor Phase 3a lieferte diese Eingabe keinen Treffer.
  await searchInput.fill('Zauberwo')
  await expect(page.getByRole('option', { name: /Deployment/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('Flow 3: Verweis-Report — kaputter Verweis gelistet, Link führt zur Seite', async () => {
  await page.goto(`/wiki/${SPACE}`)
  await page.locator('nav.tree').getByRole('link', { name: 'Verweis-Report' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/report$`))
  await expect(page.getByRole('heading', { name: 'Verweis-Report', level: 1 })).toBeVisible()

  // Die Seed-Seite „Report-Fixture" verweist auf [[nicht-vorhanden]] —
  // genau dieser Roh-Target-Text muss im Report stehen.
  await expect(page.getByText('nicht-vorhanden')).toBeVisible()

  // Der Seitentitel verlinkt auf die Leseansicht der betroffenen Seite. Auf
  // den Hauptinhalt scopen — „Report-Fixture" erscheint seit dem Seeden auch
  // im Seitenbaum der Sidebar (zweiter, gleichnamiger Link).
  await page.locator('main').getByRole('link', { name: 'Report-Fixture' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/report-fixture$`))
  await expect(page.getByRole('heading', { name: 'Report-Fixture', level: 1 })).toBeVisible()
})

test('Flow 4: Graph-Ansicht — Knoten, Kantentyp-Toggle, Popover-Navigation', async () => {
  await page.goto(`/wiki/${SPACE}`)
  await page.locator('nav.tree').getByRole('link', { name: 'Graph-Ansicht' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/graph$`))

  // Der Graph rendert Knoten (Seed hat >5 Seiten) und Kanten.
  const svg = page.locator('svg.graph')
  await expect(svg).toBeVisible()
  expect(await svg.locator('g.node').count()).toBeGreaterThan(3)
  expect(await svg.locator('.edges.e-hier line').count()).toBeGreaterThan(0)

  // Kantentyp-Toggle „Hierarchie" blendet die Gruppe aus (CSS hide-hier).
  await page.getByRole('button', { name: 'Hierarchie' }).click()
  await expect(svg).toHaveClass(/hide-hier/)
  await page.getByRole('button', { name: 'Hierarchie' }).click()
  await expect(svg).not.toHaveClass(/hide-hier/)

  // Knoten-Klick öffnet das Detail-Popover.
  const deploymentNode = svg.locator('g.node', { has: page.locator('text.lbl', { hasText: 'Deployment' }) }).first()
  await deploymentNode.click()
  const pop = page.locator('.pop')
  await expect(pop).toBeVisible()
  // `.t` enthält neben dem Titel auch den <small>-Untertitel („Space … ·
  // Seite", Mockup-Struktur) — Titel (am Textanfang) und Untertitel deshalb
  // getrennt prüfen statt toHaveText auf den Gesamttext.
  await expect(pop.locator('.t')).toHaveText(/^Deployment/)
  await expect(pop.locator('.t small')).toHaveText('Space Handbuch · Seite')
  // innerText spiegelt gerendertes text-transform wider — Regression für die
  // CSS-Kollision mit dem Editor-Popover (globals.css `.pop .ph` uppercased
  // sonst den Titel zu „DEPLOYMENT", Fix: Kollisions-Reset in graph.css).
  expect(await pop.locator('.t').innerText()).toMatch(/^Deployment\b/)

  // Regression für den Escape-Dialog-Fix (Task 5, graph-view.tsx): Escape,
  // das dem offenen ⌘K-Suchdialog gilt, darf das Graph-Popover NICHT
  // mitschließen — nur ein zweites, eigenständiges Escape (ohne offenen
  // Dialog) schließt es.
  await page.keyboard.press('ControlOrMeta+k')
  const searchInput = page.getByRole('combobox', { name: 'Suchbegriff' })
  await expect(searchInput).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(searchInput).not.toBeVisible()
  await expect(pop).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pop).not.toBeVisible()

  // Knoten erneut auswählen — „Öffnen" navigiert zur Leseansicht.
  await deploymentNode.click()
  await expect(pop).toBeVisible()
  await pop.getByRole('link', { name: 'Öffnen' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/deployment$`))
  await expect(page.getByRole('heading', { name: 'Deployment', level: 1 })).toBeVisible()
})

test('Flow 5: Mini-Graph in der Rail der Leseansicht', async () => {
  // Von Flow 4 stehen wir auf der Deployment-Seite; die Rail (Viewport 1280px)
  // zeigt „Verknüpfte Seiten" mit dem Mini-Graph-SVG.
  const rail = page.locator('aside.rail')
  await expect(rail.getByRole('heading', { name: 'Verknüpfte Seiten' })).toBeVisible()
  const miniGraph = rail.locator('svg[aria-label="Mini-Graph verknüpfter Seiten"]')
  await expect(miniGraph).toBeVisible()

  // Nachbar-Link im Mini-Graph-SVG anklicken — „Betrieb" ist über die
  // Hierarchie-Kante (Eltern von Deployment) UND einen Wikilink verbunden,
  // also sicher in der Tiefe-1-Nachbarschaft enthalten (start-stack.ts:
  // Seed `betrieb/deployment`). Das SVG-Link-Klickverhalten war bisher nur
  // SSR-verifiziert (Task 6).
  await miniGraph.getByRole('link', { name: 'Betrieb' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/betrieb$`))
  await expect(page.getByRole('heading', { name: 'Betrieb', level: 1 })).toBeVisible()
})

test('Flow 6: Neue Seite aus Vorlage — Platzhalter gefüllt', async () => {
  // Seed-Vorlage `_templates/meeting-notiz.md` (start-stack.ts): {{titel}}/
  // {{autor}}/{{datum}} im Body, keine Unterordner unter _templates/ (Task 2).
  await page.goto(`/wiki/${SPACE}`)
  // Trigger hat KEINEN sichtbaren Text — nur `aria-label="Neue Seite anlegen"`
  // (new-page-button.tsx), der Regex matcht trotzdem über den Accessible Name.
  await page.locator('nav.tree').getByRole('button', { name: /Neue Seite anlegen/ }).click()
  // Dialog gescoped: der eigene Accessible Name „Neue Seite anlegen" (natives
  // <dialog aria-label>) überschneidet sich sonst mit dem Trigger-Button —
  // `getByRole('button', { name: 'Anlegen' })` würde ohne Scope beide treffen
  // (Playwrights Namens-Matching ist Teilstring/case-insensitiv).
  const newPageDialog = page.getByRole('dialog', { name: 'Neue Seite anlegen' })
  await newPageDialog.getByRole('textbox', { name: 'Titel' }).fill('Team-Sync')
  await newPageDialog.getByRole('radio', { name: /Meeting-Notiz/ }).check()
  await newPageDialog.getByRole('button', { name: 'Anlegen' }).click()
  await page.waitForURL(/\/edit$/)
  const editor = page.locator('.ProseMirror')
  await expect(editor).toContainText('Team-Sync')
  await expect(editor).toContainText('Datum: ')
  await expect(editor).not.toContainText('{{')
})

test('Flow 7: Als Vorlage speichern — erscheint in der Vorlagen-Auswahl', async () => {
  // Wir stehen im Editor der eben angelegten Seite (Flow 6). Der Dialog-
  // Trigger sitzt im „Verwerfen"-Dropdown der Statuszeile (status-bar.tsx) —
  // der Button-Text selbst ist exakt „Verwerfen" (Chevron-Icon ist aria-hidden).
  await page.getByRole('button', { name: 'Verwerfen' }).click()
  await page.getByRole('menuitem', { name: /Als Vorlage speichern/ }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill('Sync-Gerüst')
  await page.getByRole('button', { name: 'Speichern' }).click()
  // Slug gegen die echte `pathSegmentFromTitle`/`slugify`-Formel bestimmt
  // (nicht geraten, s. `packages/markdown/src/slug.ts`): Umlaute bleiben 1:1
  // erhalten, also „sync-gerüst" statt einer „sync-geruest"-Transliteration.
  await expect(page.getByText('_templates/sync-gerüst.md')).toBeVisible()
  // Neue-Seite-Dialog zeigt die neue Vorlage:
  await page.keyboard.press('Escape')
  await page.goto(`/wiki/${SPACE}`)
  await page.locator('nav.tree').getByRole('button', { name: /Neue Seite anlegen/ }).click()
  await expect(page.getByRole('radio', { name: /Sync-Gerüst/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('Flow 8: YouTube-Embed — Thumbnail zuerst, iframe erst per Klick, Editor zeigt Platzhalter', async () => {
  await page.goto(`/wiki/${SPACE}/youtube-demo`)
  const embed = page.locator('.page-body .yt-embed')
  await expect(embed).toHaveCount(1) // die Satz-URL wird NICHT eingebettet
  await expect(embed).toHaveAttribute('data-video-id', 'dQw4w9WgXcQ')
  await expect(embed.locator('iframe')).toHaveCount(0) // kein iframe vor dem Klick
  // Beschriftung kommt seit Issue #9 aus einer CSS-Variable (folgt der
  // UI-Sprache, nicht der Seitensprache) statt aus dem HTML-Text — `getByText`
  // fände sie nicht mehr (CSS-`::before`-Inhalt ist kein DOM-Textknoten).
  await expect(embed.locator('.yt-play')).toBeVisible()

  await embed.locator('a.yt-link').click()
  const frame = embed.locator('iframe.yt-frame')
  await expect(frame).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1')

  // Editor: eigener Block-Node statt Textzeile.
  await page.goto(`/wiki/${SPACE}/youtube-demo/edit`)
  await expect(page.locator('.ProseMirror .yt-embed-editor')).toHaveCount(1)
})

test('Flow 9: Security-Header — Nonce-CSP trägt frame-src (youtube-nocookie + drawio-Origin), keine Violations über Flow 1–8', async () => {
  // Startseiten-Antwort (CSP aus `middleware.ts`, statische Header aus
  // next.config.ts#headers()) — NICHT die Rewrite-proxierten API-Antworten
  // (`/api`/`/auth`/`/admin`/`/media`), die tragen die API-eigenen Header
  // (apps/api/src/app.ts's onSend-Hook), s. README.
  const response = await page.goto('/wiki')
  const csp = response?.headers()['content-security-policy']
  expect(csp).toBeTruthy()
  // Per-Request-Nonce (Fix-Runde 1): script-src ist nonce-basiert — ein
  // statischer Build-Zeit-Hash kann Nexts per-Request-Hydration-Inline-
  // Skripte (`__next_f.push`) prinzipiell nicht abdecken, s. `middleware.ts`.
  expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/)
  expect(csp).toContain('frame-src')
  expect(csp).toContain('https://www.youtube-nocookie.com')
  // config-abgeleitet: `start-stack.ts` setzt NEXT_PUBLIC_DRAWIO_URL auf den
  // Stub-Port — die CSP muss GENAU diese Origin tragen, sonst würde das
  // draw.io-Stub-iframe in `diagramme.spec.ts` von der eigenen CSP geblockt.
  expect(csp).toContain(DRAWIO_STUB_ORIGIN)
  expect(response?.headers()['x-content-type-options']).toBe('nosniff')
  expect(response?.headers()['referrer-policy']).toBe('same-origin')

  // Über die komplette bisherige Session (Flows 1–8: Theme-Script, ⌘K-Dialog,
  // Graph-SVG, Vorlagen-Dialog, YouTube-Thumbnail-Klick + -iframe) ist KEINE
  // CSP-Violation aufgelaufen.
  expect(cspViolations).toEqual([])
})
