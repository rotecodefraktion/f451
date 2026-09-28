import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'

/**
 * Phase-2c-Abnahme (Task 7): die fünf End-to-End-Editor-Flows aus dem Task-Brief
 * gegen den echten Stack (API + Mock-IdP + Forgejo-/Postgres-Container + `next dev`),
 * derselbe von `e2e/setup/start-stack.ts` hochgefahrene Stack wie `lese-ui.spec.ts`.
 * Der Seed-Nutzer ist seit diesem Task über einen ECHTEN Forgejo-Collaborator
 * (nicht das Admin-Token) mit dem Wiki-Repo verknüpft — Autosave-Commits tragen
 * dadurch eine vom Repo-Owner unabhängige, per Forgejo-API verifizierbare Autorschaft
 * (Abnahme-Kriterium „Commit-Autor = Seed-Nutzer").
 *
 *   1. Bearbeiten-Zyklus: Login → Seite → „Bearbeiten" → Statuszeile „Entwurf" →
 *      tippen → Moduswechsel zu Markdown (flusht Save) → Draft-API zeigt den
 *      getippten Text + `lock.mine === true` → zurück zu WYSIWYG → verwerfen →
 *      Leseansicht, Draft-API danach 404.
 *   2. Slash-Menü + Wikilink-Autocomplete: `[[`-Auswahl rendert `a.wiki-link` UND
 *      landet als `[[ziel|Alias]]` im gespeicherten Draft; `/`-Menü fügt eine
 *      Tabelle ein; Enter in einer Zelle springt zur nächsten Zelle statt einen
 *      zweiten Block/eine zweite Zeile IM SELBEN Feld zu erzeugen (2b-Hard-Throw
 *      im UI-Betrieb unerreichbar); UND (Task-5-Review-Finding) das `/`-Menü
 *      erscheint NICHT, solange der Cursor in einer Tabellenzelle steht.
 *   3. Media-Upload: der Toolbar-Button öffnet den ECHTEN Datei-Dialog (bewiesen
 *      über `page.waitForEvent('filechooser')`, nicht nur ein direktes
 *      `setInputFiles` auf das versteckte `<input>` — das beweist das Trigger-
 *      Wiring, nicht nur den Upload-Endpunkt), das Bild lädt über die
 *      `?ref=draft`-Media-Route (Task 1) und landet als `![](_media/…)` im
 *      gespeicherten Draft.
 *   4. Moduswechsel-Schutz: die geseedete `legacy`-Seite (roher HTML-Block)
 *      startet im Markdown-Modus, die WYSIWYG-Lasche ist nicht gedrückt (mit Begründung im
 *      `title`), das Befund-Panel zeigt den `unsupported`-Befund.
 *   5. Responsive: die Edit-Route erzeugt bei 390×844 keinen horizontalen Scroll
 *      (`document.documentElement.scrollWidth <= 390`) — erste automatisierte
 *      Mockup-Treue-Assertion des Repos.
 *
 * `describe.serial` mit EINER geteilten Seite (eigener Login, unabhängig von
 * `lese-ui.spec.ts`) — jeder Flow bearbeitet eine ANDERE Seite, damit Drafts sich
 * nicht gegenseitig stören; nur Flow 1 räumt seinen Draft (Verwerfen) explizit auf,
 * der Rest hinterlässt bewusst offene Entwürfe (harmlos, derselbe Nutzer/Lock).
 */
const SPACE = 'e2e-handbuch'
const UPLOAD_FIXTURE = fileURLToPath(new URL('./fixtures/upload-test.svg', import.meta.url))
const MARKER = 'E2E-Bearbeitungsmarke-42'

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
  // Eigener Login-Lauf (unabhängiger Browser-Kontext von lese-ui.spec.ts) — Muster
  // identisch zu dessen Flow 1, hier ohne erneute Login-Gate-Assertion (bereits dort
  // abgedeckt), nur die Voraussetzung für die folgenden Editor-Flows.
  await page.goto('/wiki')
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}`))
})

test('Flow 1: Bearbeiten-Zyklus — Autosave, Moduswechsel-Flush, Verwerfen', async () => {
  // Seite → „Bearbeiten".
  await page.goto(`/wiki/${SPACE}/home`)
  await page.getByRole('link', { name: 'Bearbeiten' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/home/edit`))

  // Statuszeile zeigt „Entwurf" — sobald die Toolbar da ist, ist die Session gemountet.
  await expect(page.locator('.etoolbar')).toBeVisible()
  await expect(page.locator('.statusbar .chip')).toContainText('Entwurf')

  // Sichtbarer „Speichern"-Button (Post-1-Zusatz, s. status-bar.tsx): deaktiviert,
  // solange der frisch geladene Draft unverändert ist (nichts zu speichern).
  const saveButton = page.getByRole('button', { name: 'Speichern' })
  await expect(saveButton).toBeDisabled()

  // Tippen: Cursor ans Ende des (einzigen) Absatzes, neuer Absatz mit Marker-Text.
  const doc = page.locator('.doc.page-body')
  await doc.locator('p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(MARKER)

  // Der Button wird aktiv; ein Klick löst SOFORT denselben Save-Pfad wie ⌘S aus
  // (kein Warten auf den 30s-Debounce) und deaktiviert sich danach wieder.
  await expect(saveButton).toBeEnabled()
  await saveButton.click()
  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 15_000 })
  await expect(saveButton).toBeDisabled()

  // Moduswechsel zu Markdown flusht den Save sofort (kein 30s-Warten nötig).
  // Der Umschalter ist seit Teilschritt G eine segmentierte Auswahl: gewöhnliche
  // Schaltflächen mit `aria-pressed`, kein `role="tab"` mehr.
  await page.getByRole('button', { name: 'Markdown' }).click()
  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 15_000 })

  // Draft-API (Playwrights request-Context übernimmt den Browser-Cookie automatisch):
  // enthält den getippten Text, Lock gehört dem eigenen Nutzer.
  const draftRes = await page.request.get('/api/pages/home/draft')
  expect(draftRes.ok()).toBe(true)
  const draft = (await draftRes.json()) as { content: string; lock: { mine: boolean } | null }
  expect(draft.content).toContain(MARKER)
  expect(draft.lock?.mine).toBe(true)

  // Zurück zu WYSIWYG — bei Bedarf den Normalisierungs-Dialog bestätigen (keine
  // Formatierungsänderung erwartet, defensiv trotzdem behandelt).
  await page.getByRole('button', { name: 'WYSIWYG' }).click()
  const normalizeDialog = page.getByRole('dialog', { name: 'Formatierung normalisieren?' })
  if (await normalizeDialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.getByRole('button', { name: 'Normalisieren und wechseln' }).click()
  }
  await expect(page.getByRole('button', { name: 'WYSIWYG' })).toHaveAttribute('aria-pressed', 'true')

  // „Entwurf verwerfen" — bestätigenden confirm()-Dialog annehmen.
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Verwerfen' }).click()
  await page.getByRole('menuitem', { name: 'Entwurf verwerfen' }).click()

  // Zurück in der Leseansicht.
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/home$`))
  await expect(page.getByRole('heading', { name: 'Handbuch', level: 1 })).toBeVisible()

  // Draft-API meldet nach dem Verwerfen 404.
  const afterDiscard = await page.request.get('/api/pages/home/draft')
  expect(afterDiscard.status()).toBe(404)
})

test('Flow 2: Slash-Menü + Wikilink-Autocomplete (inkl. Tabellen-Guard)', async () => {
  await page.goto(`/wiki/${SPACE}/betrieb/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()
  const doc = page.locator('.doc.page-body')

  // `[[`-Autocomplete: geseedete Seite „Deployment" auswählen → `a.wiki-link` im DOM.
  await doc.locator('p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('[[Deployment')
  const wikiPopup = page.getByRole('listbox', { name: 'Seiten-Autocomplete' })
  await expect(wikiPopup).toBeVisible()
  await expect(wikiPopup.getByRole('option', { name: /Deployment/ })).toBeVisible()
  await page.keyboard.press('Enter')
  const insertedLink = doc.locator('a.wiki-link').last()
  await expect(insertedLink).toBeVisible()
  await expect(insertedLink).toHaveAttribute('data-target', 'betrieb/deployment')

  // `/`-Menü: „Tabelle" fügt eine Tabelle ein.
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const slashMenu = page.getByRole('listbox', { name: 'Befehlsmenü' })
  await expect(slashMenu).toBeVisible()
  await slashMenu.getByRole('option', { name: /Tabelle/ }).click()
  await expect(doc.locator('table')).toBeVisible()

  const cellA = doc.locator('table td').nth(0)
  const cellB = doc.locator('table td').nth(1)
  const cellC = doc.locator('table td').nth(2)

  // Enter in einer Zelle springt zur NÄCHSTEN Zelle statt einen zweiten Block bzw.
  // eine zweite Zeile im SELBEN Feld zu erzeugen (table-guard.ts — der 2b-Hard-Throw
  // in docToMarkdown ist dadurch im UI-Betrieb unerreichbar).
  await cellA.click()
  await page.keyboard.type('A1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('B1')
  await expect(cellA).toHaveText('A1')
  await expect(cellB).toHaveText('B1')
  await expect(cellA.locator('p')).toHaveCount(1)

  // Task-5-Review-Finding: das `/`-Menü erscheint NICHT, solange der Cursor in
  // einer Tabellenzelle steht (`shouldShow` in ui-extensions.ts).
  await cellC.click()
  await page.keyboard.type('/')
  await expect(slashMenu).toBeHidden()

  // Autosave-Flush per ⌘S (kein 30s-Warten) — Draft-Save enthält die eingefügte
  // Wikilink-Syntax `[[ziel|Alias]]`.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 15_000 })
  const draftRes = await page.request.get('/api/pages/betrieb/draft')
  expect(draftRes.ok()).toBe(true)
  const draft = (await draftRes.json()) as { content: string }
  expect(draft.content).toContain('[[betrieb/deployment|Deployment]]')
})

test('Flow 3: Media-Upload über die Toolbar', async () => {
  await page.goto(`/wiki/${SPACE}/deployment/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()
  const doc = page.locator('.doc.page-body')
  const initialImgCount = await doc.locator('img').count()

  // Toolbar-Button öffnet den ECHTEN Datei-Dialog (beweist das Trigger-Wiring:
  // Button → `triggerImageUpload`-Command → verstecktes `<input type=file>`).
  // Deckt seit der Editor-Erweiterung „Datei-Anhänge" auch Nicht-Bild-Dateien ab
  // (PDF/Office/ZIP/Text), daher der erweiterte Button-Titel.
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Bild oder Datei einfügen' }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(UPLOAD_FIXTURE)

  // Bild lädt WIRKLICH (naturalWidth > 0) über die Draft-Media-Route (Task 1).
  const newImg = doc.locator('img').nth(initialImgCount)
  await expect(newImg).toBeVisible({ timeout: 15_000 })
  await expect(newImg).toHaveAttribute('src', /\/media\/.*ref=draft/)
  await expect
    .poll(async () => newImg.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0)

  // Autosave-Flush per ⌘S — Draft-Save enthält die Markdown-Bildreferenz.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 15_000 })
  const draftRes = await page.request.get('/api/pages/deployment/draft')
  expect(draftRes.ok()).toBe(true)
  const draft = (await draftRes.json()) as { content: string }
  expect(draft.content).toMatch(/!\[]\(_media\/[^)]+\.svg\)/)
})

test('Flow 4: Moduswechsel-Schutz — Seite mit rohem HTML startet im Roh-Modus', async () => {
  await page.goto(`/wiki/${SPACE}/legacy/edit`)

  const markdownTab = page.getByRole('button', { name: 'Markdown' })
  const wysiwygTab = page.getByRole('button', { name: 'WYSIWYG' })
  await expect(markdownTab).toHaveAttribute('aria-pressed', 'true')
  await expect(wysiwygTab).toHaveAttribute('aria-pressed', 'false')
  // Begründung sichtbar (Tooltip der Lasche), NICHT stilles Nichtstun.
  await expect(wysiwygTab).toHaveAttribute('title', /.+/)

  // Roh-Modus zeigt den tatsächlichen HTML-Block.
  await expect(page.locator('.raw-editor .cm-content')).toContainText('<div class="legacy">')

  // Befund-Panel zeigt den `unsupported`-Befund.
  const findingsButton = page.getByRole('button', { name: /Befund/ })
  await expect(findingsButton).toBeVisible()
  await findingsButton.click()
  const findingsDialog = page.getByRole('dialog', { name: 'Validierungsbefunde' })
  await expect(findingsDialog.locator('.finding')).toContainText(/html/i)
})

test('Flow 5: Responsive — kein horizontaler Scroll bei 390×844', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/wiki/${SPACE}/home/edit`)
  await expect(page.locator('.statusbar')).toBeVisible()

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(390)
})
