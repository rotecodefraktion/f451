// Reproduzierbarer lokaler Login-Smoke: fährt einen echten Browser durch den
// Forgejo-OIDC-Login und prüft, dass der Demo-Space lesbar ist. Kein Entra.
// Start: node scripts/dev-local-smoke.mjs   (Stack muss laufen, siehe dev-local-setup.sh)
import { chromium } from 'playwright'

const WEB = process.env.WEB_BASE ?? 'http://localhost:3000'
const USER = process.env.FORGEJO_USER ?? 'wiki-admin'
const PASS = process.env.FORGEJO_PASS ?? 'admin1234'
const OUT = process.env.SMOKE_SCREENSHOT ?? '/tmp/f451-login-smoke.png'

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
const log = (m) => console.log(`  ${m}`)

try {
  log(`Öffne ${WEB} …`)
  await page.goto(WEB, { waitUntil: 'domcontentloaded' })

  // Auf der App-Startseite den Anmelde-Einstieg finden und folgen.
  const loginLink = page.locator('a[href*="/auth/login"], a:has-text("Anmelden"), button:has-text("Anmelden")').first()
  if (await loginLink.count()) {
    log('Klicke „Anmelden" …')
    await loginLink.click()
  } else {
    log('Kein Login-Link — navigiere direkt zu /auth/login')
    await page.goto(`${WEB}/auth/login`, { waitUntil: 'domcontentloaded' })
  }

  // Forgejo-Login-Formular.
  await page.waitForURL(/\/(user\/login|login\/oauth)/, { timeout: 15000 })
  if (/user\/login/.test(page.url())) {
    log('Forgejo-Login-Formular ausfüllen …')
    await page.fill('input[name="user_name"]', USER)
    await page.fill('input[name="password"]', PASS)
    await page.click('button[type="submit"], form button')
  }

  // Ggf. OAuth-Autorisierungsseite („Authorize Application") bestätigen.
  await page.waitForLoadState('domcontentloaded')
  const authorizeBtn = page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first()
  if (await authorizeBtn.count()) {
    log('OAuth-Autorisierung bestätigen …')
    await authorizeBtn.click()
  }

  // Zurück in der App.
  await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 15000 })
  await page.waitForLoadState('networkidle')
  log(`Zurück in der App: ${page.url()}`)

  // Beweis 1: Session aktiv — /api/me liefert den eingeloggten Nutzer.
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/me')
    return { status: r.status, body: r.ok ? await r.json() : null }
  })
  log(`/api/me → ${me.status}  ${me.body ? JSON.stringify({ id: me.body.id, email: me.body.email }) : ''}`)

  // „Forgejo verbinden" (zweiter OAuth-Flow) — nötig, damit der Nutzer den
  // Space lesen darf (Rechte werden vom echten Repo-Zugriff geerbt, Spec §7).
  log('Verbinde Forgejo-Konto (Connect-Flow) …')
  await page.goto(`${WEB}/auth/connect/forgejo`, { waitUntil: 'domcontentloaded' })
  const grant2 = page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first()
  if (await grant2.count()) await grant2.click()
  await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 15000 }).catch(() => {})
  await page.waitForLoadState('networkidle')

  // Index füllen (Session-Cookie + Admin-Bearer-Token).
  const adminToken = process.env.F451_ADMIN_TOKEN ?? ''
  if (adminToken) {
    const reindex = await page.evaluate(async (tok) => {
      const r = await fetch('/admin/reindex', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      })
      return { status: r.status, body: r.ok ? await r.json() : await r.text() }
    }, adminToken)
    log(`/admin/reindex → ${reindex.status}  ${JSON.stringify(reindex.body).slice(0, 200)}`)
  }

  // Beweis 2: der Demo-Space ist jetzt sichtbar.
  const spaces = await page.evaluate(async () => {
    const r = await fetch('/api/spaces')
    return { status: r.status, body: r.ok ? await r.json() : null }
  })
  log(`/api/spaces → ${spaces.status}  ${JSON.stringify(spaces.body)}`)

  // Beweis 3: eine gerenderte Seite des Seeds öffnen.
  await page.goto(`${WEB}/wiki/betrieb`, { waitUntil: 'networkidle' }).catch(() => {})
  const heading = await page.locator('h1, .page-body h1').first().textContent().catch(() => null)
  log(`Startseite /wiki/betrieb — Überschrift: ${heading ?? '(nicht gefunden)'}`)

  await page.screenshot({ path: OUT, fullPage: true })
  log(`Screenshot: ${OUT}`)

  const spaceVisible = spaces.status === 200 && Array.isArray(spaces.body) && spaces.body.length > 0
  const ok = me.status === 200 && spaceVisible
  console.log(ok ? '\n✓ SMOKE BESTANDEN (Login + Space sichtbar)' : '\n✗ Smoke unvollständig')
  process.exitCode = ok ? 0 : 1
} catch (err) {
  console.error('Smoke-Fehler:', err.message)
  await page.screenshot({ path: OUT, fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
