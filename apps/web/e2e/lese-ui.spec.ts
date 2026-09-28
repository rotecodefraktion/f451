import { test, expect, type Page } from '@playwright/test'

/**
 * Phase-1e-Abnahme (Plan Task 6): die vier End-to-End-Lese-Flows gegen den echten
 * Stack (API + Mock-IdP + Forgejo-/Postgres-Container + `next dev`), der von
 * `e2e/setup/start-stack.ts` hochgefahren wird.
 *
 *   1. Unangemeldet auf eine geschützte Seite → Login-Gate → Login über den
 *      Mock-IdP (der redirectet sofort, kein IdP-UI) → gelandet im Wiki.
 *   2. Über den Seitenbaum zur Deployment-Seite → Inhalt + Inhaltsverzeichnis +
 *      geladenes Bild (naturalWidth > 0).
 *   3. ⌘K-Suche → Treffer → Navigation zur Trefferseite.
 *   3b. „f451"-Marke in der Topbar ist ein Home-Link (`href="/wiki"`) — von
 *       einer verschachtelten Seite (Deployment) zurück zur Wiki-Startseite.
 *   4. Abmelden → geschützte Seite → wieder Login-Gate.
 *
 * `describe.serial` mit EINER geteilten Seite: die Flows bauen aufeinander auf
 * (Login-Zustand bleibt über die Tests erhalten).
 */
const SPACE = 'e2e-handbuch'
const DEPLOYMENT_PATH = `/wiki/${SPACE}/deployment`
const SEARCH_TERM = 'Zauberwort'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext()
  page = await context.newPage()
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

test('Flow 2: Seitenbaum → Deployment-Seite mit ToC und Bild', async () => {
  // Über den Seitenbaum (Sidebar) zur Deployment-Seite navigieren.
  await page.locator('nav.tree').getByRole('link', { name: 'Deployment' }).click()
  await page.waitForURL(new RegExp(`${DEPLOYMENT_PATH}$`))

  // Inhalt gerendert.
  await expect(page.getByRole('heading', { name: 'Deployment', level: 1 })).toBeVisible()

  // Inhaltsverzeichnis (rechte Info-Leiste, ab 1160px sichtbar — Viewport 1280).
  const toc = page.locator('.rail').getByRole('heading', { name: 'Inhaltsverzeichnis' })
  await expect(toc).toBeVisible()
  // Sprung-Anker der h2-Überschrift „Architektur" im Inhaltsverzeichnis.
  const tocLink = page.locator('.rail .toc').getByRole('link', { name: 'Architektur' })
  await expect(tocLink).toBeVisible()
  await expect(tocLink).toHaveAttribute('href', /^#/)

  // Bild wirklich geladen (nicht nur im DOM): naturalWidth > 0.
  const img = page.locator('.page-body img').first()
  await expect(img).toBeVisible()
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0)
})

test('Flow 3: ⌘K-Suche → Treffer → Navigation', async () => {
  // Zunächst auf die Startseite, damit die Navigation zur Trefferseite ein
  // echter Sprung ist.
  await page.locator('nav.tree').getByRole('link', { name: 'Handbuch' }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}/home$`))

  // ⌘K / Ctrl+K öffnet den Suchdialog.
  await page.keyboard.press('ControlOrMeta+k')
  const searchInput = page.getByRole('combobox', { name: 'Suchbegriff' })
  await expect(searchInput).toBeVisible()

  // Suchbegriff kommt nur in der Deployment-Seite vor → genau ein Treffer.
  await searchInput.fill(SEARCH_TERM)
  const result = page.getByRole('option', { name: /Deployment/ })
  await expect(result).toBeVisible()

  // Enter öffnet den (aktiven, ersten) Treffer.
  await searchInput.press('Enter')
  await page.waitForURL(new RegExp(`${DEPLOYMENT_PATH}$`))
  await expect(page.getByRole('heading', { name: 'Deployment', level: 1 })).toBeVisible()
})

test('Flow 3b: „f451"-Marke ist ein Home-Link zurück ins Wiki', async () => {
  // Ausgangspunkt: Flow 3 endet auf der Deployment-Seite — einer verschachtelten
  // Route, genau der im Feature-Brief beschriebene Fall („kein Weg zurück zur
  // App", z. B. auch auf /einstellungen/verbindungen). Die `<Shell>` ist auf
  // jeder Seite dieselbe Komponente, die Deployment-Seite prüft sie stellvertretend.
  await expect(page).toHaveURL(new RegExp(`${DEPLOYMENT_PATH}$`))
  const homeLink = page.getByRole('link', { name: 'Zur Startseite' })
  await expect(homeLink).toHaveAttribute('href', '/wiki')
  await homeLink.click()
  await page.waitForURL(/\/wiki$/)
  await expect(page.getByRole('heading', { name: 'Handbuch', level: 1 })).toBeVisible()
})

test('Flow 4: Logout → geschützte Seite → Login-Gate', async () => {
  // Konto-Menü öffnen und abmelden.
  await page.locator('button.avatar').click()
  await page.getByRole('menuitem', { name: /Abmelden/ }).click()

  // Zurück auf der Login-Seite (router.push('/')).
  await page.waitForURL(/\/(\?.*)?$/)

  // Erneuter Zugriff auf eine geschützte Route → wieder das Login-Gate.
  await page.goto('/wiki')
  await expect(page).toHaveURL(/\/\?next=/)
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
})
