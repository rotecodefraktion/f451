import { test, expect, type Page } from '@playwright/test'

/**
 * Spec-§11-Abnahme (Phase 4b Task 5): das Störungs-Drehbuch aus
 * `deploy/BETRIEB.md` als automatisierte E2E-Flows — dieselbe Spec-§9-
 * Verhaltenserwartung („Änderungen überleben Provider-/Session-Ausfälle"),
 * gegen denselben Stack wie `workflow.spec.ts`/`diagramme.spec.ts` (EIN
 * `globalSetup`-Lauf, `workers: 1` — alle Spec-Dateien teilen sich Postgres/
 * Forgejo/Mock-IdP/`next dev`). Drei eigene, von anderen Spec-Dateien
 * UNBERÜHRTE Seiten (`resilienz-1/2/3`, s. `setup/start-stack.ts#seedRepo`),
 * damit die Reihenfolge der Spec-Dateien keine Rolle spielt.
 *
 *   1. Offline-Puffer + Nachschub (Task 1/2 der Phase): ein `page.route`-Stub
 *      lässt den Autosave-PUT wie einen echten Verbindungsabbruch scheitern
 *      (`route.abort('connectionrefused')`, KEIN regulärer HTTP-Fehlercode —
 *      das ist der Netzwerkfehlerpfad, den `client-api.ts#rawFetch` als
 *      `ClientApiError(status:0)` klassifiziert). Ein einzelner ⌘S-Anstoß
 *      reicht: die Autosave-State-Machine (`lib/editor/autosave.ts`) durchläuft
 *      danach SELBSTSTÄNDIG den Backoff (2s/4s/8s) bis zum dritten Fehlversuch
 *      — erst dann ist der `offline`-Zustand erreicht (Statusband „Änderungen
 *      lokal — Server nicht erreichbar", byte-exakt inkl. Gedankenstrich
 *      U+2014). Puffer-Existenz wird direkt über `localStorage` geprüft
 *      (`f451.offline.<pageId>`, s. `lib/editor/offline-buffer.ts`). Danach
 *      Route freigeben + ein zweiter ⌘S (aus `offline` heraus IMMER ein
 *      erlaubter manueller Retry, s. `autosave.ts#flushNow`) als Nachschub-
 *      Trigger — die Alternative aus dem Brief (`online`-Browser-Event) wäre
 *      gleichwertig, ⌘S ist deterministischer (kein Warten auf
 *      Browser-Event-Timing). Kein Sleep: der Backoff-Ablauf selbst IST die
 *      zu beweisende Produktzeit, kein Test-Artefakt — ein großzügiges
 *      `expect`-Timeout deckt ihn ab.
 *   2. Token-Widerruf, Inhalt überlebt (Task 4/3 der Phase): Text ändern, aber
 *      BEWUSST nicht explizit speichern (kein ⌘S vor dem Cookie-Löschen) —
 *      der Inhalt bleibt nur „dirty". `context.clearCookies()` entfernt die
 *      Session, ein anschließendes ⌘S trifft auf 401 → `client-api.ts`
 *      navigiert selbst zur Login-Seite MIT `?next=` auf die Edit-Route
 *      zurück — der Offline-Puffer wird dabei VOR der Navigation geschrieben
 *      (derselbe `saveContent`-Catch-Pfad wie in Flow 1, `SessionExpiredError`
 *      puffert genauso wie ein Netzwerk-/5xx-Fehler, s. `editor-root.tsx`-
 *      Kommentar „Editor-Inhalt überlebt Re-Login"). Re-Login über denselben
 *      Mock-IdP-Link wie `login()` — die Login-Transaktion trägt `next`
 *      serverseitig weiter (`apps/api/src/routes/auth.ts`), landet also
 *      automatisch wieder auf der Edit-Route. Dort zeigt der Mount-Recovery-
 *      Dialog (Task 3) den gepufferten Stand mit Zeitstempel; „Übernehmen"
 *      übernimmt ihn in den Editor, ein regulärer Save danach persistiert ihn
 *      (Draft-API-Assertion) und räumt den Puffer.
 *   3. Recovery verwerfen: ein per `page.evaluate` VOR der Navigation
 *      präparierter Puffer-Eintrag (mit echtem `branch`/`baseSha` des
 *      aktuellen Drafts — erst per `POST .../draft` gelesen, dann in
 *      `localStorage` geschrieben, s. Brief) triggert beim Editor-Mount
 *      denselben Dialog; „Verwerfen" räumt ihn — der Editor zeigt weiterhin
 *      den unveränderten Server-Stand, der präparierte Fremd-Text landet NIE
 *      im Dokument.
 *
 * Keine Sleeps: jede Wartezeit ist entweder ein `expect`/`expect.poll` (mit
 * explizitem Timeout auf reale Produktzeiten wie den Autosave-Backoff) oder
 * ein `waitForURL`. Kein expliziter Draft-Discard am Ende der Flows nötig
 * (Muster `editor.spec.ts`-Kopfkommentar: „der Rest hinterlässt bewusst
 * offene Entwürfe, harmlos, derselbe Nutzer/Lock") — die jeweils relevante
 * Aufräumbedingung ist der geräumte `localStorage`-Puffer, den jeder Flow
 * explizit prüft.
 */
const SPACE = 'e2e-handbuch'

async function login(page: Page): Promise<void> {
  await page.goto('/wiki')
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}`))
}

/** Tippt `marker` als neuen Absatz ans Ende des ersten Absatzes — Muster
 *  `editor.spec.ts`/`workflow.spec.ts`. */
async function appendMarkerParagraph(page: Page, marker: string): Promise<void> {
  const doc = page.locator('.doc.page-body')
  await doc.locator('p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(marker)
}

/** ⌘S — sofortiger Flush (Brief: nie auf den 30s-Debounce warten), wartet auf
 *  die Bestätigung in der Statuszeile — Muster `workflow.spec.ts#saveNow`. */
async function saveNow(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 20_000 })
}

function offlineStorageKey(pageId: string): string {
  return `f451.offline.${pageId}`
}

/** Liest den rohen `localStorage`-Puffer-Eintrag einer Seite, oder `null`. */
function readOfflineBuffer(page: Page, pageId: string): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), offlineStorageKey(pageId))
}

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await page.context().close()
})

test('Login', async () => {
  await login(page)
  await expect(page.locator('button.avatar')).toBeVisible()
})

test('Flow 1: Offline-Puffer + Nachschub — Statusband exakt, localStorage, Wiederauffüllung nach Rückkehr', async () => {
  test.setTimeout(90_000)
  const PAGE_ID = 'resilienz-1'
  const MARKER = 'E2E-RESILIENZ-FLOW1-OFFLINE-8821'

  await page.goto(`/wiki/${SPACE}/${PAGE_ID}/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()
  await appendMarkerParagraph(page, MARKER)

  // Netzwerk-Stub: NUR der Autosave-PUT scheitert wie ein echter
  // Verbindungsabbruch — `route.abort('connectionrefused')` lässt `fetch()`
  // selbst werfen (keine `Response`), genau der Netzwerkfehlerpfad, den
  // `classifySaveFailure` (`lib/editor/save-failure.ts`) als `offline-error`
  // einstuft, WENN die Pufferung gelang.
  await page.route('**/api/pages/*/draft', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await route.abort('connectionrefused')
  })

  // Ein einziger ⌘S-Anstoß — die Autosave-State-Machine treibt die weiteren
  // zwei Backoff-Retries (2s/4s) danach selbstständig per Timer, s. Kopfkommentar.
  await page.keyboard.press('ControlOrMeta+s')

  const offlineBand = page.locator('.statusbar .saved.offline')
  await expect(offlineBand).toHaveText('Änderungen lokal — Server nicht erreichbar', { timeout: 25_000 })

  // Puffer existiert UND trägt den getippten Marker.
  const bufferedRaw = await readOfflineBuffer(page, PAGE_ID)
  expect(bufferedRaw).toBeTruthy()
  const buffered = JSON.parse(bufferedRaw!) as { content: string }
  expect(buffered.content).toContain(MARKER)

  // Route freigeben, Nachschub über einen zweiten ⌘S (manueller Retry, aus
  // `offline` heraus laut `autosave.ts#flushNow` IMMER erlaubt).
  await page.unroute('**/api/pages/*/draft')
  await page.keyboard.press('ControlOrMeta+s')

  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 25_000 })
  await expect(page.locator('.statusbar .saved.offline')).toHaveCount(0)

  // Puffer geräumt — nur ein erfolgreicher Save räumt ihn (`editor-root.tsx#saveContent`).
  await expect.poll(() => readOfflineBuffer(page, PAGE_ID), { timeout: 5_000 }).toBeNull()

  // Inhalt server-seitig verifiziert (Draft-API, kein UI-Umweg).
  const draftRes = await page.request.get(`/api/pages/${PAGE_ID}/draft`)
  expect(draftRes.ok()).toBe(true)
  const draft = (await draftRes.json()) as { content: string }
  expect(draft.content).toContain(MARKER)
})

test('Flow 2: Token-Widerruf — Inhalt überlebt Re-Login, Recovery-Dialog „Übernehmen", Save persistiert', async () => {
  test.setTimeout(90_000)
  const PAGE_ID = 'resilienz-2'
  const MARKER = 'E2E-RESILIENZ-FLOW2-TOKENWIDERRUF-4432'
  const editUrl = `/wiki/${SPACE}/${PAGE_ID}/edit`

  await page.goto(editUrl)
  await expect(page.locator('.etoolbar')).toBeVisible()
  await appendMarkerParagraph(page, MARKER)

  // Autosave-Fenster: BEWUSST kein ⌘S vor dem Cookie-Löschen — der Inhalt
  // bleibt nur „dirty", noch nicht gespeichert.
  await page.context().clearCookies()

  // Nächster Save (⌘S statt der realen 30s-Debounce) trifft auf die
  // weggefallene Session → 401 → `client-api.ts#redirectToLogin` navigiert
  // selbst zur Login-Seite MIT `?next=` auf genau diese Edit-Route.
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForURL(/\/\?next=/)
  expect(page.url()).toContain(encodeURIComponent(editUrl))

  // Inhalt überlebt (Spec §9): der Offline-Puffer wurde VOR der Navigation
  // geschrieben (`saveContent`s catch — der `SessionExpiredError`-Zweig
  // puffert wie der Netzwerk-/5xx-Zweig, s. Kopfkommentar).
  const bufferedRaw = await readOfflineBuffer(page, PAGE_ID)
  expect(bufferedRaw).toBeTruthy()
  const buffered = JSON.parse(bufferedRaw!) as { content: string }
  expect(buffered.content).toContain(MARKER)

  // Re-Login (identisches Mock-IdP-Muster wie `login()`) — die Login-
  // Transaktion trägt `next` serverseitig weiter, landet also automatisch
  // wieder auf der Edit-Route.
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/${PAGE_ID}/edit`))
  await expect(page.locator('.etoolbar')).toBeVisible()

  // Mount-Recovery-Dialog (Task 3): Zeitstempel + „Übernehmen".
  const recoveryDialog = page.getByRole('dialog', { name: 'Lokal gesicherte Änderungen' })
  await expect(recoveryDialog).toBeVisible()
  await expect(recoveryDialog).toContainText(/\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/)
  await recoveryDialog.getByRole('button', { name: 'Übernehmen' }).click()
  await expect(recoveryDialog).toBeHidden()

  await expect(page.locator('.doc.page-body')).toContainText(MARKER)

  // Nächster Save persistiert regulär (echtes Netzwerk, keine Route-Stubs aktiv).
  await saveNow(page)
  await expect.poll(() => readOfflineBuffer(page, PAGE_ID), { timeout: 5_000 }).toBeNull()

  const draftRes = await page.request.get(`/api/pages/${PAGE_ID}/draft`)
  expect(draftRes.ok()).toBe(true)
  const draft = (await draftRes.json()) as { content: string }
  expect(draft.content).toContain(MARKER)
})

test('Flow 3: Recovery verwerfen — präparierter Puffer wird verworfen, Server-Stand bleibt im Editor', async () => {
  const PAGE_ID = 'resilienz-3'
  const FAKE_MARKER = 'E2E-RESILIENZ-FLOW3-PUFFER-7733'

  // Draft anlegen (idempotent) und branch/baseSha für einen GÜLTIGEN
  // Puffer-Eintrag lesen (Brief: „ggf. erst Draft anlegen, dessen branch/sha
  // lesen, dann Eintrag setzen").
  const draftRes = await page.request.post(`/api/pages/${PAGE_ID}/draft`)
  expect(draftRes.ok()).toBe(true)
  const draft = (await draftRes.json()) as { branch: string; baseSha: string; content: string }

  const fakeContent = `${draft.content}\n${FAKE_MARKER}\n`

  // localStorage-Eintrag VOR der Navigation zum Editor präparieren — `page.evaluate`
  // läuft bereits auf der WEB_ORIGIN (egal, welche Seite gerade aktiv ist).
  await page.evaluate(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    {
      key: offlineStorageKey(PAGE_ID),
      value: { content: fakeContent, baseSha: draft.baseSha, branch: draft.branch, savedAt: new Date().toISOString() },
    },
  )

  await page.goto(`/wiki/${SPACE}/${PAGE_ID}/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()

  const recoveryDialog = page.getByRole('dialog', { name: 'Lokal gesicherte Änderungen' })
  await expect(recoveryDialog).toBeVisible()
  await recoveryDialog.getByRole('button', { name: 'Verwerfen' }).click()
  await expect(recoveryDialog).toBeHidden()

  // Server-Stand im Editor — der präparierte Fremd-Text ist NICHT übernommen.
  await expect(page.locator('.doc.page-body')).not.toContainText(FAKE_MARKER)
  await expect(page.locator('.doc.page-body')).toContainText('Ursprünglicher Text für den Recovery-Verwerfen-Test.')

  // Puffer geräumt.
  await expect.poll(() => readOfflineBuffer(page, PAGE_ID), { timeout: 5_000 }).toBeNull()
})
