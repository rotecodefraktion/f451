import { test, expect, type Page } from '@playwright/test'

/**
 * Topbar-Space-Wechsler (Feature-Brief „Space-Wechsler"): das statische
 * `.app`-Label neben der „f451"-Marke ist jetzt bei ≥2 konfigurierten Spaces
 * ein Dropdown (`components/space-switcher.tsx`) — dieser Test deckt genau
 * das ab, wofür `lese-ui.spec.ts`/`komfort.spec.ts` keinen zweiten Space
 * hatten. `e2e/setup/start-stack.ts` seedet dafür einen zweiten, minimalen
 * Space `e2e-betrieb` ("Betrieb") NEBEN dem bestehenden `e2e-handbuch`
 * ("Handbuch") — beide öffentlich, kein Collaborator nötig (Lesezugriff
 * hängt an einem einfachen Provider-200, s. Kommentar in `start-stack.ts`).
 *
 * `describe.serial` mit EINER geteilten Seite, Login-Sequenz identisch zu
 * `lese-ui.spec.ts` Flow 1.
 */
const HANDBUCH = { id: 'e2e-handbuch', name: 'Handbuch' }
const BETRIEB = { id: 'e2e-betrieb', name: 'Betrieb' }

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await page.context().close()
})

test('Login landet im ersten Space (Handbuch)', async () => {
  await page.goto('/wiki')
  await expect(page).toHaveURL(/\/\?next=/)
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${HANDBUCH.id}`))
  await expect(page.getByRole('heading', { name: 'Handbuch', level: 1 })).toBeVisible()
})

test('Wechsler zeigt den aktuellen Space und listet beide Spaces auf', async () => {
  const trigger = page.getByRole('button', { name: HANDBUCH.name, exact: true })
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  const menu = page.getByRole('menu', { name: 'Space wechseln' })
  await expect(menu).toBeVisible()

  const handbuchItem = menu.getByRole('menuitem', { name: HANDBUCH.name })
  const betriebItem = menu.getByRole('menuitem', { name: BETRIEB.name })
  await expect(handbuchItem).toBeVisible()
  await expect(betriebItem).toBeVisible()

  // Der aktuelle Space ist markiert (aria-current + Häkchen), der andere nicht.
  await expect(handbuchItem).toHaveAttribute('aria-current', 'page')
  await expect(betriebItem).not.toHaveAttribute('aria-current')

  // Escape schließt das Menü und gibt den Fokus an den Trigger zurück.
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('Klick auf einen anderen Space navigiert dorthin', async () => {
  const trigger = page.getByRole('button', { name: HANDBUCH.name, exact: true })
  await trigger.click()

  const menu = page.getByRole('menu', { name: 'Space wechseln' })
  await menu.getByRole('menuitem', { name: BETRIEB.name }).click()

  await page.waitForURL(new RegExp(`/wiki/${BETRIEB.id}`))
  await expect(page.getByRole('heading', { name: 'Betrieb', level: 1 })).toBeVisible()

  // Der Wechsler zeigt jetzt „Betrieb" als aktuellen Space.
  const newTrigger = page.getByRole('button', { name: BETRIEB.name, exact: true })
  await expect(newTrigger).toBeVisible()
  await newTrigger.click()
  const reopenedMenu = page.getByRole('menu', { name: 'Space wechseln' })
  await expect(reopenedMenu.getByRole('menuitem', { name: BETRIEB.name })).toHaveAttribute('aria-current', 'page')
})

test('Pfeiltasten navigieren zwischen den Menüeinträgen', async () => {
  const trigger = page.getByRole('button', { name: BETRIEB.name, exact: true })
  await trigger.click()

  const menu = page.getByRole('menu', { name: 'Space wechseln' })
  const betriebItem = menu.getByRole('menuitem', { name: BETRIEB.name })
  const handbuchItem = menu.getByRole('menuitem', { name: HANDBUCH.name })

  // Öffnen fokussiert den aktuellen Eintrag (Betrieb), ArrowDown springt zum
  // nächsten (Handbuch, zyklisch).
  await expect(betriebItem).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(handbuchItem).toBeFocused()

  await page.keyboard.press('Enter')
  await page.waitForURL(new RegExp(`/wiki/${HANDBUCH.id}`))
})
