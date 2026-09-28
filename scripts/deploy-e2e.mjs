// ECHTER End-to-End-Test der vollen f451-Wiki-Anwenderreise gegen den bereits
// laufenden, gebauten Docker-Stack (KEIN Stack-Start hier, kein Playwright-
// Test-Runner — der würde seinen eigenen Stack hochfahren). Struktur wie
// `scripts/dev-local-smoke.mjs`: direkter `chromium.launch()`, EIN Context,
// EINE Page. Jeder Reise-Schritt läuft über echte Klicks/Tastatureingaben;
// Server-Belege kommen unabhängig über die Forgejo-REST-API (KEIN
// `page.evaluate(fetch(...))` als Ersatz für einen Reise-Schritt).
//
// Start: node scripts/deploy-e2e.mjs
// (Der Ziel-Stack muss bereits laufen — siehe docs/superpowers/HANDOFF-2026-07-16-deployment-e2e.md)
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const ARTIFACT_DIR = resolve(REPO_ROOT, 'e2e-artifacts')
mkdirSync(ARTIFACT_DIR, { recursive: true })

// --- Konfiguration -----------------------------------------------------
const WEB = process.env.WEB_BASE ?? 'http://localhost:8080'
const FORGEJO_USER = process.env.FORGEJO_USER ?? 'wiki-admin'
const FORGEJO_PASS = process.env.FORGEJO_PASS ?? 'admin1234'
const FORGEJO_BASE = process.env.FORGEJO_BASE ?? 'http://localhost:3300'
const REPO_OWNER = 'dev-docs'
const REPO_NAME = 'betrieb'
const SPACE = 'betrieb'
const PAGE_ID = 'path:betrieb/index.md'
const MARKER = `E2E-Marker ${Date.now()}`

function readForgejoTokenFallback() {
  try {
    const envPath = resolve(REPO_ROOT, 'deploy/wiki/.env')
    const raw = readFileSync(envPath, 'utf8')
    const match = raw.match(/^F451_FORGEJO_TOKEN=(.*)$/m)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}
const FORGEJO_TOKEN = process.env.FORGEJO_TOKEN || readForgejoTokenFallback()

// --- Draft-Branch-Name — 1:1 Nachbau von `apps/api/src/drafts/branch-name.ts`
// (reine Berechnung zur Server-Verifikation, KEINE App-Logik-Änderung). ------
const ALLOWED_CHAR = /[a-z0-9._-]/
function draftBranchName(pageId) {
  let changed = false
  let slug = ''
  for (const ch of pageId) {
    if (ALLOWED_CHAR.test(ch)) slug += ch
    else {
      slug += '-'
      changed = true
    }
  }
  const collapsed = slug.replace(/-{2,}/g, '-')
  if (collapsed !== slug) changed = true
  slug = collapsed
  const trimmed = slug.replace(/^[.-]+/, '').replace(/[.-]+$/, '')
  if (trimmed !== slug) changed = true
  slug = trimmed
  if (slug.length === 0) {
    slug = 'page'
    changed = true
  }
  if (!changed) return `draft/${slug}`
  const hash = createHash('sha256').update(pageId, 'utf8').digest('hex').slice(0, 8)
  return `draft/${slug}-${hash}`
}
const EXPECTED_DRAFT_BRANCH = draftBranchName(PAGE_ID)

// --- Admin-Token (Reindex) — gleiches Fallback-Muster wie FORGEJO_TOKEN oben.
function readEnvValueFallback(varName) {
  try {
    const envPath = resolve(REPO_ROOT, 'deploy/wiki/.env')
    const raw = readFileSync(envPath, 'utf8')
    const match = raw.match(new RegExp(`^${varName}=(.*)$`, 'm'))
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}
const ADMIN_TOKEN = process.env.F451_ADMIN_TOKEN || readEnvValueFallback('F451_ADMIN_TOKEN')
const SEED_INDEX_PATH = resolve(REPO_ROOT, 'scripts/seed/index.md')

// --- Ringpuffer für Konsole/Fehler/Netzwerk -----------------------------
const RING_LIMIT = 200
const consoleLog = []
const pageErrorLog = []
const networkLog = []
function pushRing(arr, entry) {
  arr.push(entry)
  if (arr.length > RING_LIMIT) arr.shift()
}

// --- Schritt-Buchführung -------------------------------------------------
let stepNo = 0
const passedSteps = []

function log(msg) {
  console.log(msg)
}

async function forgejoApi(path, opts = {}) {
  const res = await fetch(`${FORGEJO_BASE}/api/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `token ${FORGEJO_TOKEN}`,
      ...(opts.headers ?? {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, ok: res.ok, body }
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message)
    err.isAssertion = true
    throw err
  }
}

// --- resetState(): deterministischen Ausgangszustand herstellen (KEINE
// Browser-Aktion, reine Forgejo-API + Admin-Reindex). Grund: jeder Lauf
// tippt einen frischen `MARKER` in `.doc.page-body` und merged ihn per
// Review→Release auf `main` — ohne Reset akkumulieren sich die Marker in der
// H1 von index.md über Läufe hinweg (siehe
// docs/superpowers/HANDOFF-2026-07-16-deployment-e2e.md). Läuft VOR Schritt 1
// (Login), damit jeder Lauf — auch nach einem vorherigen Abbruch — von
// exakt demselben Seed-Zustand startet. Idempotent: räumt nur auf, was
// tatsächlich vom Seed abweicht (kein Leer-Commit bei sauberem main).
async function resetState() {
  log('\n[Setup] resetState() — deterministischen Ausgangszustand herstellen …')

  // 1. Alle offenen PRs schließen (Forgejo/Gitea-API: PRs sind Issues).
  const openPulls = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open`)
  assert(openPulls.ok, `Setup: GET /pulls?state=open lieferte Status ${openPulls.status}`)
  const pulls = Array.isArray(openPulls.body) ? openPulls.body : []
  for (const pr of pulls) {
    const closeRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/issues/${pr.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    })
    assert(closeRes.ok, `Setup: PR #${pr.number} schließen lieferte Status ${closeRes.status}`)
    log(`  Setup: PR #${pr.number} ("${pr.title}") geschlossen.`)
  }
  if (pulls.length === 0) log('  Setup: keine offenen PRs.')

  // 2. Alle draft/*-Branches löschen.
  const branchesRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches`)
  assert(branchesRes.ok, `Setup: GET /branches lieferte Status ${branchesRes.status}`)
  const branchNames = Array.isArray(branchesRes.body) ? branchesRes.body.map((b) => b.name) : []
  const draftBranches = branchNames.filter((n) => n.startsWith('draft/'))
  for (const name of draftBranches) {
    const delRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    assert(delRes.ok, `Setup: Branch "${name}" löschen lieferte Status ${delRes.status}`)
    log(`  Setup: Branch "${name}" gelöscht.`)
  }
  if (draftBranches.length === 0) log('  Setup: keine draft/-Branches.')

  // 3. index.md auf main auf den EXAKTEN Seed-Inhalt zurücksetzen — nur bei
  // Abweichung committen (idempotent, kein Leer-Commit bei sauberem main).
  const seedContent = readFileSync(SEED_INDEX_PATH, 'utf8')
  const currentRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.md?ref=main`)
  assert(currentRes.ok, `Setup: GET /contents/index.md?ref=main lieferte Status ${currentRes.status}`)
  const currentContent = Buffer.from(currentRes.body.content, 'base64').toString('utf8')
  if (currentContent === seedContent) {
    log('  Setup: main/index.md entspricht bereits dem Seed — kein Commit nötig.')
  } else {
    const putRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: Buffer.from(seedContent, 'utf8').toString('base64'),
        message: 'test: reset e2e seed',
        branch: 'main',
        sha: currentRes.body.sha,
      }),
    })
    assert(putRes.ok, `Setup: PUT /contents/index.md lieferte Status ${putRes.status}`)
    log('  Setup: main/index.md war gegenüber dem Seed gedriftet — auf Seed-Inhalt zurückgesetzt.')
  }

  // 4. Admin-Reindex, damit die Leseansicht den zurückgesetzten Stand zeigt
  // (NUR als Setup-Fixture erlaubt, nicht Teil der Nutzerreise selbst).
  //
  // NICHT hart erzwungen (kein `assert`) — entdeckt bei der Verankerung dieses
  // Gates: `/admin/*` verlangt in JEDEM Deployment mit aktivem OIDC (so auch
  // hier) zusätzlich zum Bearer-Token eine gültige Session (globaler
  // Session-Hook `apps/api/src/app.ts` Zeile ~421, dediziert abgesichert durch
  // `apps/api/test/admin-session-gate.test.ts` — BY DESIGN, keine Regression).
  // Ein reiner Bearer-Token-Aufruf OHNE Session (wie hier, vor jedem Login)
  // bekommt deshalb reproduzierbar 401 "Anmeldung erforderlich" — nicht lösbar,
  // ohne entweder App-Code zu ändern (verboten) oder den kompletten
  // OIDC-Redirect-Tanz per HTTP nachzubauen (unverhältnismäßig fragil für eine
  // Setup-Fixture). Das blockiert die eigentliche Reise NICHT: Entwürfe lesen
  // laut `apps/api/src/drafts/lifecycle.ts` (`provider.readFile`/`createBranch`)
  // IMMER direkt vom Git-Provider (Forgejo), nie aus dem Postgres-Index — der
  // Reindex dient rein der Frische der LESEANSICHT, die im Skript ohnehin ohne
  // Assertion bleibt (Schritt 3 „ansehen" loggt den Titel nur als Beleg).
  if (!ADMIN_TOKEN) {
    log('  Setup-WARNUNG: F451_ADMIN_TOKEN fehlt (weder env noch deploy/wiki/.env) — Reindex übersprungen.')
  } else {
    const reindexRes = await fetch(`${WEB}/admin/reindex`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (reindexRes.ok) {
      log('  Setup: Admin-Reindex angestoßen.')
    } else {
      const bodyText = await reindexRes.text().catch(() => '')
      log(`  Setup-WARNUNG: POST /admin/reindex lieferte Status ${reindexRes.status} (${bodyText}).`)
      log('  Setup-WARNUNG: erwartet bei 401 — /admin/* verlangt zusätzlich zum Bearer-Token eine Session')
      log('  (by-design, siehe admin-session-gate.test.ts). Kein Blocker für die Reise (Drafts lesen direkt')
      log('  vom Provider, nicht aus dem Index) — daher hier bewusst KEIN harter Abbruch.')
    }
  }

  log('[Setup] resetState() abgeschlossen.\n')
}

async function writeFailArtifacts(page, stepLabel, err) {
  const failScreenshot = resolve(ARTIFACT_DIR, `FAIL-${stepLabel}.png`)
  const domPath = resolve(ARTIFACT_DIR, 'FAIL-dom.html')
  const consolePath = resolve(ARTIFACT_DIR, 'FAIL-console.log')
  const networkPath = resolve(ARTIFACT_DIR, 'FAIL-network.log')

  await page.screenshot({ path: failScreenshot, fullPage: true }).catch((e) => log(`  (Screenshot fehlgeschlagen: ${e.message})`))
  try {
    const html = await page.content()
    writeFileSync(domPath, html, 'utf8')
  } catch (e) {
    log(`  (DOM-Dump fehlgeschlagen: ${e.message})`)
  }
  const consoleText = consoleLog.map((c) => `[${c.type}] ${c.text}`).concat(pageErrorLog.map((p) => `[pageerror] ${p}`)).join('\n')
  writeFileSync(consolePath, consoleText, 'utf8')
  const networkText = networkLog
    .slice(-50)
    .map((r) => `${r.method} ${r.url} -> ${r.status}`)
    .join('\n')
  writeFileSync(networkPath, networkText, 'utf8')

  return { failScreenshot, domPath, consolePath, networkPath }
}

async function step(page, name, fn) {
  stepNo += 1
  const label = `${String(stepNo).padStart(2, '0')}-${name}`
  log(`\n[Schritt ${stepNo}] ${name} …`)
  try {
    const result = await fn()
    const screenshotPath = resolve(ARTIFACT_DIR, `${label}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    passedSteps.push({ no: stepNo, name, result: result ?? null, screenshot: screenshotPath })
    log(`  OK — Screenshot: ${screenshotPath}`)
    return result
  } catch (err) {
    log(`  BRUCH bei Schritt ${stepNo} (${name}): ${err.message}`)
    const artifacts = await writeFailArtifacts(page, label, err)
    log(`  FAIL-Artefakte:`)
    log(`    Screenshot: ${artifacts.failScreenshot}`)
    log(`    DOM:        ${artifacts.domPath}`)
    log(`    Konsole:    ${artifacts.consolePath}`)
    log(`    Netzwerk:   ${artifacts.networkPath}`)
    throw Object.assign(err, { stepNo, stepName: name, artifacts })
  }
}

async function clickOptional(locator, label) {
  if (await locator.count()) {
    log(`    (${label} vorhanden — klicke)`)
    await locator.click()
    return true
  }
  log(`    (${label} nicht vorhanden — übersprungen)`)
  return false
}

// --- Robuste Warte-Hilfen -------------------------------------------------
// Ersatz für „Element sichtbar? → sofort textContent lesen" (Bug im ersten
// Lauf, Schritt 6: `.statusbar .saved` ist immer sichtbar, auch während „Wird
// gespeichert …" — der Text wechselt erst später zum Zielzustand). Statt
// einmalig zu lesen, wird auf den ERWARTETEN Text gepollt, mit endlichem
// Timeout — bleibt der Zielzustand aus, ist das ein echter Bruch (Fehler
// bleibt bestehen, KEIN Auf-Zeit-Abweichen auf einen anderen Text).
async function waitForText(locator, substring, { timeoutMs = 20000, pollMs = 150, label } = {}) {
  const start = Date.now()
  let lastText = ''
  for (;;) {
    if (await locator.count()) {
      lastText = (await locator.first().textContent()) ?? ''
      if (lastText.includes(substring)) return lastText
    }
    if (Date.now() - start >= timeoutMs) break
    await new Promise((r) => setTimeout(r, pollMs))
  }
  const what = label ?? `Text "${substring}"`
  const err = new Error(`${what} — Timeout nach ${timeoutMs}ms (zuletzt gesehen: "${lastText}")`)
  err.isAssertion = true
  throw err
}

// Wie `waitForText`, aber für „einer von mehreren möglichen End-Zuständen"
// (z.B. Release kann `.notice.rel` ODER `.chip.rel` zeigen, je nachdem ob der
// Redirect zur Leseansicht schon stattgefunden hat). Wartet, bis IRGENDEINER
// der Checks seinen Zieltext zeigt — bleibt der Zielzustand komplett aus, ist
// das ein echter Bruch.
async function waitForEitherText(checks, { timeoutMs = 20000, pollMs = 150 } = {}) {
  const start = Date.now()
  const lastSeen = checks.map(() => '')
  for (;;) {
    for (let i = 0; i < checks.length; i += 1) {
      const { locator, substring } = checks[i]
      if (await locator.count()) {
        const text = (await locator.first().textContent()) ?? ''
        lastSeen[i] = text
        if (text.includes(substring)) return { index: i, label: checks[i].label, text }
      }
    }
    if (Date.now() - start >= timeoutMs) break
    await new Promise((r) => setTimeout(r, pollMs))
  }
  const err = new Error(
    `Keiner der erwarteten End-Zustände erreicht — Timeout nach ${timeoutMs}ms (` +
      checks.map((c, i) => `${c.label ?? 'Ziel'}="${lastSeen[i]}"`).join(' / ') +
      ')',
  )
  err.isAssertion = true
  throw err
}

// --- Hauptlauf ------------------------------------------------------------
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

page.on('console', (msg) => pushRing(consoleLog, { type: msg.type(), text: msg.text() }))
page.on('pageerror', (err) => pushRing(pageErrorLog, err.message))
page.on('response', (res) => {
  pushRing(networkLog, { method: res.request().method(), url: res.url(), status: res.status() })
})

let exitCode = 0

try {
  assert(FORGEJO_TOKEN, 'FORGEJO_TOKEN ist leer — weder process.env.FORGEJO_TOKEN noch deploy/wiki/.env#F451_FORGEJO_TOKEN gefunden.')

  // --- Setup: deterministischen Ausgangszustand herstellen (KEIN Reise-Schritt) ---
  await resetState()

  // --- Schritt 1: Login -----------------------------------------------
  await step(page, 'login', async () => {
    log(`  Öffne ${WEB} …`)
    await page.goto(WEB, { waitUntil: 'domcontentloaded' })

    const loginLink = page.locator('a[href*="/auth/login"], a:has-text("Anmelden"), button:has-text("Anmelden")').first()
    if (await loginLink.count()) {
      log('  Klicke „Anmelden" …')
      await loginLink.click()
    } else {
      log('  Kein Login-Link — navigiere direkt zu /auth/login')
      await page.goto(`${WEB}/auth/login`, { waitUntil: 'domcontentloaded' })
    }

    await page.waitForURL(/\/(user\/login|login\/oauth)/, { timeout: 20000 })
    if (/user\/login/.test(page.url())) {
      log('  Forgejo-Login-Formular ausfüllen …')
      await page.fill('input[name="user_name"]', FORGEJO_USER)
      await page.fill('input[name="password"]', FORGEJO_PASS)
      await page.click('button[type="submit"], form button')
    }

    await page.waitForLoadState('domcontentloaded')
    await clickOptional(
      page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first(),
      'OAuth-Authorize (Login)',
    )

    await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 20000 })
    await page.waitForLoadState('networkidle')
    log(`  Zurück in der App: ${page.url()}`)

    const avatar = page.locator('button.avatar').first()
    await avatar.waitFor({ state: 'visible', timeout: 20000 })
    const title = await avatar.getAttribute('title')
    assert(!!title, 'Der Topbar-Avatar-Button hat kein title-Attribut (Nutzername erwartet).')
    log(`  Beleg: Topbar-Avatar mit title="${title}"`)
    return { avatarTitle: title, url: page.url() }
  })

  // --- Schritt 2: Connect-Flow -----------------------------------------
  await step(page, 'connect-forgejo', async () => {
    log('  Navigiere zu /auth/connect/forgejo …')
    await page.goto(`${WEB}/auth/connect/forgejo`, { waitUntil: 'domcontentloaded' })
    await clickOptional(
      page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first(),
      'OAuth-Authorize (Connect)',
    )
    await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 20000 }).catch(() => {})
    await page.waitForLoadState('networkidle')
    log(`  Zurück in der App: ${page.url()}`)
    return { url: page.url() }
  })

  // --- Schritt 3: Ansehen (Leseansicht der Seed-Seite) ------------------
  const pageIdEncoded = encodeURIComponent(PAGE_ID)
  const readUrl = `${WEB}/wiki/${SPACE}/${pageIdEncoded}`
  await step(page, 'ansehen', async () => {
    log(`  Öffne ${readUrl} …`)
    await page.goto(readUrl, { waitUntil: 'networkidle' })
    const heading = page.locator('.page-body h1').first()
    await heading.waitFor({ state: 'visible', timeout: 20000 })
    const text = await heading.textContent()
    log(`  Beleg: .page-body h1 = "${text?.trim()}"`)
    return { heading: text?.trim(), url: page.url() }
  })

  // --- Schritt 4: Bearbeiten ---------------------------------------------
  await step(page, 'bearbeiten', async () => {
    const editLink = page.getByRole('link', { name: 'Bearbeiten' })
    await editLink.waitFor({ state: 'visible', timeout: 20000 })
    log('  Klicke „Bearbeiten" …')
    await editLink.click()

    await page.waitForURL(/\/edit(\?.*)?$/, { timeout: 20000 })
    log(`  Edit-URL erreicht: ${page.url()}`)

    const toolbar = page.locator('.etoolbar')
    await toolbar.waitFor({ state: 'visible', timeout: 20000 })
    log('  Beleg DOM: .etoolbar sichtbar')

    // Lade-Platzhalter (`.editor-root[aria-busy="true"]`, „Entwurf wird
    // geladen …") muss verschwinden, BEVOR die Tippfläche als bereit gilt.
    await page.locator('.editor-root[aria-busy="true"]').waitFor({ state: 'detached', timeout: 20000 }).catch(async () => {
      // Falls es nie sichtbar war (Race — Ladephase war schon vorbei), reicht
      // die direkte Sichtbarkeitsprüfung der Tippfläche unten.
    })

    const doc = page.locator('.doc.page-body')
    await doc.waitFor({ state: 'visible', timeout: 20000 })
    const isEditable = await doc.evaluate((el) => el.getAttribute('contenteditable') === 'true' || el.isContentEditable)
    assert(isEditable, '.doc.page-body ist nicht editierbar (contenteditable fehlt).')
    log('  Beleg DOM: .doc.page-body sichtbar und editierbar')

    // Server-Beleg: ein Draft-Branch, der zur pageId gehört, muss auf Forgejo existieren.
    const branchesRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches`)
    assert(branchesRes.ok, `Forgejo GET /branches lieferte Status ${branchesRes.status}`)
    const branchNames = Array.isArray(branchesRes.body) ? branchesRes.body.map((b) => b.name) : []
    const draftBranch = branchNames.find((n) => n === EXPECTED_DRAFT_BRANCH) ?? branchNames.find((n) => n.startsWith('draft/'))
    assert(!!draftBranch, `Kein draft/-Branch auf Forgejo gefunden (erwartet "${EXPECTED_DRAFT_BRANCH}"). Vorhandene Branches: ${branchNames.join(', ')}`)
    log(`  Beleg SERVER: Forgejo-Branch "${draftBranch}" existiert`)

    return { url: page.url(), draftBranch }
  })

  // --- Schritt 5: Tippen ---------------------------------------------
  await step(page, 'tippen', async () => {
    const doc = page.locator('.doc.page-body')
    await doc.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type(MARKER)
    await doc.locator(`text=${MARKER}`).first().waitFor({ state: 'visible', timeout: 10000 })
    const domText = await doc.textContent()
    assert(domText?.includes(MARKER), `Marker "${MARKER}" nicht im .doc.page-body-DOM gefunden.`)
    log(`  Beleg DOM: Marker "${MARKER}" im .doc.page-body`)
    return { marker: MARKER }
  })

  // --- Schritt 6: Autosave ---------------------------------------------
  await step(page, 'autosave', async () => {
    await page.keyboard.press('ControlOrMeta+s')
    const saved = page.locator('.statusbar .saved')
    // NICHT auf bloße Sichtbarkeit warten und dann sofort lesen — der
    // Container ist auch während „Wird gespeichert …" sichtbar. Auf den
    // tatsächlichen Ziel-TEXT warten (der Save-Request kann mehrere Sekunden
    // brauchen, bis er rausgeht und der Client den Erfolg zurückbekommt).
    const text = await waitForText(saved, 'Zuletzt gespeichert', {
      timeoutMs: 20000,
      label: 'Statuszeile zeigt nicht „Zuletzt gespeichert"',
    })
    log(`  Beleg DOM: .statusbar .saved = "${text.trim()}"`)

    const branchesRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches`)
    assert(branchesRes.ok, `Forgejo GET /branches lieferte Status ${branchesRes.status}`)
    const branchNames = Array.isArray(branchesRes.body) ? branchesRes.body.map((b) => b.name) : []
    const draftBranch = branchNames.find((n) => n === EXPECTED_DRAFT_BRANCH) ?? branchNames.find((n) => n.startsWith('draft/'))
    assert(!!draftBranch, `Kein draft/-Branch auf Forgejo gefunden für Autosave-Beleg.`)

    const commitsRes = await forgejoApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/commits?sha=${encodeURIComponent(draftBranch)}&limit=1`,
    )
    assert(commitsRes.ok, `Forgejo GET /commits?sha=${draftBranch} lieferte Status ${commitsRes.status}`)
    const commitSha = Array.isArray(commitsRes.body) ? commitsRes.body[0]?.sha : undefined
    assert(!!commitSha, `Kein Commit auf Branch ${draftBranch} gefunden.`)

    const contentsRes = await forgejoApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.md?ref=${encodeURIComponent(draftBranch)}`,
    )
    assert(contentsRes.ok, `Forgejo GET /contents/index.md?ref=${draftBranch} lieferte Status ${contentsRes.status}`)
    const decoded = Buffer.from(contentsRes.body.content, 'base64').toString('utf8')
    assert(decoded.includes(MARKER), `Marker "${MARKER}" NICHT im committeten Inhalt auf ${draftBranch} (Commit ${commitSha}).`)
    log(`  Beleg SERVER: Branch "${draftBranch}", Commit ${commitSha}, Inhalt enthält Marker`)

    return { draftBranch, commitSha }
  })

  // --- Schritt 7: Moduswechsel ---------------------------------------------
  // Der Normalisierungs-Dialog (`mode-switch.tsx#ModeSwitch`, „Formatierung
  // wird beim Wechsel normalisiert") kann laut Docblock bei JEDEM Roh→WYSIWYG-
  // Wechsel erscheinen, sobald Normalisierungs-Befunde vorliegen — NICHT nur
  // beim ersten Wechsel. Das Original-Skript prüfte ihn nur nach dem
  // Markdown-Klick, nicht nach dem WYSIWYG-Rückwechsel; per Screenshot-Beleg
  // (FAIL-07-moduswechsel.png, erster robuster Lauf) erscheint er GENAU dort
  // und blieb unbestätigt stehen → `.doc.page-body` erschien nie, reines
  // Skript-Lücke (keine App-Änderung, nur dieselbe bereits vorhandene
  // Bestätigungs-Behandlung jetzt an beiden Wechsel-Richtungen).
  async function dismissNormalizeDialogIfPresent(where) {
    const normalizeDialog = page.getByRole('dialog', { name: 'Formatierung normalisieren?' })
    if (await normalizeDialog.isVisible({ timeout: 1500 }).catch(() => false)) {
      log(`  Normalisierungs-Dialog erschienen (${where}) — bestätige …`)
      await page.getByRole('button', { name: 'Normalisieren und wechseln' }).click()
      await normalizeDialog.waitFor({ state: 'hidden', timeout: 5000 })
    }
  }

  await step(page, 'moduswechsel', async () => {
    // Der Editor-Umschalter ist seit Teilschritt G des Bausteinsystem-Umbaus
    // eine segmentierte Auswahl: gewöhnliche Schaltflächen mit `aria-pressed`
    // statt `role="tab"`/`aria-selected`.
    await page.getByRole('button', { name: 'Markdown' }).click()
    await dismissNormalizeDialogIfPresent('WYSIWYG→Markdown')
    const rawContent = page.locator('.raw-editor .cm-content')
    await waitForText(rawContent, MARKER, {
      timeoutMs: 20000,
      label: 'Marker nicht im Roh-Editor (.raw-editor .cm-content) gefunden',
    })
    log('  Beleg: .raw-editor .cm-content enthält Marker')

    await page.getByRole('button', { name: 'WYSIWYG' }).click()
    await dismissNormalizeDialogIfPresent('Markdown→WYSIWYG')
    const doc = page.locator('.doc.page-body')
    await waitForText(doc, MARKER, {
      timeoutMs: 20000,
      label: 'Marker nach Rückwechsel zu WYSIWYG nicht mehr im .doc.page-body',
    })
    log('  Beleg: Marker nach Rückwechsel weiterhin im .doc.page-body')
    return {}
  })

  // --- Schritt 8: Review anfordern ---------------------------------------------
  await step(page, 'review-anfordern', async () => {
    await page.getByRole('button', { name: 'Review anfordern' }).click()
    await page.waitForURL(/\/review(\?.*)?$/, { timeout: 20000 })
    const chip = page.locator('.chip.rev')
    const chipText = await waitForText(chip, 'In Review', {
      timeoutMs: 20000,
      label: '.chip.rev zeigt nicht „In Review"',
    })
    log(`  Beleg DOM: .chip.rev = "${chipText.trim()}"`)

    const pullsRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open`)
    assert(pullsRes.ok, `Forgejo GET /pulls?state=open lieferte Status ${pullsRes.status}`)
    const pulls = Array.isArray(pullsRes.body) ? pullsRes.body : []
    assert(pulls.length > 0, 'Kein offener PR auf Forgejo gefunden.')
    const pr = pulls[0]
    log(`  Beleg SERVER: offener PR #${pr.number} "${pr.title}" (${pr.head?.ref} → ${pr.base?.ref})`)
    return { prNumber: pr.number, url: page.url() }
  })

  // --- Schritt 9: Review-Diff ---------------------------------------------
  await step(page, 'review-diff', async () => {
    const dchange = page.locator('.dchange').filter({ hasText: MARKER })
    await dchange.first().waitFor({ state: 'visible', timeout: 20000 })
    log('  Beleg DOM: .dchange enthält den Marker')
    const rsum = page.locator('.rsum')
    await rsum.waitFor({ state: 'visible', timeout: 10000 })
    const rsumText = await rsum.textContent()
    log(`  Beleg DOM: .rsum = "${rsumText?.trim()}"`)
    return {}
  })

  // --- Schritt 10: Release ---------------------------------------------
  await step(page, 'release', async () => {
    // Konflikt-Vorabprüfung (Brief: falls „Entwurf aktualisieren" nötig ist).
    const conflictNotice = page.locator('.notice.conflict')
    if (await conflictNotice.isVisible({ timeout: 1500 }).catch(() => false)) {
      log('  .notice.conflict sichtbar — löse über „Entwurf aktualisieren" / „Meine Fassung behalten" …')
      await page.getByRole('button', { name: 'Entwurf aktualisieren' }).click()
      const updateDialog = page.getByRole('dialog', { name: 'Entwurf aktualisieren' })
      await updateDialog.waitFor({ state: 'visible', timeout: 10000 })
      await updateDialog.getByRole('button', { name: 'Meine Fassung behalten' }).click()
      await conflictNotice.waitFor({ state: 'hidden', timeout: 20000 })
    }

    await page.getByRole('button', { name: 'Freigeben & mergen' }).click()

    // Zwei mögliche End-Zustände, je nachdem ob der Client bereits zur
    // Leseansicht weitergeleitet + neu gerendert hat: entweder die
    // Erfolgsmeldung auf der Review-Seite (`.notice.rel`, Text „Freigegeben …")
    // oder — nach dem Redirect — der Status-Chip der Leseansicht
    // (`.chip.rel`, Text „Released"). Auf den jeweiligen ZIELTEXT warten,
    // nicht nur auf Sichtbarkeit des Containers (Muster Schritt 6).
    const relNotice = page.locator('.notice.rel')
    const relChip = page.locator('.chip.rel')
    const outcome = await waitForEitherText(
      [
        { locator: relNotice, substring: 'Freigegeben', label: '.notice.rel' },
        { locator: relChip, substring: 'Released', label: '.chip.rel' },
      ],
      { timeoutMs: 20000 },
    )
    log(`  Beleg DOM: ${outcome.label} = "${outcome.text.trim()}"`)
    return { url: page.url() }
  })

  // --- Schritt 11: Merge sichtbar ---------------------------------------------
  await step(page, 'merge-sichtbar', async () => {
    await page.goto(readUrl, { waitUntil: 'networkidle' })
    const body = page.locator('.page-body')
    await waitForText(body, MARKER, {
      timeoutMs: 20000,
      label: 'Marker nicht in der Leseansicht (.page-body) nach Reload',
    })
    log('  Beleg DOM: Marker in der Leseansicht sichtbar')

    const commitsRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/commits?sha=main&limit=1`)
    assert(commitsRes.ok, `Forgejo GET /commits?sha=main lieferte Status ${commitsRes.status}`)
    const commitSha = Array.isArray(commitsRes.body) ? commitsRes.body[0]?.sha : undefined
    assert(!!commitSha, 'Kein Commit auf main gefunden.')

    const contentsRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.md?ref=main`)
    assert(contentsRes.ok, `Forgejo GET /contents/index.md?ref=main lieferte Status ${contentsRes.status}`)
    const decoded = Buffer.from(contentsRes.body.content, 'base64').toString('utf8')
    assert(decoded.includes(MARKER), `Marker NICHT im main-Inhalt (Commit ${commitSha}).`)
    log(`  Beleg SERVER: main-Commit ${commitSha} enthält Marker`)

    const pullsRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=closed`)
    const pulls = Array.isArray(pullsRes.body) ? pullsRes.body : []
    const merged = pulls.find((p) => p.merged)
    if (merged) log(`  Beleg SERVER: PR #${merged.number} ist merged=true`)

    return { commitSha }
  })

  log('\n=== ALLE SCHRITTE BESTANDEN ===')
} catch (err) {
  exitCode = 1
  log(`\n=== ABBRUCH bei Schritt ${err.stepNo ?? '?'} (${err.stepName ?? '?'}) ===`)
  log(`Fehler: ${err.message}`)
} finally {
  log('\n--- Zusammenfassung ---')
  for (const s of passedSteps) {
    log(`  [${s.no}] ${s.name}: OK`)
  }

  // Optionaler Teardown: räumt den Marker DIESES Laufs bereits jetzt weg
  // (best effort — der Setup-Aufruf des NÄCHSTEN Laufs würde denselben Zweck
  // ohnehin erfüllen; ein Teardown-Fehler soll das Ergebnis der eigentlichen
  // Reise NICHT verfälschen, daher isoliert und ohne exitCode-Einfluss).
  try {
    log('\n[Teardown] resetState() erneut, damit main sauber bleibt …')
    await resetState()
  } catch (teardownErr) {
    log(`  Teardown-WARNUNG: resetState() nach dem Lauf fehlgeschlagen: ${teardownErr.message}`)
    log('  (Kein Einfluss auf den Exit-Code — der NÄCHSTE Laufs Setup räumt spätestens dann auf.)')
  }

  await browser.close()
  process.exitCode = exitCode
}
