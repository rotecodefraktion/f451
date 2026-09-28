import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * Playwright-Konfiguration (Plan Task 6). Ein einziges Chromium-Projekt gegen
 * den lokal per `globalSetup` hochgefahrenen Stack (API + Mock-IdP +
 * Testcontainer + `next dev` auf :3000).
 *
 * Browser: es wird NICHTS neu installiert (Plan Global Constraints). Stattdessen
 * wird die bereits im ms-playwright-Cache liegende Chromium-Binärdatei per
 * `executablePath` direkt verwendet. Playwright 1.55 erwartet zwar Revision
 * 1193, im Cache liegt aber 1223 (arm64) — das Direktverdrahten über
 * `executablePath` umgeht die Revisions-Kopplung. Fällt die Binärdatei weg,
 * greift Playwrights Standardauflösung (dann via `npx playwright install`).
 */
const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(homedir(), 'Library/Caches/ms-playwright')
const CACHED_CHROMIUM = resolve(
  CACHE,
  'chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)
const executablePath = existsSync(CACHED_CHROMIUM) ? CACHED_CHROMIUM : undefined

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/setup/global-setup.ts',
  globalTeardown: './e2e/setup/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    // Test-Browser fragt Deutsch an (setzt sowohl die Emulations-Locale als
    // auch `Accept-Language: de-DE`). Nötig seit Phase 1 der UI-Zweisprachigkeit:
    // `getLocale()` (lib/i18n/server.ts) leitet die Sprache ohne `lang`-Cookie
    // aus `Accept-Language` ab — ohne diese Vorgabe könnte der Browser `en`
    // anfragen und die deutschen E2E-Selektoren (z. B. „Zur Startseite",
    // „Graph-Ansicht", „Space wechseln") würden brechen. Default-Locale der
    // App ist `de`, die Specs erwarten deutschen Text.
    locale: 'de-DE',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } },
    },
  ],
})
