// Discovery-E2E: klickt aus Anwendersicht durch die GESAMTE f451-Wiki (Seed-Space
// „betrieb") gegen den bereits laufenden, gebauten Docker-Stack. Anders als
// `scripts/deploy-e2e.mjs` (EIN linearer Happy-Path, fail-fast) läuft hier JEDER
// Prüfbereich in einem eigenen try/catch — ein Bruch wird als Befund gesammelt,
// der Lauf geht mit dem NÄCHSTEN Bereich weiter (Ziel: ALLE Brüche in einem Lauf
// finden, nicht nur den ersten).
//
// Echte Anwenderaktionen (Klicks/Tastatur) für jeden Reise-Schritt — KEIN
// `page.evaluate(fetch(...))` als Ersatz. Server-Belege (Forgejo-REST) sind nur
// für Setup/Teardown erlaubt, nicht als Ersatz für einen UI-Schritt.
//
// „Seite lädt / kein 404": NIE `body.textContent()` prüfen (Next.js bettet den
// String „404: This page could not be found." unsichtbar in einem <script>-RSC-
// Payload auf JEDER Seite ein). Stattdessen: (a) die Navigations-Response
// (resourceType==='document') aus dem Response-Ringpuffer hat Status ≠ 404, UND
// (b) ein sichtbares Kernelement ist da (`.page-body h1` mit nicht-leerem Text).
//
// Start: node scripts/discovery-e2e.mjs
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const ARTIFACT_DIR = resolve(REPO_ROOT, 'e2e-artifacts/discovery')
mkdirSync(ARTIFACT_DIR, { recursive: true })

// --- Konfiguration (Muster deploy-e2e.mjs) --------------------------------
const WEB = process.env.WEB_BASE ?? 'http://localhost:8080'
const FORGEJO_USER = process.env.FORGEJO_USER ?? 'wiki-admin'
const FORGEJO_PASS = process.env.FORGEJO_PASS ?? 'admin1234'
const FORGEJO_BASE = process.env.FORGEJO_BASE ?? 'http://localhost:3300'
const REPO_OWNER = 'dev-docs'
const REPO_NAME = 'betrieb'
const SPACE = 'betrieb'

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

// PageIds: Fallback-Formel `path:${spaceId}/${filePath}` (siehe
// apps/api/src/indexer/index-space.ts:94 — Seed-Seiten haben keine
// Frontmatter-`id`). Verifiziert per Forgejo-Contents-API gegen den echten
// Repo-Baum (dev-docs/betrieb): Wurzel `index.md` liegt DIREKT im Repo-Root
// (nicht unter einem eigenen `index/`-Ordner) — NICHT 1:1 der im Auftrag
// genannte URL-Platzhalter `{index,onboarding,richtlinien}/index.md`, der für
// „index" fälschlich eine verschachtelte `index/index.md` unterstellen würde.
// `path:betrieb/index.md` ist außerdem exakt das PAGE_ID-Muster aus
// `deploy-e2e.mjs`.
const PAGES = [
  { id: 'index', pageId: 'path:betrieb/index.md', heading: 'Betriebshandbuch' },
  { id: 'onboarding', pageId: 'path:betrieb/onboarding/index.md', heading: 'Onboarding' },
  { id: 'richtlinien', pageId: 'path:betrieb/richtlinien/index.md', heading: 'Richtlinien' },
]
function readUrl(pageId) {
  return `${WEB}/wiki/${SPACE}/${encodeURIComponent(pageId)}`
}

async function forgejoApi(path, opts = {}) {
  const res = await fetch(`${FORGEJO_BASE}/api/v1${path}`, {
    ...opts,
    headers: { Authorization: `token ${FORGEJO_TOKEN}`, ...(opts.headers ?? {}) },
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

function log(msg) {
  console.log(msg)
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message)
    err.isAssertion = true
    throw err
  }
}

// --- Forgejo-Aufräumen (Setup VOR Bereich 1 + Teardown NACH Bereich 24) ----
// Rein lesend/aufräumend: offene PRs schließen, draft/*-Branches löschen.
// KEIN Merge, KEIN Logout, KEIN Verbindung-Trennen, KEINE Änderung an main.
async function cleanupForgejoState(label) {
  log(`\n[${label}] Forgejo-Zustand aufräumen …`)
  const openPulls = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open`)
  if (openPulls.ok && Array.isArray(openPulls.body)) {
    for (const pr of openPulls.body) {
      const closeRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/issues/${pr.number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      })
      log(`  PR #${pr.number} ("${pr.title}") geschlossen: ${closeRes.ok ? 'OK' : `Status ${closeRes.status}`}`)
    }
    if (openPulls.body.length === 0) log('  keine offenen PRs.')
  } else {
    log(`  WARNUNG: GET /pulls?state=open lieferte Status ${openPulls.status} — PR-Aufräumen übersprungen.`)
  }

  const branchesRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches`)
  if (branchesRes.ok && Array.isArray(branchesRes.body)) {
    const draftBranches = branchesRes.body.map((b) => b.name).filter((n) => n.startsWith('draft/'))
    for (const name of draftBranches) {
      const delRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      log(`  Branch "${name}" gelöscht: ${delRes.ok ? 'OK' : `Status ${delRes.status}`}`)
    }
    if (draftBranches.length === 0) log('  keine draft/-Branches.')
  } else {
    log(`  WARNUNG: GET /branches lieferte Status ${branchesRes.status} — Branch-Aufräumen übersprungen.`)
  }
  log(`[${label}] fertig.\n`)
}

// --- Ringpuffer für Konsole/Fehler/Netzwerk (über den GESAMTEN Lauf) -------
const RING_LIMIT = 500
const consoleLog = []
const pageErrorLog = []
const responseRing = []
function pushRing(arr, entry) {
  arr.push(entry)
  if (arr.length > RING_LIMIT) arr.shift()
}

/** Letzte Navigations-Response (resourceType==='document') aus dem Ringpuffer —
 *  robuster Ersatz für `body.textContent()`-404-Prüfungen (s. Kopfkommentar). */
function lastDocumentResponse() {
  for (let i = responseRing.length - 1; i >= 0; i -= 1) {
    if (responseRing[i].resourceType === 'document') return responseRing[i]
  }
  return null
}

async function assertDocOkAndHeading(page, { expectHeading } = {}) {
  const doc = lastDocumentResponse()
  assert(doc, 'Kein Dokument-Response im Ringpuffer gefunden.')
  assert(doc.status !== 404, `Navigations-Response ${doc.url} lieferte 404.`)
  const heading = page.locator('.page-body h1').first()
  await heading.waitFor({ state: 'visible', timeout: 20000 })
  const text = (await heading.textContent())?.trim() ?? ''
  assert(text.length > 0, '.page-body h1 ist sichtbar, aber leer.')
  if (expectHeading) assert(text === expectHeading, `.page-body h1 = "${text}", erwartet "${expectHeading}"`)
  return { docStatus: doc.status, docUrl: doc.url, heading: text }
}

// --- Befund-Buchführung (continue-on-error) --------------------------------
let areaNo = 0
const findings = []

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function writeFailArtifacts(page, label) {
  const failScreenshot = resolve(ARTIFACT_DIR, `FAIL-${label}.png`)
  const domPath = resolve(ARTIFACT_DIR, `FAIL-${label}-dom.html`)
  const consolePath = resolve(ARTIFACT_DIR, `FAIL-${label}-console.log`)
  const networkPath = resolve(ARTIFACT_DIR, `FAIL-${label}-network.log`)

  await page.screenshot({ path: failScreenshot, fullPage: true }).catch((e) => log(`    (Screenshot fehlgeschlagen: ${e.message})`))
  try {
    writeFileSync(domPath, await page.content(), 'utf8')
  } catch (e) {
    log(`    (DOM-Dump fehlgeschlagen: ${e.message})`)
  }
  const consoleText = consoleLog
    .slice(-60)
    .map((c) => `[${c.type}] ${c.text}`)
    .concat(pageErrorLog.slice(-20).map((p) => `[pageerror] ${p}`))
    .join('\n')
  writeFileSync(consolePath, consoleText, 'utf8')
  const networkText = responseRing
    .slice(-60)
    .map((r) => `${r.method} ${r.url} -> ${r.status} (${r.resourceType})`)
    .join('\n')
  writeFileSync(networkPath, networkText, 'utf8')

  return {
    screenshot: failScreenshot,
    dom: domPath,
    console: consolePath,
    network: networkPath,
    consoleExcerpt: consoleText.split('\n').slice(-8).join('\n'),
    networkExcerpt: networkText.split('\n').slice(-8).join('\n'),
  }
}

/** Ein Prüfbereich — läuft IMMER durch (continue-on-error): ein Fehler wird
 *  als Befund gesammelt, der Lauf macht mit dem nächsten Bereich weiter. */
async function area(page, name, fn) {
  areaNo += 1
  const no = areaNo
  const label = `${String(no).padStart(2, '0')}-${slugify(name)}`
  log(`\n[Bereich ${no}] ${name} …`)
  try {
    const evidence = await fn()
    const screenshotPath = resolve(ARTIFACT_DIR, `${label}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    findings.push({ no, name, status: 'OK', evidence: evidence ?? {}, screenshot: screenshotPath })
    log(`  OK — ${JSON.stringify(evidence ?? {}).slice(0, 200)}`)
  } catch (err) {
    log(`  BRUCH: ${err.message}`)
    const artifacts = await writeFailArtifacts(page, label)
    findings.push({ no, name, status: 'FAIL', error: err.message, ...artifacts })
    log(`  Artefakte: ${artifacts.screenshot}`)
  }
}

async function clickOptional(locator) {
  if (await locator.count()) {
    await locator.click()
    return true
  }
  return false
}

async function waitForText(locator, substring, { timeoutMs = 20000, pollMs = 150 } = {}) {
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
  const err = new Error(`Text "${substring}" nicht erreicht — zuletzt gesehen: "${lastText}"`)
  err.isAssertion = true
  throw err
}

/** Wartet auf EINEN von mehreren möglichen End-Zuständen (z. B. Erfolg ODER
 *  eine erwartete Fehlermeldung) — Muster 1:1 aus `scripts/deploy-e2e.mjs`
 *  (dort bereits für den Freigabe-Schritt genutzt). Nötig für Bereich 22
 *  (Review „Änderungen anfragen"): der Ausgang ist vertraglich zweigleisig
 *  (Erfolg ODER dokumentiertes 409/422, s. `client-api.ts#requestChanges`) —
 *  ein einzelnes `waitForText` könnte nur EINEN der beiden Fälle prüfen. */
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

// Eigene, dedizierte Wegwerf-Ankerzeile — EINMALIG direkt nach dem Öffnen des
// Editors angelegt (`createStableAnchor`, über die H1: einzige zu diesem
// Zeitpunkt GARANTIERT einzeilige Textzeile) und danach NIE wieder verändert
// (wir fügen nur DAVOR ein). Lektion aus dem Abschlussbericht: der ORIGINALE
// "Willkommen …"-Absatz umbricht auf ZWEI sichtbare Zeilen — ein Klick auf ihn
// UND ein nachfolgendes `Home` treffen dadurch je nach Klickposition
// unzuverlässig die zweite statt die erste Zeile (Home springt nur zum
// Zeilenanfang, nicht zum Absatzanfang). Eine EIGENE, kurze, garantiert
// einzeilige Zeile umgeht dieses Problem strukturell, statt es Klick-für-Klick
// zu erraten.
const ANCHOR_TEXT = 'E2E-STABLE-ANCHOR'

/** Legt die dedizierte Ankerzeile EINMALIG an (über die H1 — zu diesem frühen
 *  Zeitpunkt, direkt nach dem Editor-Öffnen, ist noch nichts akkumuliert). */
/** Klickt so nah wie möglich am RECHTEN Rand der tatsächlichen Text-Bounding-Box
 *  des Elements (vertikal mittig) — verlässlicher als Home/Shift+End/ArrowRight
 *  fürs Landen am Zeilenende: ein Klick JENSEITS des letzten Zeichens einer
 *  Zeile schnappt in jedem contenteditable-Bereich zuverlässig an dessen Ende
 *  (native Browser-Eigenschaft), unabhängig von etwaigen Race-Bedingungen bei
 *  nachfolgenden Tastatur-Navigationsbefehlen. Lektion aus dem Abschlussbericht:
 *  ein `click()` (Mittelpunkt) + `Home`→`Shift+End`→`ArrowRight` erwies sich als
 *  UNZUVERLÄSSIG (landete beim genau selben Code teils am Zeilenanfang statt
 *  -ende, ohne erkennbares Muster) — der komplette „silent revert"-Verdacht im
 *  ersten Untersuchungsdurchgang war in Wahrheit nur die KORREKTE Aufräum-Folge
 *  (Ctrl+Z) nach 3 erschöpften Versuchen dieses unzuverlässigen Musters, KEIN
 *  App-Bug (per Reproduktionsskript verifiziert, s. Abschlussbericht). */
async function clickLineEnd(locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('clickLineEnd: keine boundingBox verfügbar.')
  await locator.click({ position: { x: Math.max(1, box.width - 1), y: box.height / 2 } })
}

async function createStableAnchor(page, doc) {
  const h1 = doc.locator('h1').first()
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickLineEnd(h1)
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.keyboard.type(ANCHOR_TEXT)
    const ok = await doc
      .locator('h1 + p', { hasText: ANCHOR_TEXT })
      .first()
      .waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true)
      .catch(() => false)
    if (ok) return
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(150)
  }
  const err = new Error(`createStableAnchor: "h1 + p" mit "${ANCHOR_TEXT}" nach 3 Versuchen nicht erreicht.`)
  err.isAssertion = true
  throw err
}

/** Stabiler Einfüge-Anker im Editor: tippt IMMER an den ANFANG der dedizierten
 *  einzeiligen Ankerzeile (Home → tippen → Enter spaltet DANACH ab) — diese
 *  Zeile selbst wird nie verändert/konsumiert (wir fügen nur DAVOR ein), bleibt
 *  also unabhängig davon auffindbar, was sich sonst im Dokument ansammelt
 *  (Alerts/Tabellen/Codeblöcke). Verifiziert + wiederholt bei Bedarf (bis zu 3
 *  Versuche). */
async function insertAfterAnchor(page, doc, typeText) {
  const anchor = doc.locator('p', { hasText: ANCHOR_TEXT }).first()
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Klick am LINKEN Rand statt Mittelpunkt+Home — dieselbe Zuverlässigkeits-
    // Lektion wie `clickLineEnd` (s. dort), hier fürs Zeilen-ANFANG-Landen.
    const box = await anchor.boundingBox()
    await anchor.click(box ? { position: { x: 1, y: box.height / 2 } } : undefined)
    await page.waitForTimeout(200)
    // WICHTIGE LEKTION: Enter MUSS VOR dem Tippen kommen, nicht danach — `/`
    // und `[[` öffnen sofort ein Popup (Slash-Menü/Wikilink-Autocomplete); ein
    // NACHFOLGENDES Enter wählte dort den hervorgehobenen ERSTEN Eintrag aus
    // (z. B. „Überschrift 1"), statt den Absatz zu splitten — das erklärte
    // sämtliche Bereich-12/13/15/16-Ausfälle im Untersuchungsdurchgang, KEIN
    // App-Bug. Reihenfolge jetzt: splitten (Enter am Zeilenanfang) → EINE
    // Zeile nach oben in den frischen leeren Absatz → dort tippen.
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowUp')
    if (typeText) await page.keyboard.type(typeText)
    if (!typeText) return
    // Nach dem Split muss GENAU EIN neuer Absatz mit `typeText` existieren,
    // UND die Ankerzeile muss unverändert (weiterhin) da sein — sonst war der
    // Cursor beim Tippen woanders (z. B. weiterhin nur in der Ankerzeile selbst).
    const created = doc.locator('p', { hasText: typeText }).filter({ hasNotText: ANCHOR_TEXT })
    const anchorStillIntact = doc.locator('p', { hasText: ANCHOR_TEXT })
    const ok = await created
      .first()
      .waitFor({ state: 'visible', timeout: 2000 })
      .then(() => anchorStillIntact.first().isVisible())
      .catch(() => false)
    if (ok) return
    // Fehlgeschlagen: evtl. offenes Popup schließen (Escape) + eingefügten
    // Text wieder rückgängig machen (Ctrl+Z x2 — ein Schritt für den
    // Enter-Split, einer für den getippten Text) und erneut versuchen.
    await page.keyboard.press('Escape').catch(() => {})
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(150)
  }
  const err = new Error(`insertAfterAnchor: Absatz mit Text "${typeText}" vor der Ankerzeile nach 3 Versuchen nicht erreicht.`)
  err.isAssertion = true
  throw err
}

/** Öffnet das Slash-Menü nach `insertAfterAnchor` — mit Retry: das Menü
 *  erwies sich im Testlauf bei der ERSTEN Invokation nach mehreren
 *  vorangegangenen Editor-Aktionen gelegentlich als kurz verzögert/ausbleibend
 *  (Suggestion-Plugin, das erst beim übernächsten Tick reagiert). Bis zu 3
 *  Versuche (jeweils neue Zeile über `insertAfterAnchor`), bevor aufgegeben
 *  wird — ECHTES Ausbleiben nach 3 Versuchen ist dann ein belastbarer Befund. */
async function openSlashMenu(page, doc) {
  const slashMenu = page.getByRole('listbox', { name: 'Befehlsmenü' })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await insertAfterAnchor(page, doc, '/')
    const ok = await slashMenu
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false)
    if (ok) return slashMenu
    await page.keyboard.press('Backspace').catch(() => {})
  }
  await slashMenu.waitFor({ state: 'visible', timeout: 3000 }) // wirft mit Klartext-Fehler
  return slashMenu
}

// --- Hauptlauf --------------------------------------------------------------
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

page.on('console', (msg) => pushRing(consoleLog, { type: msg.type(), text: msg.text() }))
page.on('pageerror', (err) => pushRing(pageErrorLog, err.message))
page.on('response', (res) => {
  pushRing(responseRing, {
    method: res.request().method(),
    url: res.url(),
    status: res.status(),
    resourceType: res.request().resourceType(),
  })
})

try {
  assert(FORGEJO_TOKEN, 'FORGEJO_TOKEN ist leer — weder process.env.FORGEJO_TOKEN noch deploy/wiki/.env#F451_FORGEJO_TOKEN gefunden.')

  await cleanupForgejoState('Setup')

  // === Bereich 1: Login (Forgejo) + Connect ===============================
  await area(page, '01 Login (Forgejo) + Connect', async () => {
    await page.goto(WEB, { waitUntil: 'domcontentloaded' })
    const loginLink = page.locator('a[href*="/auth/login"], a:has-text("Anmelden"), button:has-text("Anmelden")').first()
    if (await loginLink.count()) {
      await loginLink.click()
    } else {
      await page.goto(`${WEB}/auth/login`, { waitUntil: 'domcontentloaded' })
    }
    await page.waitForURL(/\/(user\/login|login\/oauth)/, { timeout: 20000 })
    if (/user\/login/.test(page.url())) {
      await page.fill('input[name="user_name"]', FORGEJO_USER)
      await page.fill('input[name="password"]', FORGEJO_PASS)
      await page.click('button[type="submit"], form button')
    }
    await page.waitForLoadState('domcontentloaded')
    await clickOptional(page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first())
    await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 20000 })
    await page.waitForLoadState('networkidle')

    const avatar = page.locator('button.avatar').first()
    await avatar.waitFor({ state: 'visible', timeout: 20000 })
    const title = await avatar.getAttribute('title')
    assert(!!title, 'Topbar-Avatar hat kein title-Attribut.')

    // Connect-Flow (Forgejo-Nutzertoken für Entwurfs-Commits).
    await page.goto(`${WEB}/auth/connect/forgejo`, { waitUntil: 'domcontentloaded' })
    await clickOptional(page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first())
    await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 20000 }).catch(() => {})
    await page.waitForLoadState('networkidle')

    return { avatarTitle: title }
  })

  // === Bereich 2: Alle 3 Seiten per URL ansehen ===========================
  await area(page, '02 Alle 3 Seiten per URL ansehen', async () => {
    const results = []
    for (const p of PAGES) {
      await page.goto(readUrl(p.pageId), { waitUntil: 'networkidle' })
      const { docStatus, heading } = await assertDocOkAndHeading(page, { expectHeading: p.heading })
      results.push({ id: p.id, docStatus, heading })
    }
    return { results }
  })

  // === Bereich 3: Wikilinks auf jeder der 3 Seiten =========================
  await area(page, '03 Wikilinks anklicken', async () => {
    const visited = []
    for (const p of PAGES) {
      await page.goto(readUrl(p.pageId), { waitUntil: 'networkidle' })
      const links = page.locator('.page-body a[href^="/wiki/"]')
      const count = await links.count()
      assert(count > 0, `Seite "${p.id}" hat keinen internen Wikilink im .page-body gefunden.`)
      for (let i = 0; i < count; i += 1) {
        const link = links.nth(i)
        const href = await link.getAttribute('href')
        await link.click()
        await page.waitForLoadState('networkidle')
        assert(/\/wiki\//.test(page.url()), `Ziel-URL "${page.url()}" matcht nicht /wiki/…`)
        assert(!/\/pages\//.test(page.url()), `Ziel-URL "${page.url()}" landete auf /pages/… statt /wiki/…`)
        const doc = lastDocumentResponse()
        assert(doc && doc.status !== 404, `Ziel-Doc-Response für "${href}" war 404.`)
        const heading = page.locator('.page-body h1').first()
        await heading.waitFor({ state: 'visible', timeout: 20000 })
        const headingText = (await heading.textContent())?.trim() ?? ''
        assert(headingText.length > 0, `Ziel-.page-body h1 für "${href}" ist leer.`)
        visited.push({ from: p.id, href, targetHeading: headingText })
        await page.goBack({ waitUntil: 'networkidle' })
      }
    }
    return { visited }
  })

  // === Bereich 4: Bilder/Diagramme ========================================
  await area(page, '04 Bilder/Diagramme laden wirklich', async () => {
    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    const imgs = page.locator('.page-body img[src*="/media/"]')
    const count = await imgs.count()
    assert(count > 0, 'Kein .page-body img[src*="/media/"] auf der Index-Seite gefunden.')
    const widths = []
    for (let i = 0; i < count; i += 1) {
      const img = imgs.nth(i)
      const src = await img.getAttribute('src')
      await img.waitFor({ state: 'visible', timeout: 10000 })
      let naturalWidth = 0
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        naturalWidth = await img.evaluate((el) => el.naturalWidth)
        if (naturalWidth > 0) break
        await new Promise((r) => setTimeout(r, 150))
      }
      assert(naturalWidth > 0, `Bild "${src}" hat naturalWidth=0 (nicht wirklich geladen).`)
      widths.push({ src, naturalWidth })
    }
    return { images: widths }
  })

  // === Bereich 5: Suche ====================================================
  await area(page, '05 Suche (Ctrl+K)', async () => {
    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    await page.keyboard.press('ControlOrMeta+k')
    const searchInput = page.getByRole('combobox', { name: 'Suchbegriff' })
    await searchInput.waitFor({ state: 'visible', timeout: 10000 })
    await searchInput.fill('Betrieb')
    const option = page.getByRole('option').first()
    await option.waitFor({ state: 'visible', timeout: 10000 })
    const optionText = (await option.textContent())?.trim() ?? ''
    await searchInput.press('Enter')
    await page.waitForLoadState('networkidle')
    assert(/\/wiki\//.test(page.url()), `Nach Suche-Enter: URL "${page.url()}" matcht nicht /wiki/…`)
    return { optionText, url: page.url() }
  })

  // === Bereich 6: Graph ====================================================
  await area(page, '06 Graph-Ansicht', async () => {
    await page.goto(`${WEB}/wiki/${SPACE}/graph`, { waitUntil: 'networkidle' })
    const svg = page.locator('svg.graph')
    await svg.waitFor({ state: 'visible', timeout: 20000 })
    const nodeCount = await svg.locator('g.node').count()
    assert(nodeCount > 0, 'svg.graph hat 0 g.node-Knoten.')
    // Gezielt den bekannten "Betriebshandbuch"-Knoten wählen (NICHT `.first()` —
    // die Knotenreihenfolge ist Layout-abhängig und der Stack enthält neben den
    // 3 dokumentierten Seed-Seiten noch mindestens eine weitere, fremde Seite
    // ("Vorlage"/betrieb/demo/index.md — Repo-Inhalt, der NICHT von
    // scripts/dev-local-setup.sh stammt und deren Markdown-Body keine H1 hat;
    // s. Abschlussbericht). Ein `.first()`-Knoten kann auf diese Fremd-Seite
    // treffen und die `.page-body h1`-Assertion sinnlos zum Scheitern bringen.
    const targetNode = svg.locator('g.node', { has: page.locator('text.lbl', { hasText: 'Betriebshandbuch' }) }).first()
    await targetNode.waitFor({ state: 'visible', timeout: 10000 })
    await targetNode.click()
    const pop = page.locator('.pop.card')
    await pop.waitFor({ state: 'visible', timeout: 10000 })
    const openLink = pop.getByRole('link', { name: 'Öffnen' })
    await openLink.waitFor({ state: 'visible', timeout: 10000 })
    const href = await openLink.getAttribute('href')
    await openLink.click()
    await page.waitForLoadState('networkidle')
    assert(/\/wiki\/betrieb\//.test(page.url()), `"Öffnen" führte zu "${page.url()}", nicht zur Leseansicht.`)
    const heading = page.locator('.page-body h1').first()
    await heading.waitFor({ state: 'visible', timeout: 10000 })
    return { nodeCount, openedHref: href, landedUrl: page.url() }
  })

  // === Bereich 7: Verweis-Report ===========================================
  await area(page, '07 Verweis-Report', async () => {
    await page.goto(`${WEB}/wiki/${SPACE}/report`, { waitUntil: 'networkidle' })
    const heading = page.getByRole('heading', { name: 'Verweis-Report' })
    await heading.waitFor({ state: 'visible', timeout: 10000 })
    const emptyStatus = page.getByRole('status')
    const hasEmptyStatus = await emptyStatus.isVisible({ timeout: 2000 }).catch(() => false)
    const emptyText = hasEmptyStatus ? (await emptyStatus.textContent())?.trim() : null
    const entryCount = await page.locator('.notice-list li').count()
    return { emptyText, entryCount }
  })

  // === Bereich 8: Theme-Toggle =============================================
  await area(page, '08 Theme-Toggle', async () => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    await page.locator('button[aria-label="Theme umschalten"]').click()
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    assert(before !== after, `data-theme änderte sich nicht (vorher/nachher: "${before}").`)
    return { before, after }
  })

  // === Bereich 9: Verbindungen =============================================
  await area(page, '09 Verbindungen (Forgejo verbunden)', async () => {
    await page.locator('button.avatar').click()
    const settingsItem = page.getByRole('menuitem', { name: /Einstellungen/ })
    await settingsItem.waitFor({ state: 'visible', timeout: 10000 })
    await settingsItem.click()
    await page.waitForURL(/\/einstellungen\/verbindungen/, { timeout: 10000 })
    const forgejoRow = page.locator('.conn-row', { has: page.locator('b', { hasText: 'Forgejo' }) })
    const pill = forgejoRow.locator('.pill')
    await pill.waitFor({ state: 'visible', timeout: 10000 })
    const pillText = (await pill.textContent())?.trim() ?? ''
    const isOk = await pill.evaluate((el) => el.classList.contains('ok'))
    assert(isOk, `Forgejo-Pill zeigt "${pillText}" (nicht ".ok") — NICHT getrennt, nur Beleg gescheitert.`)
    assert(pillText.includes('Verbunden'), `Forgejo-Pill-Text ist "${pillText}", erwartet "Verbunden".`)
    return { pillText }
  })

  // === Editor-Bereich: index.md → Bearbeiten (Entwurf, am Ende verworfen) ===
  await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })

  // === Bereich 10: Editor öffnen ===========================================
  let doc // wird für die folgenden Editor-Bereiche wiederverwendet
  await area(page, '10 Editor öffnen (.etoolbar + editierbares .doc.page-body)', async () => {
    const editLink = page.getByRole('link', { name: 'Bearbeiten' })
    await editLink.waitFor({ state: 'visible', timeout: 20000 })
    await editLink.click()
    await page.waitForURL(/\/edit(\?.*)?$/, { timeout: 20000 })
    const toolbar = page.locator('.etoolbar')
    await toolbar.waitFor({ state: 'visible', timeout: 20000 })
    await page
      .locator('.editor-root[aria-busy="true"]')
      .waitFor({ state: 'detached', timeout: 20000 })
      .catch(() => {})
    doc = page.locator('.doc.page-body')
    await doc.waitFor({ state: 'visible', timeout: 20000 })
    const isEditable = await doc.evaluate((el) => el.getAttribute('contenteditable') === 'true' || el.isContentEditable)
    assert(isEditable, '.doc.page-body ist nicht editierbar.')
    // Kurze Setzzeit: `.doc.page-body` ist zu diesem Zeitpunkt zwar sichtbar
    // und `contenteditable`, aber TipTap/ProseMirror registrieren ihre
    // Selection-Sync-Plugins teils erst einen React-Tick später — die ERSTE
    // Tastatur-Interaktion direkt nach dem Mount erwies sich dadurch als
    // race-anfällig (s. Abschlussbericht, Bereich 11). Ein echter Mensch
    // bräuchte für den ersten Klick ohnehin länger als dieses kurze Warten.
    await page.waitForTimeout(600)
    await createStableAnchor(page, doc)
    // Sofort explizit sichern + auf den ABGESCHLOSSENEN Save warten: die
    // Ankerzeile verschwand in einem Testlauf spurlos wieder (Dokument exakt
    // auf Pristine-Stand zurück) — ein Muster, das zu einer verzögerten
    // Autosave-Antwort passt, die den Editor-Inhalt auf einen ÄLTEREN,
    // vor-Anker-Stand zurücksetzt (s. Abschlussbericht). Ein bestätigter,
    // abgeschlossener Save-Zyklus VOR jeder weiteren Interaktion räumt dieses
    // Zeitfenster aus.
    await page.keyboard.press('ControlOrMeta+s')
    await waitForText(page.locator('.statusbar .saved'), 'Zuletzt gespeichert', {
      timeoutMs: 15000,
      label: 'Ankerzeile: Statuszeile zeigt nicht „Zuletzt gespeichert" nach Ctrl+S',
    })
    return { editUrl: page.url() }
  })

  // === Bereich 11: Toolbar (Fett/Kursiv/Code, Format, Liste, Tabelle, Link) ===
  await area(page, '11 Editor-Toolbar', async () => {
    assert(doc, 'Editor wurde in Bereich 10 nicht erfolgreich geöffnet — Toolbar-Test übersprungen.')
    // WICHTIGE LEKTION (erster Lauf): NICHT auf `doc.locator('p').first()`
    // klicken und dort per Toolbar eine Tabelle einfügen — `insertTable` an
    // einer Cursorposition INNERHALB des ersten Original-Absatzes ersetzte ihn
    // im ersten Lauf vollständig durch die Tabelle (ein `Ctrl+Z`-Rückgängig
    // griff nicht zuverlässig), wodurch jeder SPÄTERE `p.first()`-Anker in
    // einer leeren Tabellenzelle landete — dort sind Slash-Menü/Autocomplete
    // unterdrückt (`ui-extensions.ts#shouldShow`), was Bereich 12/13/15 zum
    // Einsturz brachte. Fix: eine EIGENE Wegwerf-Zeile anlegen (über den H1-
    // Anker, s. `insertAfterAnchor`) und NUR darauf testen — kein Rückgängig
    // nötig, der gesamte Entwurf wird in Bereich 20 ohnehin verworfen.
    await insertAfterAnchor(page, doc, 'e2e-toolbar-testzeile')
    const testLine = doc.locator('p', { hasText: 'e2e-toolbar-testzeile' }).last()
    await testLine.waitFor({ state: 'visible', timeout: 5000 })
    // Zeile per Tastatur selektieren (Home, Shift+End) statt Doppelklick —
    // robust gegen Bindestriche im Testtext (Doppelklick selektiert dort nur
    // ein Teilwort).
    await testLine.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')

    for (const sel of ['.tb.b', '.tb.i', '.tb.mono']) {
      await page.locator(sel).click()
      await page.locator(sel).click() // zurück-toggeln
      assert(await doc.isVisible(), `${sel}: .doc.page-body verschwand nach Klick.`)
    }
    assert(pageErrorLog.length === 0, `pageerror nach Formatierungs-Buttons: ${pageErrorLog.at(-1)}`)

    // Format-Dropdown öffnen + "Absatz" wählen (No-Op, da Absatz bereits aktiv).
    await page.locator('button.tb.fmt').click()
    const formatPop = page.locator('.menu[role="menu"]')
    await formatPop.waitFor({ state: 'visible', timeout: 5000 })
    await formatPop.getByRole('menuitem', { name: 'Absatz' }).click()

    // Liste (eine genügt): Aufzählungsliste an/aus — auf derselben Testzeile.
    await testLine.click()
    const bulletBtn = page.locator('button[title="Aufzählungsliste"]')
    await bulletBtn.click()
    await bulletBtn.click()

    // Link-Popover öffnen + wieder schließen (Abbrechen, kein Link gesetzt) —
    // wieder auf der Testzeile, nicht auf akkumuliertem Inhalt danach.
    await testLine.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.locator('button[title^="Link einfügen"]').click()
    const linkPop = page.locator('.menu.linkpop[role="dialog"]')
    await linkPop.waitFor({ state: 'visible', timeout: 5000 })
    await linkPop.getByRole('button', { name: 'Abbrechen' }).click()
    await linkPop.waitFor({ state: 'hidden', timeout: 5000 })

    // Tabelle einfügen — ALS LETZTES UND am Ende des LETZTEN bekannten Blocks
    // (dem Hinweis-Kasten am Seitenende), NICHT auf der Testzeile direkt nach
    // der H1: eine Tabelle, die direkt nach der H1 landet, blockiert den
    // `insertAfterAnchor`-Anker der NACHFOLGENDEN Bereiche (12/13/15/16).
    // `ControlOrMeta+End` erwies sich hier NICHT als zuverlässiger Sprung zum
    // Dokumentende (ein Versuch landete die Tabelle mitten in einem Wort
    // innerhalb der Einstieg-Liste, s. Abschlussbericht) — deshalb gezielt auf
    // den bekannten letzten Absatz (Hinweis-Kasten) klicken + `End`.
    const lastBlock = doc.locator('.alert p').last()
    await lastBlock.click()
    await page.keyboard.press('End')
    await page.locator('button[title="Tabelle einfügen"]').click()
    await doc.locator('table').first().waitFor({ state: 'visible', timeout: 5000 })

    assert(await doc.isVisible(), '.doc.page-body fehlt nach Toolbar-Durchlauf.')
    return { toolbarButtonsTested: ['Fett', 'Kursiv', 'Code', 'Format-Dropdown', 'Aufzählungsliste', 'Tabelle einfügen', 'Link einfügen'] }
  })

  // === Bereich 12: Slash-Menü (Hinweisboxen, Tabelle, Codeblock, Zitat, Trennlinie) ===
  await area(page, '12 Slash-Menü — Hinweisboxen/Tabelle/Codeblock/Zitat/Trennlinie', async () => {
    assert(doc, 'Editor nicht offen — Slash-Menü-Test übersprungen.')
    const items = ['Hinweis', 'Tipp', 'Wichtig', 'Warnung', 'Achtung', 'Tabelle', 'Codeblock', 'Zitat', 'Trennlinie']
    const inserted = []
    for (const itemName of items) {
      const slashMenu = await openSlashMenu(page, doc)
      const option = slashMenu.getByRole('option', { name: new RegExp(`^${itemName}`) }).first()
      await option.waitFor({ state: 'visible', timeout: 5000 })
      await option.click()
      await slashMenu.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      assert(await doc.isVisible(), `.doc.page-body fehlt nach Einfügen von "${itemName}".`)
      inserted.push(itemName)
    }
    assert(pageErrorLog.length === 0, `pageerror während Slash-Menü-Durchlauf: ${pageErrorLog.at(-1)}`)
    return { inserted }
  })

  // === Bereich 13: draw.io-Diagramm neu anlegen (Slash) =====================
  await area(page, '13 draw.io-Diagramm neu anlegen', async () => {
    assert(doc, 'Editor nicht offen — draw.io-Neuanlage-Test übersprungen.')

    // CSP frame-src der EDIT-Response holen (Middleware-Header, teilt sich die
    // Cookies mit dem Browser-Context). frame-src ist global identisch auf jeder
    // Middleware-Seite — wir prüfen sie hier direkt am Editor. Die Direktive MUSS
    // die tatsächliche draw.io-Quelle des iframe erlauben (Konsistenz-Guard
    // zwischen `drawioBaseUrl()` und der CSP, siehe middleware.ts-Kommentar).
    const editUrl = page.url()
    const cspResp = await page.request.get(editUrl)
    const csp = cspResp.headers()['content-security-policy'] ?? ''
    const frameSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-src'))
    assert(frameSrc, `Edit-Response ${editUrl} hat keine frame-src-Direktive in der CSP.`)

    const slashMenu = await openSlashMenu(page, doc)
    page.once('dialog', (d) => void d.accept('E2E-Discovery-Diagramm'))
    await slashMenu.getByRole('option', { name: 'draw.io-Diagramm' }).click()
    const dialog = page.locator('dialog.diagram-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    const iframe = dialog.locator('iframe.diagram-frame')
    await iframe.waitFor({ state: 'visible', timeout: 15000 })
    const src = await iframe.getAttribute('src')
    assert(!!src, 'iframe.diagram-frame hat kein src-Attribut.')

    // STRUKTURELLE Deployment-Bug-Prüfung (Phase 4c): der iframe-`src` MUSS vom
    // Browser des Anwenders erreichbar sein — entweder RELATIV (`/drawio…`,
    // same-origin-Proxy = robust, funktioniert über jede Deployment-URL) oder
    // eine ABSOLUTE URL mit exakt dem WEB_BASE-Host. Er darf NIEMALS auf
    // localhost/127.0.0.1 zeigen, solange WEB_BASE selbst nicht localhost ist —
    // sonst lädt draw.io für jeden Browser auf einem ANDEREN Rechner als dem
    // Docker-Host vom falschen Rechner (genau der behobene Bug). Diese Prüfung
    // ist STRUKTURELL: sie greift unabhängig davon, ob der Test-Browser zufällig
    // selbst localhost erreicht (deshalb wurde der Bug bisher übersehen).
    // HOSTNAME (ohne Port) vergleichen: draw.io läuft im Sofortfix-Fall
    // legitim auf einem ANDEREN Port als die Web-App (z. B. Web :8080,
    // draw.io :8081 auf demselben Host) — ein Host:Port-Vergleich würde diese
    // gültige Lösung fälschlich verwerfen. Der Bug ist der falsche HOST, nicht
    // der Port.
    const webHost = new URL(WEB).hostname
    const webIsLocal = /^(localhost|127\.0\.0\.1)$/.test(webHost)
    const srcIsRelative = /^\/(?!\/)/.test(src) // führender einzelner Slash (kein //host)
    const resolved = new URL(src, WEB) // relativ → gegen WEB_BASE aufgelöst
    const iframeHost = resolved.hostname
    const iframeIsLocal = /^(localhost|127\.0\.0\.1)$/.test(iframeHost)
    if (!webIsLocal) {
      assert(
        !iframeIsLocal,
        `iframe.diagram-frame src="${src}" zeigt auf localhost/127.0.0.1, obwohl WEB_BASE-Host "${webHost}" das nicht ist — draw.io wäre von einem anderen Rechner als dem Docker-Host unerreichbar (DER Deployment-Bug).`,
      )
    }
    assert(
      srcIsRelative || iframeHost === webHost,
      `iframe.diagram-frame src-Hostname="${iframeHost}" ist weder relativ (Proxy) noch identisch mit WEB_BASE-Hostname="${webHost}".`,
    )

    // Konsistenz: die CSP frame-src MUSS die draw.io-Quelle des iframe erlauben —
    // relativ (Proxy) ⇒ 'self', absolut ⇒ die iframe-Origin.
    const expectedFrameSource = srcIsRelative ? "'self'" : resolved.origin
    assert(
      frameSrc.includes(expectedFrameSource),
      `CSP frame-src ("${frameSrc}") erlaubt die draw.io-Quelle "${expectedFrameSource}" (aus iframe-src "${src}") NICHT.`,
    )

    const dialogError = dialog.locator('.diagram-dialog-error')
    const hasError = await dialogError.isVisible({ timeout: 1000 }).catch(() => false)
    await dialog.locator('button.diagram-dialog-close, button:has-text("Schließen")').first().click()
    await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
    return { iframeSrc: src, iframeHost, srcIsRelative, frameSrc, expectedFrameSource, dialogErrorShown: hasError }
  })

  // === Bereich 14: draw.io am bestehenden Seed-Diagramm =====================
  await area(page, '14 draw.io am bestehenden Seed-Diagramm (architektur.drawio.svg)', async () => {
    assert(doc, 'Editor nicht offen — Bestandsdiagramm-Test übersprungen.')
    const diagramNode = doc.locator('.diagram-node').first()
    await diagramNode.waitFor({ state: 'visible', timeout: 10000 })
    await diagramNode.hover()
    const editButton = diagramNode.locator('button.diagram-edit')
    await editButton.waitFor({ state: 'visible', timeout: 5000 })
    await editButton.click()
    const dialog = page.locator('dialog.diagram-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    const iframe = dialog.locator('iframe.diagram-frame')
    await iframe.waitFor({ state: 'visible', timeout: 15000 })
    const src = await iframe.getAttribute('src')
    // Das Seed-SVG trägt ein `content`-Attribut mit einem ECHTEN, validen
    // mxfile/mxGraphModel-Dokument (kein Platzhalter mehr) — der ECHTE
    // draw.io-Host im iframe muss das Modell darum erfolgreich laden, OHNE
    // „Not a diagram file"/Lade-Fehler. Das ist jetzt eine Regression-Guard:
    // bricht das Seed-Diagramm künftig wieder (z. B. invalides content-XML),
    // MUSS dieser Bereich fehlschlagen. draw.io ist eine schwergewichtige
    // GWT-App — die erste `innerText`-Lesung trifft oft nur den Lade-Spinner
    // ("Loading… Please ensure JavaScript is enabled."), NICHT den
    // eigentlichen Editor-/Fehlerzustand; deshalb pollen, bis sich der Text
    // stabilisiert (oder ein Timeout erreicht ist) statt einmalig zu lesen.
    let frameText = null
    try {
      const frame = page.frameLocator('iframe.diagram-frame')
      const deadline = Date.now() + 15000
      for (;;) {
        frameText = await frame.locator('body').innerText({ timeout: 3000 })
        if (!/Please ensure JavaScript is enabled/i.test(frameText) || Date.now() > deadline) break
        await page.waitForTimeout(500)
      }
    } catch (e) {
      frameText = `(iframe-Inhalt nicht lesbar: ${e.message})`
    }
    await page.waitForTimeout(1000)
    await page.screenshot({ path: resolve(ARTIFACT_DIR, '14-seed-diagram-iframe-state.png'), fullPage: true }).catch(() => {})

    // App-seitiger Fehlerzustand (z. B. Ladefehler der Draft-Datei selbst) —
    // MUSS ausbleiben.
    const dialogError = dialog.locator('.diagram-dialog-error')
    const hasDialogError = await dialogError.isVisible({ timeout: 1000 }).catch(() => false)
    assert(!hasDialogError, `.diagram-dialog-error sichtbar beim Öffnen des Bestandsdiagramms: ${hasDialogError ? await dialogError.textContent() : ''}`)

    // draw.io selbst MUSS das eingebettete mxGraphModel laden — kein
    // „Not a diagram file"-Fehlerdialog im iframe-Text.
    assert(
      !/not a diagram file/i.test(frameText ?? ''),
      `draw.io meldet „Not a diagram file" für das Seed-Diagramm — content-Attribut ist kein valides mxGraphModel mehr. Auszug: ${(frameText ?? '').slice(0, 300)}`,
    )

    await dialog.locator('button.diagram-dialog-close, button:has-text("Schließen")').first().click()
    await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
    return { iframeSrc: src, dialogErrorShown: hasDialogError, frameTextExcerpt: (frameText ?? '').slice(0, 300) }
  })

  // === Bereich 15: Excalidraw ==============================================
  await area(page, '15 Excalidraw einfügen', async () => {
    assert(doc, 'Editor nicht offen — Excalidraw-Test übersprungen.')
    const slashMenu = await openSlashMenu(page, doc)
    page.once('dialog', (d) => void d.accept('E2E-Discovery-Skizze'))
    await slashMenu.getByRole('option', { name: 'Excalidraw' }).click()
    const dialog = page.locator('dialog.diagram-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    const canvas = dialog.locator('.diagram-canvas .excalidraw')
    await canvas.waitFor({ state: 'visible', timeout: 20000 })
    await dialog.getByRole('button', { name: 'Abbrechen' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
    return { canvasLoaded: true }
  })

  // === Bereich 16: Wikilink-Autocomplete ====================================
  await area(page, '16 Wikilink-Autocomplete ([[)', async () => {
    assert(doc, 'Editor nicht offen — Autocomplete-Test übersprungen.')
    await insertAfterAnchor(page, doc, '[[')
    const popup = page.getByRole('listbox', { name: 'Seiten-Autocomplete' })
    await popup.waitFor({ state: 'visible', timeout: 5000 })
    await page.keyboard.press('Escape')
    return { popupAppeared: true }
  })

  // === Bereich 17: Moduswechsel =============================================
  await area(page, '17 Moduswechsel WYSIWYG↔Markdown', async () => {
    assert(doc, 'Editor nicht offen — Moduswechsel-Test übersprungen.')
    await page.getByRole('button', { name: 'Markdown' }).click()
    const normalizeDialog1 = page.getByRole('dialog', { name: 'Formatierung normalisieren?' })
    if (await normalizeDialog1.isVisible({ timeout: 1500 }).catch(() => false)) {
      await page.getByRole('button', { name: 'Normalisieren und wechseln' }).click()
      await normalizeDialog1.waitFor({ state: 'hidden', timeout: 5000 })
      await page.getByRole('button', { name: 'Markdown' }).click()
    }
    const rawContent = page.locator('.raw-editor .cm-content')
    await rawContent.waitFor({ state: 'visible', timeout: 10000 })

    await page.getByRole('button', { name: 'WYSIWYG' }).click()
    const normalizeDialog2 = page.getByRole('dialog', { name: 'Formatierung normalisieren?' })
    if (await normalizeDialog2.isVisible({ timeout: 1500 }).catch(() => false)) {
      await page.getByRole('button', { name: 'Normalisieren und wechseln' }).click()
      await normalizeDialog2.waitFor({ state: 'hidden', timeout: 5000 })
    }
    await doc.waitFor({ state: 'visible', timeout: 10000 })
    return { rawEditorSeen: true, backToWysiwyg: true }
  })

  // === Bereich 18: Befund-Panel ==============================================
  await area(page, '18 Befund-Panel (Validierungsbefunde)', async () => {
    assert(doc, 'Editor nicht offen — Befund-Panel-Test übersprungen.')
    const findingsButton = page.getByRole('button', { name: /Befund/ })
    await findingsButton.waitFor({ state: 'visible', timeout: 10000 })
    const buttonText = (await findingsButton.textContent())?.trim() ?? ''
    await findingsButton.click()
    const findingsDialog = page.getByRole('dialog', { name: 'Validierungsbefunde' })
    await findingsDialog.waitFor({ state: 'visible', timeout: 5000 })
    await page.keyboard.press('Escape')
    return { buttonText }
  })

  // === Bereich 19: Bild-Upload ===============================================
  await area(page, '19 Bild-Upload über die Toolbar', async () => {
    assert(doc, 'Editor nicht offen — Upload-Test übersprungen.')
    const fixture = resolve(REPO_ROOT, 'apps/web/e2e/fixtures/upload-test.svg')
    const initialCount = await doc.locator('img').count()
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Bild einfügen' }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(fixture)
    const newImg = doc.locator('img').nth(initialCount)
    await newImg.waitFor({ state: 'visible', timeout: 15000 })
    let naturalWidth = 0
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      naturalWidth = await newImg.evaluate((el) => el.naturalWidth)
      if (naturalWidth > 0) break
      await new Promise((r) => setTimeout(r, 150))
    }
    assert(naturalWidth > 0, 'Hochgeladenes Bild hat naturalWidth=0.')
    return { naturalWidth }
  })

  // === Bereich 20: Aufräumen — Entwurf verwerfen ============================
  await area(page, '20 Aufräumen — Entwurf verwerfen', async () => {
    const discardButton = page.getByRole('button', { name: 'Verwerfen' })
    await discardButton.waitFor({ state: 'visible', timeout: 10000 })
    await discardButton.click()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('menuitem', { name: 'Entwurf verwerfen' }).click()
    await page.waitForURL(/\/wiki\/betrieb\/[^/]+$/, { timeout: 20000 })
    const heading = page.locator('.page-body h1').first()
    await heading.waitFor({ state: 'visible', timeout: 10000 })
    return { landedUrl: page.url() }
  })

  // === Bereich 21: Neue Seite anlegen (dann verwerfen) ======================
  await area(page, '21 Neue Seite anlegen + verwerfen', async () => {
    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    const trigger = page.locator('nav.tree').getByRole('button', { name: /Neue Seite anlegen/ })
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    await trigger.click()
    const newPageDialog = page.getByRole('dialog', { name: 'Neue Seite anlegen' })
    await newPageDialog.waitFor({ state: 'visible', timeout: 10000 })
    await newPageDialog.getByRole('textbox', { name: 'Titel' }).fill('E2E Discovery Testseite')
    const rootRadio = newPageDialog.getByRole('radio', { name: /Space-Wurzel/ })
    await rootRadio.waitFor({ state: 'visible', timeout: 5000 })
    await rootRadio.check()
    await newPageDialog.getByRole('button', { name: 'Anlegen' }).click()
    await page.waitForURL(/\/edit(\?.*)?$/, { timeout: 20000 })
    const newDoc = page.locator('.doc.page-body')
    await newDoc.waitFor({ state: 'visible', timeout: 10000 })
    const editUrl = page.url()

    // Aufräumen — identisches Muster wie Bereich 20.
    const discardButton = page.getByRole('button', { name: 'Verwerfen' })
    await discardButton.waitFor({ state: 'visible', timeout: 10000 })
    await discardButton.click()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('menuitem', { name: 'Entwurf verwerfen' }).click()
    await page.waitForURL(/\/wiki\/betrieb\//, { timeout: 20000 })

    return { editUrl, landedUrl: page.url() }
  })

  // === Bereich 22: Review „Änderungen anfragen" =============================
  // EHRLICHE ABDECKUNGSGRENZE (siehe Kopfkommentar-Auftrag): wiki-admin ist
  // hier sowohl Autor des Entwurfs als auch derjenige, der „Änderungen
  // anfragen" klickt — ein Self-Request. Laut Vertrag (`client-api.ts#requestChanges`,
  // `apps/api/src/routes/workflow.ts` — Provider-Fehler 1:1 durchgereicht) kann
  // Forgejo das mit 422 ablehnen ("Poster of PR can not ... own PR"). Der
  // ECHTE Reviewer-Flow (ein ZWEITER Nutzer fordert Änderungen an einem PR
  // eines ANDEREN an) ist mit dem Ein-Nutzer-Dev-Seed strukturell NICHT
  // testbar — das wird hier dokumentiert, nicht grün gefakt. Geprüft wird
  // stattdessen: Button vorhanden + klickbar, Kommentar-Pflichtfeld greift,
  // und nach dem Klick tritt GENAU EINER von zwei vertraglich zulässigen
  // Zuständen ein (Erfolg ODER eine saubere 409/422-Fehlermeldung) — kein
  // Crash, kein pageerror, kein 500.
  await area(page, '22 Review — Änderungen anfragen (Self-Request, Abdeckungsgrenze)', async () => {
    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    const editLink = page.getByRole('link', { name: 'Bearbeiten' })
    await editLink.waitFor({ state: 'visible', timeout: 20000 })
    await editLink.click()
    await page.waitForURL(/\/edit(\?.*)?$/, { timeout: 20000 })
    const reviewDoc = page.locator('.doc.page-body')
    await reviewDoc.waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForTimeout(600) // s. Bereich 10 — TipTap-Selection-Sync-Race.
    await createStableAnchor(page, reviewDoc)
    await page.keyboard.press('ControlOrMeta+s')
    await waitForText(page.locator('.statusbar .saved'), 'Zuletzt gespeichert', { timeoutMs: 15000 })

    const requestReviewBtn = page.getByRole('button', { name: 'Review anfordern' })
    await requestReviewBtn.waitFor({ state: 'visible', timeout: 10000 })
    assert(await requestReviewBtn.isEnabled(), '"Review anfordern"-Button ist deaktiviert.')
    await requestReviewBtn.click()
    await page.waitForURL(/\/review(\?.*)?$/, { timeout: 20000 })

    const requestChangesBtn = page.getByRole('button', { name: 'Änderungen anfragen' })
    await requestChangesBtn.waitFor({ state: 'visible', timeout: 15000 })
    assert(await requestChangesBtn.isEnabled(), '"Änderungen anfragen"-Button ist deaktiviert.')

    // Kommentar-Pflichtfeld: OHNE Text darf NICHT abgeschickt werden.
    await requestChangesBtn.click()
    const requiredHint = page.locator('.act-hint', { hasText: 'Kommentar erforderlich' })
    await requiredHint.waitFor({ state: 'visible', timeout: 5000 })

    const commentBox = page.locator('.commentbox')
    await commentBox.waitFor({ state: 'visible', timeout: 10000 })
    await commentBox.fill('E2E-Discovery Bereich 22: Testkommentar für „Änderungen anfragen".')

    const pageErrorsBefore = pageErrorLog.length
    await requestChangesBtn.click()

    const successState = page.getByRole('button', { name: 'Änderungen angefordert' })
    const errorBanner = page.locator('.notice.broken[role="alert"] .txt')
    const outcome = await waitForEitherText(
      [
        { locator: successState, substring: 'Änderungen angefordert', label: 'Erfolg (Button umbenannt)' },
        { locator: errorBanner, substring: '', label: 'Fehlermeldung (.notice.broken)' },
      ],
      { timeoutMs: 15000 },
    )

    assert(
      pageErrorLog.length === pageErrorsBefore,
      `pageerror nach "Änderungen anfragen": ${pageErrorLog.at(pageErrorsBefore)}`,
    )

    const apiCall = [...responseRing].reverse().find((r) => /\/review\/request-changes$/.test(new URL(r.url).pathname))
    assert(apiCall, 'Kein Netzwerk-Beleg für POST .../review/request-changes im Ringpuffer gefunden.')

    let outcomeCase
    if (outcome.index === 0) {
      outcomeCase = 'ERFOLG'
      assert(apiCall.status === 204, `Erfolgsfall, aber API-Status war ${apiCall.status} (erwartet 204).`)
    } else {
      const errorText = outcome.text.trim()
      assert(errorText.length > 0, '.notice.broken .txt ist sichtbar, aber leer.')
      assert(
        apiCall.status === 409 || apiCall.status === 422,
        `Fehlerfall, aber API-Status war ${apiCall.status} (erwartet 409 oder 422 — dokumentierte Vertragsfälle, kein 500).`,
      )
      outcomeCase = apiCall.status === 422 ? 'ERWARTETES 422 (Self-Request, Provider-Meldung 1:1 durchgereicht)' : `409 (${errorText})`
      log(`  Hinweis: Fehlerfall wie erwartet — Self-Request als Autor. Meldung: "${errorText}"`)
    }

    // Aufräumen: Entwurf (+ damit den offenen PR) wieder verwerfen — identisches
    // Muster wie Bereich 20 (App-Flow, kein rohes Forgejo-Cleanup als Ersatz).
    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    const editLinkAgain = page.getByRole('link', { name: 'Bearbeiten' })
    await editLinkAgain.waitFor({ state: 'visible', timeout: 20000 })
    await editLinkAgain.click()
    await page.waitForURL(/\/edit(\?.*)?$/, { timeout: 20000 })
    const discardButton = page.getByRole('button', { name: 'Verwerfen' })
    await discardButton.waitFor({ state: 'visible', timeout: 10000 })
    await discardButton.click()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('menuitem', { name: 'Entwurf verwerfen' }).click()
    await page.waitForURL(/\/wiki\/betrieb\//, { timeout: 20000 })

    return {
      outcomeCase,
      apiStatus: apiCall.status,
      coverageGap:
        'Echter Reviewer-Flow (2. Nutzer fordert Änderungen an fremdem PR an) ist mit dem Ein-Nutzer-Dev-Seed NICHT testbar.',
      cleanedUp: true,
    }
  })

  // === Bereich 23: Logout + Re-Login =========================================
  await area(page, '23 Logout + Re-Login', async () => {
    await page.locator('button.avatar').click()
    const logoutItem = page.getByRole('menuitem', { name: /Abmelden/ })
    await logoutItem.waitFor({ state: 'visible', timeout: 10000 })
    await logoutItem.click()
    await page.waitForURL((u) => u.pathname === '/', { timeout: 20000 })
    const loginHeading = page.getByRole('heading', { name: 'Anmelden' })
    await loginHeading.waitFor({ state: 'visible', timeout: 10000 })

    // Geschützte Route muss jetzt zur Anmeldung umleiten (nicht mehr eingeloggt).
    await page.goto(`${WEB}/wiki/betrieb`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/\?next=/, { timeout: 20000 })
    const loginHeadingAfterGuard = page.getByRole('heading', { name: 'Anmelden' })
    await loginHeadingAfterGuard.waitFor({ state: 'visible', timeout: 10000 })

    // Wieder einloggen — Muster wie Bereich 1, MIT einer Korrektur: Bereich 1
    // läuft mit einem GARANTIERT frischen Browser-Kontext (Forgejo selbst hat
    // noch keine Session), daher zeigt Forgejo dort zuverlässig `/user/login`.
    // Hier (Re-Login IM SELBEN Kontext) ist Forgejos EIGENE Session weiterhin
    // gültig (wir haben uns nur beim f451-App abgemeldet, s. Bereich-Auftrag —
    // KEIN Forgejo-Logout) UND der OAuth-Client bereits autorisiert — Forgejo
    // überspringt Login-Formular UND Autorisierungs-Zwischenseite dadurch
    // komplett (reiner Server-Redirect-Chain-Durchlauf, per eigenem
    // Diagnoseskript verifiziert: `/auth/login` → Forgejo-Authorize (303,
    // ohne sichtbares Zwischenrendering) → `/auth/callback` → Ziel-Seite,
    // alles < 1s). Ein striktes `waitForURL(/user\/login|login\/oauth/)` (wie
    // in Bereich 1) würde in diesem Fall auf ein Ereignis warten, das nie
    // eintritt, und nach 20s zeitlos abbrechen, OBWOHL der Re-Login längst
    // erfolgreich war. Fix: auf EINEN von beiden gültigen Zwischenzuständen
    // warten (Login-Formular/Autorisierung ODER bereits zurück auf dem
    // f451-Host) — die eigentliche, strikte Endprüfung (Avatar mit korrektem
    // `title` sichtbar) bleibt unverändert scharf.
    await page.goto(WEB, { waitUntil: 'domcontentloaded' })
    const loginLink = page.locator('a[href*="/auth/login"], a:has-text("Anmelden"), button:has-text("Anmelden")').first()
    if (await loginLink.count()) {
      await loginLink.click()
    } else {
      await page.goto(`${WEB}/auth/login`, { waitUntil: 'domcontentloaded' })
    }
    await page.waitForURL((u) => /\/(user\/login|login\/oauth)/.test(u.pathname) || u.host === new URL(WEB).host, {
      timeout: 20000,
    })
    if (/user\/login/.test(page.url())) {
      await page.fill('input[name="user_name"]', FORGEJO_USER)
      await page.fill('input[name="password"]', FORGEJO_PASS)
      await page.click('button[type="submit"], form button')
    }
    await page.waitForLoadState('domcontentloaded')
    await clickOptional(page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first())
    await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 20000 })
    await page.waitForLoadState('networkidle')

    const avatarWithTitle = page.locator(`button.avatar[title="${FORGEJO_USER}"]`)
    await avatarWithTitle.waitFor({ state: 'visible', timeout: 20000 })

    return { loggedOut: true, guardRedirectUrl: true, reLoggedInAs: FORGEJO_USER }
  })

  // === Bereich 24: Verbindung trennen + wieder verbinden =====================
  await area(page, '24 Verbindung trennen + wieder verbinden', async () => {
    await page.goto(`${WEB}/einstellungen/verbindungen`, { waitUntil: 'networkidle' })
    const forgejoRow = page.locator('.conn-row', { has: page.locator('b', { hasText: 'Forgejo' }) })
    const pill = forgejoRow.locator('.pill')
    await pill.waitFor({ state: 'visible', timeout: 10000 })
    const beforeText = (await pill.textContent())?.trim() ?? ''
    assert(
      await pill.evaluate((el) => el.classList.contains('ok')),
      `Forgejo-Pill vor dem Trennen zeigt "${beforeText}" (nicht ".ok").`,
    )

    // Trennen — DESTRUKTIV, danach MUSS wiederverbunden werden (Pflicht).
    const disconnectBtn = forgejoRow.getByRole('button', { name: 'Forgejo trennen' })
    await disconnectBtn.waitFor({ state: 'visible', timeout: 10000 })
    await disconnectBtn.click()
    await waitForText(pill, 'Nicht verbunden', { timeoutMs: 15000 })
    assert(
      await pill.evaluate((el) => el.classList.contains('muted')),
      `Forgejo-Pill nach dem Trennen ist nicht ".muted" (Text: "${(await pill.textContent())?.trim()}").`,
    )

    let reconnectFailed = false
    let reconnectError = null
    try {
      // Wiederverbinden — identischer OAuth-Flow wie Bereich 1/9.
      await page.goto(`${WEB}/auth/connect/forgejo`, { waitUntil: 'domcontentloaded' })
      await clickOptional(page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first())
      await page.waitForURL((u) => u.host === new URL(WEB).host, { timeout: 20000 }).catch(() => {})
      await page.waitForLoadState('networkidle')

      await page.goto(`${WEB}/einstellungen/verbindungen`, { waitUntil: 'networkidle' })
      await waitForText(pill, 'Verbunden', { timeoutMs: 20000 })
      assert(
        await pill.evaluate((el) => el.classList.contains('ok')),
        `Forgejo-Pill nach Wiederverbinden ist nicht ".ok" (Text: "${(await pill.textContent())?.trim()}").`,
      )

      // Space „betrieb" muss wieder sichtbar sein (GET-Navigation rendert,
      // kein 404 — robuste Prüfung über Netzwerk-Ringpuffer, s. Kopfkommentar).
      await page.goto(`${WEB}/wiki/betrieb`, { waitUntil: 'networkidle' })
      await assertDocOkAndHeading(page)
    } catch (err) {
      // ECHTER Befund, falls Wiederverbinden fehlschlägt — nicht verstecken,
      // aber weiterhin versuchen, den Stack nutzbar zu hinterlassen (erneuter
      // Connect-Versuch), bevor der Fehler gemeldet wird.
      reconnectFailed = true
      reconnectError = err.message
      await page.goto(`${WEB}/auth/connect/forgejo`, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await clickOptional(page.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first()).catch(
        () => {},
      )
      await page.waitForLoadState('networkidle').catch(() => {})
    }

    assert(!reconnectFailed, `Wiederverbinden nach dem Trennen fehlgeschlagen (ECHTER Befund): ${reconnectError}`)

    return { beforeText, reconnected: true }
  })

  // === Bereich 25: Diagramm-Änderung sichtbar durch Review + Leseansicht ====
  // Schließt eine reale Abdeckungslücke: Bereich 14 prüft nur, dass draw.io das
  // BESTANDS-Diagramm im Dialog ÖFFNEN kann (kein Ladefehler) — nicht, dass eine
  // ECHTE Änderung an der Diagramm-DATEI danach durch die Review-Diff UND die
  // Leseansicht sichtbar wird. Genau diese Lücke ließ einen Bug durchrutschen
  // (Review-Diff zeigte die alte `main`-Fassung eines im Draft geänderten
  // Diagramms, s. `resolve-links.ts#buildResolveImage`s `ref`-Parameter; die
  // Leseansicht cachte bis zu 5 min die alte Datei, s. `media.ts`s
  // `Cache-Control`/`ETag`-Fix). Fixture statt draw.io-iframe-Interaktion
  // (robuster — s. Bereich-14-Kopfkommentar zur GWT-App-Schwergewichtigkeit von
  // draw.io selbst): Forgejo-Contents-API direkt auf dem Draft-Branch, exakt das
  // PUT-Muster aus `cleanupForgejoState`/Setup oben. Die Anwenderaktionen selbst
  // (Editor öffnen, „Review anfordern", „Freigeben & mergen", Leseansicht neu
  // laden) laufen echt über die UI — nur die Diagramm-BEARBEITUNG (die draw.io-
  // Interaktion selbst) ist bereits durch Bereich 13/14 abgedeckt und wird hier
  // bewusst nicht dupliziert.
  await area(page, '25 Diagramm-Änderung sichtbar durch Review + Leseansicht', async () => {
    const seedSvgPath = resolve(REPO_ROOT, 'scripts/seed/_media/architektur.drawio.svg')
    const seedSvg = readFileSync(seedSvgPath, 'utf8')
    assert(seedSvg.includes('>DB<'), 'Seed-SVG enthält nicht ">DB<" (sichtbarer Textknoten) — Fixture-Annahme verletzt (Seed geändert?).')
    assert(
      seedSvg.includes('value=&quot;DB&quot;'),
      'Seed-SVG enthält nicht value=&quot;DB&quot; (mxGraphModel) — Fixture-Annahme verletzt.',
    )
    const markedSvg = seedSvg.replace('>DB<', '>DBv2<').replace('value=&quot;DB&quot;', 'value=&quot;DBv2&quot;')
    assert(markedSvg.includes('>DBv2<') && markedSvg.includes('value=&quot;DBv2&quot;'), 'DBv2-Fixture-Ersetzung fehlgeschlagen.')

    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    const editLink = page.getByRole('link', { name: 'Bearbeiten' })
    await editLink.waitFor({ state: 'visible', timeout: 20000 })
    await editLink.click()
    await page.waitForURL(/\/edit(\?.*)?$/, { timeout: 20000 })
    const editDoc = page.locator('.doc.page-body')
    await editDoc.waitFor({ state: 'visible', timeout: 20000 })

    // Draft-Branch über Forgejo-API finden (deterministischer Name, s.
    // apps/api/src/drafts/branch-name.ts) — die Anlage (`POST .../draft` beim
    // Editor-Öffnen) ist asynchron zur Navigation, daher kurz nachpollen.
    let draftBranch = null
    for (let attempt = 0; attempt < 10 && !draftBranch; attempt += 1) {
      const branchesRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/branches`)
      assert(branchesRes.ok, `GET /branches lieferte Status ${branchesRes.status}`)
      draftBranch = branchesRes.body.map((b) => b.name).find((n) => n.startsWith('draft/path-betrieb-index.md'))
      if (!draftBranch) await new Promise((r) => setTimeout(r, 500))
    }
    assert(draftBranch, 'Kein draft/path-betrieb-index.md*-Branch nach Editor-Öffnen gefunden.')

    const contentsRes = await forgejoApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/_media/architektur.drawio.svg?ref=${encodeURIComponent(draftBranch)}`,
    )
    assert(
      contentsRes.ok,
      `GET contents/_media/architektur.drawio.svg?ref=${draftBranch} lieferte Status ${contentsRes.status}`,
    )
    const putRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/_media/architektur.drawio.svg`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: Buffer.from(markedSvg, 'utf8').toString('base64'),
        message: 'test: Discovery-E2E-Fixture (Diagramm-Änderungs-Pfad, Bereich 25)',
        branch: draftBranch,
        sha: contentsRes.body.sha,
      }),
    })
    assert(putRes.ok, `PUT DBv2-Fixture auf Draft-Branch lieferte Status ${putRes.status}.`)

    const requestReviewBtn = page.locator('.statusbar').getByRole('button', { name: 'Review anfordern' })
    await requestReviewBtn.waitFor({ state: 'visible', timeout: 10000 })
    assert(await requestReviewBtn.isEnabled(), '"Review anfordern"-Button ist deaktiviert.')
    await requestReviewBtn.click()
    await page.waitForURL(/\/review(\?.*)?$/, { timeout: 20000 })
    await page.waitForLoadState('networkidle')

    // Beleg 1: Review-Diff zeigt die GEÄNDERTE (Draft-)Version — strikt sowohl
    // die URL-Form (`?ref=draft`) ALS AUCH den tatsächlich ausgelieferten Inhalt.
    const diagramImg = page.locator('img[src*="architektur.drawio.svg"]').first()
    await diagramImg.waitFor({ state: 'visible', timeout: 15000 })
    const diagramSrc = await diagramImg.getAttribute('src')
    assert(diagramSrc && diagramSrc.includes('ref=draft'), `Review-Diff-Bild-src enthält kein "ref=draft": "${diagramSrc}"`)
    const reviewDiagramText = await page.evaluate(async (src) => {
      const r = await fetch(src, { credentials: 'include' })
      return r.text()
    }, diagramSrc)
    assert(
      reviewDiagramText.includes('DBv2'),
      `Review-Diff-Diagramm zeigt NICHT die geänderte Version ("DBv2"). src=${diagramSrc}`,
    )

    // Freigeben & mergen — `pr.mergeable` kann kurz nach PR-Anlage noch nicht
    // final berechnet sein (s. `workflow.ts`s `pollMergeable`-Kommentar); bis zu
    // ~9s mit Reload nachpollen, bevor das als echter Befund gilt.
    const mergeBtn = page.getByRole('button', { name: 'Freigeben & mergen' })
    await mergeBtn.waitFor({ state: 'visible', timeout: 10000 })
    let mergeableNow = await mergeBtn.isEnabled()
    let pollAttempts = 0
    while (!mergeableNow && pollAttempts < 6) {
      pollAttempts += 1
      await page.waitForTimeout(1500)
      await page.reload({ waitUntil: 'networkidle' })
      await mergeBtn.waitFor({ state: 'visible', timeout: 10000 })
      mergeableNow = await mergeBtn.isEnabled()
    }
    assert(mergeableNow, `"Freigeben & mergen"-Button bleibt nach ${pollAttempts} Reload-Versuchen deaktiviert (nicht mergeable?).`)
    await mergeBtn.click()

    // Entweder Auto-Navigate zur Leseansicht ODER approveWarning-Banner mit
    // manuellem Link (Self-Review-Fall, s. Bereich 22) — beide sind gültige
    // Erfolgsausgänge des Merges selbst.
    const outcome = await Promise.race([
      page
        .waitForURL((u) => /\/wiki\/betrieb\//.test(u.pathname) && !/\/review/.test(u.pathname), { timeout: 20000 })
        .then(() => 'auto-nav')
        .catch(() => null),
      page
        .locator('.notice.rel', { hasText: 'Automatische Freigabe fehlgeschlagen' })
        .waitFor({ state: 'visible', timeout: 20000 })
        .then(() => 'approve-warning')
        .catch(() => null),
    ])
    if (outcome === 'approve-warning') {
      await page.locator('a', { hasText: 'Zur Leseansicht' }).click()
      await page.waitForURL(/\/wiki\/betrieb\//, { timeout: 20000 })
    } else {
      assert(outcome === 'auto-nav', 'Nach "Freigeben & mergen" weder Auto-Navigate noch approveWarning-Banner erkannt.')
    }
    await page.waitForLoadState('networkidle')

    // Beleg 2: Leseansicht (FRISCH geladen, kein Next-Router-Soft-Cache) zeigt
    // die geänderte Version — der eigentliche Kern der Regression (ETag-
    // Revalidierung statt 5-min-`max-age`-Stale, s. `media.ts`).
    await page.goto(readUrl('path:betrieb/index.md'), { waitUntil: 'networkidle' })
    const readImg = page.locator('.page-body img[src*="/media/"]').first()
    await readImg.waitFor({ state: 'visible', timeout: 15000 })
    const readSrc = await readImg.getAttribute('src')
    const readDiagramText = await page.evaluate(async (src) => {
      const r = await fetch(src, { credentials: 'include' })
      return r.text()
    }, readSrc)
    assert(
      readDiagramText.includes('DBv2'),
      `Leseansicht zeigt NICHT die geänderte Version ("DBv2") nach dem Merge. src=${readSrc}`,
    )

    // Aufräumen: Diagramm auf main wieder auf den Seed-Stand zurücksetzen — Space
    // bleibt sauber (Muster identisch zu `cleanupForgejoState`s index.md-Reset,
    // hier zusätzlich für die Media-Datei, die dort NICHT abgedeckt ist).
    const mainRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/_media/architektur.drawio.svg?ref=main`)
    assert(mainRes.ok, `GET contents/_media/architektur.drawio.svg?ref=main (Cleanup) lieferte Status ${mainRes.status}`)
    const mainSvgContent = Buffer.from(mainRes.body.content, 'base64').toString('utf8')
    if (mainSvgContent !== seedSvg) {
      const resetRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/_media/architektur.drawio.svg`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: Buffer.from(seedSvg, 'utf8').toString('base64'),
          message: 'test: Diagramm auf Seed-Stand zurücksetzen (Bereich-25-Cleanup)',
          branch: 'main',
          sha: mainRes.body.sha,
        }),
      })
      assert(resetRes.ok, `PUT Diagramm-Reset auf main lieferte Status ${resetRes.status}`)
    }

    // Zusätzlich `index.md` auf main gegenprüfen: dieser Bereich ist der EINZIGE
    // im gesamten Discovery-Lauf, der wirklich mergt (alle anderen Bereiche
    // verwerfen ihren Draft, s. Bereiche 20/21/22) — „Review anfordern" flusht
    // dabei den aktuellen Editor-Inhalt (`handleRequestReview` → `triggerFlush`),
    // der beim Zurückschreiben durch den WYSIWYG→Markdown-Serializer läuft. Der
    // ist NICHT byte-identisch zur rohen Seed-Datei (z. B. `draw.io` → `draw\.io`-
    // Escaping, s. `docToMarkdown`) — OHNE diesen Reset bliebe main nach JEDEM
    // Lauf dieses Bereichs dauerhaft leicht gedriftet, obwohl niemand den Text
    // absichtlich geändert hat. Sonst identisches Muster wie `cleanupForgejoState`
    // (Setup) oben.
    const seedIndexPath = resolve(REPO_ROOT, 'scripts/seed/index.md')
    const seedIndex = readFileSync(seedIndexPath, 'utf8')
    const mainIndexRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.md?ref=main`)
    assert(mainIndexRes.ok, `GET contents/index.md?ref=main (Cleanup) lieferte Status ${mainIndexRes.status}`)
    const mainIndexContent = Buffer.from(mainIndexRes.body.content, 'base64').toString('utf8')
    if (mainIndexContent !== seedIndex) {
      const resetIndexRes = await forgejoApi(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: Buffer.from(seedIndex, 'utf8').toString('base64'),
          message: 'test: index.md auf Seed-Stand zurücksetzen (Bereich-25-Cleanup, Serializer-Rundreise)',
          branch: 'main',
          sha: mainIndexRes.body.sha,
        }),
      })
      assert(resetIndexRes.ok, `PUT index.md-Reset auf main lieferte Status ${resetIndexRes.status}`)
    }

    return {
      draftBranch,
      diagramSrcReview: diagramSrc,
      diagramSrcRead: readSrc,
      mergePollAttempts: pollAttempts,
      mainDiagramReset: mainSvgContent !== seedSvg,
      mainIndexReset: mainIndexContent !== seedIndex,
    }
  })

  log('\n=== ALLE 25 BEREICHE DURCHLAUFEN ===')
} catch (err) {
  // Nur für Fehler AUSSERHALB von `area()` (Setup/FORGEJO_TOKEN/Browser-Start) —
  // jeder Bereichs-Fehler wird bereits innerhalb von `area()` abgefangen.
  log(`\n=== UNERWARTETER ABBRUCH AUSSERHALB EINES BEREICHS: ${err.message} ===`)
  findings.push({ no: '-', name: 'Unerwarteter Rahmen-Fehler', status: 'FAIL', error: err.message })
} finally {
  log('\n--- Ergebnistabelle ---')
  for (const f of findings) {
    log(`  [${f.no}] ${f.name}: ${f.status}${f.status === 'FAIL' ? ` — ${f.error}` : ''}`)
  }

  try {
    await cleanupForgejoState('Teardown')
  } catch (teardownErr) {
    log(`  Teardown-WARNUNG: ${teardownErr.message}`)
  }

  writeFileSync(resolve(ARTIFACT_DIR, 'findings.json'), JSON.stringify(findings, null, 2), 'utf8')
  await browser.close()
  process.exitCode = findings.some((f) => f.status === 'FAIL') ? 1 : 0
}
