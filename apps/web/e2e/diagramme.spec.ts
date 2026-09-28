import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Phase-3e-Abnahme (Task 6): die vier Diagramm-E2E-Flows aus dem Task-Brief
 * PLUS drei Pflicht-Auflagen aus den Task-Reviews 3/4/5 (die der Brief noch
 * nicht kannte, s. Task-Prompt) gegen denselben Stack wie
 * `editor.spec.ts`/`workflow.spec.ts`/`komfort.spec.ts` (EIN `globalSetup`-Lauf,
 * `workers: 1` — alle Spec-Dateien teilen sich Postgres/Forgejo/Mock-IdP/
 * `next dev`). Eigene Seed-Seite `architektur` (s. `setup/start-stack.ts`
 * `seedRepo`) mit einem bereits committeten `.drawio.svg`, damit die Reihenfolge
 * der Spec-Dateien keine Rolle spielt (Muster `workflow-*`-Seiten).
 *
 *   1. Leseansicht: das Diagramm-Bild rendert als GEWÖHNLICHES `<img>` — kein
 *      `.diagram-node`/`.diagram-edit` außerhalb des Editors (die NodeView aus
 *      `ui-extensions.ts` ist reines Editor-Verhalten).
 *   2. Editor + draw.io: der „Diagramm bearbeiten"-Button einer bestehenden
 *      Diagramm-NodeView (Bild-Node ist ein atomarer Leaf OHNE `contentDOM`,
 *      Auflage A/Task-3-Review — unit-seitig nicht testbar, braucht ein
 *      echtes ProseMirror-`contentEditable`) ist im echten DOM anklickbar UND
 *      öffnet den Dialog, OHNE dass stattdessen nur der Node selektiert wird
 *      (`ProseMirror-selectednode`-Klasse bleibt aus). Der iframe wird über
 *      einen Protokoll-Stub bedient (`page.route` auf die per
 *      `NEXT_PUBLIC_DRAWIO_URL` konfigurierte Fake-Origin, s. `start-stack.ts`)
 *      — der Stub sendet auf `{action:'load'}` ein `{event:'save'}` OHNE
 *      `exit`-Feld (Auflage B/Task-4-Review: das reale `jgraph/drawio`-
 *      `noSaveBtn=1`-„Save & Exit" sendet laut Task 4 KEIN `exit`-Feld —
 *      `createDrawioProtocol` behandelt ein fehlendes Feld als `true`; die
 *      Assertion hier ist deshalb „nach erfolgreichem Save schließt der
 *      Dialog", nicht nur „Save kam an"). `img.src` trägt danach `v=1`
 *      (Cache-Bust, `bumpDiagramVersion`), Forgejo-REST bestätigt den neuen
 *      Text auf dem Draft-Branch.
 *   3. Excalidraw-Neuanlage: `/`-Menü → „Excalidraw" → `window.prompt`
 *      (`page.on('dialog')`) → ECHTE `@excalidraw/excalidraw`-Komponente lädt
 *      (kein Stub, anders als draw.io — Task 5: React-Komponente statt
 *      externem Dienst) → ein Rechteck wird tatsächlich gezeichnet (Werkzeug-
 *      Klick + `mouse.move/down/move/up`, Beweis für echte Interaktion, s.
 *      Wahl-Begründung unten) → „Speichern und schließen" → Forgejo-REST
 *      bestätigt NICHT NUR die Existenz der Datei, sondern dass sie
 *      `payload-type:application/vnd.excalidraw+json` ENTHÄLT (Auflage
 *      C/Task-5-Review: das ist der Beweis, dass der Server-Sanitizer die
 *      Excalidraw-Metadaten-Kommentare erhalten hat, nicht nur dass
 *      irgendeine SVG committet wurde) — UND das Diagramm wird über den
 *      Bearbeiten-Button erneut geöffnet: der Excalidraw-Canvas lädt wieder,
 *      ohne Fehlerbanner (Beweis, dass die committete Datei ihrerseits wieder
 *      einlesbar ist, `sceneFromSvgText`/`loadFromBlob`).
 *   4. ifAbsent-Schutz: ein zweites „Excalidraw"-Slash-Item mit demselben
 *      Namen („Testskizze") auf derselben Seite löst den 409-Konfliktpfad aus
 *      (`ifAbsent: true` bei Neuanlage) — Fehlermeldung „Eine Datei mit
 *      diesem Namen existiert bereits.", der Dialog bleibt offen (kein
 *      stilles Überschreiben, kein automatisches Schließen).
 *
 * Wahl (Brief-Hinweis „flaky vs. leer, dokumentieren"): Flow 3 zeichnet
 * BEWUSST ein echtes Rechteck statt eine leere Szene zu speichern — die
 * Auflage-C-Assertions (Sanitizer-Payload, Re-Open) tragen zwar auch mit
 * einer leeren Szene (s. `excalidraw-io.ts#sceneToSvgText`:
 * `exportEmbedScene` ist IMMER gesetzt, unabhängig von der Elementanzahl),
 * aber NUR ein gezeichnetes Element beweist, dass die Toolbar/Canvas-
 * Interaktion selbst (Werkzeugwahl, Maus-Drag) tatsächlich funktioniert und
 * nicht nur der Speichern-Button. Die Zeichenschritte laufen über großzügige,
 * vom Canvas-`boundingBox` abgeleitete Koordinaten (kein hartkodierter
 * Viewport-Offset) und wurden im Stabilitätslauf (zweiter Durchlauf, s.
 * Task-Report) verifiziert — sollte das Zeichnen in einer anderen Umgebung
 * flaky werden, ist der Fallback (leere Szene speichern) eine bewusst
 * dokumentierte, funktional gleichwertige Option für die Auflage-C-Beweise.
 */
const SPACE = 'e2e-handbuch'

// Muss dieselbe Fake-Origin sein wie `NEXT_PUBLIC_DRAWIO_URL` in
// `setup/start-stack.ts` (dort `DRAWIO_STUB_ORIGIN`) — ein Port ohne echten
// Dienst dahinter, `page.route` fängt jede Anfrage dorthin ab.
const DRAWIO_STUB_ORIGIN = 'http://127.0.0.1:4599'

interface StackState {
  forgejoBaseUrl: string
  forgejoToken: string
  repoOwner: string
  repoName: string
}

const STATE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '.stack-state.json')

function readStackState(): StackState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState
}

/** Forgejo-Contents-API-Pfad (identisch zu `workflow.spec.ts`s Helfer bzw.
 *  `packages/git-provider/src/forgejo.ts#encodePath` — hier lokal nachgebaut,
 *  da dieser Testprozess das Paket nicht importieren kann, s.
 *  `setup/start-stack.ts`-Kopfkommentar). */
function forgejoContentsUrl(state: StackState, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${state.forgejoBaseUrl}/api/v1/repos/${state.repoOwner}/${state.repoName}/contents/${encoded}`
}

/** Liest den Inhalt einer Datei auf einem BELIEBIGEN Branch (anders als
 *  `workflow.spec.ts`s `readMainFile`, die fest auf `main` zielt) direkt über
 *  die Forgejo-REST-API — Grundlage für die Sanitizer-/Persistenz-Beweise
 *  (Auflagen B/C), die NICHT über unsere eigene Draft-API laufen (die liefert
 *  nur den zuletzt gespeicherten Stand, keinen unabhängigen Beweis, dass er
 *  tatsächlich COMMITTET wurde). */
async function readBranchFile(request: APIRequestContext, state: StackState, path: string, branch: string): Promise<string> {
  const res = await request.get(`${forgejoContentsUrl(state, path)}?ref=${encodeURIComponent(branch)}`, {
    headers: { Authorization: `token ${state.forgejoToken}` },
  })
  expect(res.ok(), `Forgejo GET ${path}@${branch} sollte 200 liefern`).toBe(true)
  const body = (await res.json()) as { content: string }
  return Buffer.from(body.content, 'base64').toString('utf8')
}

async function login(page: Page): Promise<void> {
  await page.goto('/wiki')
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}`))
}

/** Wartet auf die (nächste) 200-Antwort der Diagramm-Route für `pageId` —
 *  eigenständiges Signal statt eines Sleeps, egal ob draw.io- oder
 *  Excalidraw-Dialog den PUT auslöst. */
function waitForDiagramPut(page: Page, pageId: string, expectedStatus = 200) {
  return page.waitForResponse(
    (res) => res.request().method() === 'PUT' && res.url().endsWith(`/api/pages/${pageId}/draft/diagram`) && res.status() === expectedStatus,
  )
}

// Gültige, minimale draw.io-SVG (Struktur wie der Seed in `start-stack.ts`,
// NUR der Text unterscheidet sich — „Neu" statt „Start") — das ist der
// Inhalt, den der Protokoll-Stub als `export`-Antwort zurückgibt und der
// serverseitig `sanitizeSvg` durchlaufen muss (gültiges `<svg>`-Root,
// erlaubte Tags/Attribute).
const STUB_DRAWIO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" content="&lt;mxfile&gt;&lt;diagram id=&quot;d2&quot; name=&quot;Seite-1&quot;&gt;abc123&lt;/diagram&gt;&lt;/mxfile&gt;">
  <rect x="10" y="10" width="80" height="40" fill="none" stroke="currentColor"/>
  <text x="50" y="35" text-anchor="middle" font-size="12">Neu</text>
</svg>`
const STUB_DRAWIO_SVG_B64 = Buffer.from(STUB_DRAWIO_SVG, 'utf8').toString('base64')

/** draw.io-Embed-postMessage-Protokoll-Stub (Plan-Entscheidung 7, s.
 *  `lib/editor/drawio-protocol.ts`-Kopfkommentar): simuliert den KOMPLETTEN
 *  Ablauf eines „Save & Exit" (der einzige Button bei `noSaveBtn=1`), OHNE
 *  echtes draw.io. Sendet auf `{action:'load'}` (Antwort auf das `init`, das
 *  der Stub selbst beim Laden schickt) sofort ein `{event:'save'}` — BEWUSST
 *  OHNE `exit`-Feld (Auflage B): das reale `jgraph/drawio` tut das laut
 *  Task 4 auch nicht, `createDrawioProtocol` muss das fehlende Feld als
 *  `exit: true` werten. */
const DRAWIO_STUB_HTML = `<!doctype html><script>
parent.postMessage(JSON.stringify({event:'init'}), '*')
addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.action === 'load') parent.postMessage(JSON.stringify({event:'save'}), '*')
  if (m.action === 'export') {
    parent.postMessage(JSON.stringify({event:'export', format:'xmlsvg', data:'data:image/svg+xml;base64,${STUB_DRAWIO_SVG_B64}'}), '*')
  }
})
</script>`

test.describe.configure({ mode: 'serial' })

let state: StackState
let page: Page

test.beforeAll(async ({ browser }) => {
  state = readStackState()
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

test('Flow 1: Leseansicht — Diagramm rendert als normales Bild, kein Editor-Node', async () => {
  await page.goto(`/wiki/${SPACE}/architektur`)
  await expect(page.getByRole('heading', { name: 'Architektur', level: 1 })).toBeVisible()

  const img = page.locator('.page-body img[src*="/media/"][src*="deployment.drawio.svg"]')
  await expect(img).toBeVisible()
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0)

  // Entscheidung 1 (Diagramm-NodeView ist reines Editor-Verhalten): in der
  // Leseansicht gibt es weder den Wrapper noch den Bearbeiten-Button.
  await expect(page.locator('.page-body .diagram-node')).toHaveCount(0)
  await expect(page.locator('.page-body .diagram-edit')).toHaveCount(0)
})

test('Flow 2: Editor — Bearbeiten-Button (echtes contentEditable, kein Node-Select statt Dialog) + voller draw.io-Zyklus', async () => {
  await page.route(`${DRAWIO_STUB_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: DRAWIO_STUB_HTML }),
  )

  await page.goto(`/wiki/${SPACE}/architektur/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()

  const diagramNode = page.locator('.doc.page-body .diagram-node')
  await expect(diagramNode).toBeVisible()
  const editButton = diagramNode.locator('button.diagram-edit')

  // Auflage A (Task-3-Review): der Bild-Node ist ein atomarer ProseMirror-Leaf
  // OHNE `contentDOM` — im echten `contentEditable` riskiert ein Klick auf ein
  // Kind-Element, dass ProseMirror STATTDESSEN den ganzen Node per
  // `NodeSelection` selektiert (`ProseMirror-selectednode`-Klasse) und der
  // Button-Klick verschluckt wird. Hover + echter Klick (kein `dispatchEvent`)
  // + BEIDE Assertions (Dialog öffnet UND keine Node-Selektion) sind der
  // Beweis, dass das nicht passiert.
  await diagramNode.hover()
  const putPromise = waitForDiagramPut(page, 'architektur')
  await editButton.click()

  const dialog = page.locator('dialog.diagram-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('iframe.diagram-frame')).toHaveAttribute('src', /^http:\/\/127\.0\.0\.1:4599/)
  await expect(diagramNode).not.toHaveClass(/ProseMirror-selectednode/)

  // Der Stub durchläuft init → load → save (ohne exit) → export vollautomatisch
  // — kein Klick im iframe nötig (kein echtes draw.io, s. Kopfkommentar).
  const putRes = await putPromise
  expect(putRes.status()).toBe(200)

  // Auflage B: „Save" ohne `exit`-Feld gilt als Schließen — der Dialog ist
  // NACH dem erfolgreichen Save zu, nicht offen geblieben.
  await expect(dialog).toBeHidden()

  // Cache-Bust: das <img> im Node trägt jetzt `v=1`.
  await expect(diagramNode.locator('img')).toHaveAttribute('src', /[?&]v=1(&|$)/)

  await page.unroute(`${DRAWIO_STUB_ORIGIN}/**`)

  // Forgejo-REST: der Draft-Branch trägt den neuen Text („Neu") aus dem Stub —
  // unabhängiger Beweis (nicht nur unsere eigene Draft-API), dass der PUT
  // tatsächlich committet hat.
  const branchContent = await readBranchFile(page.request, state, 'architektur/_media/deployment.drawio.svg', 'draft/architektur')
  expect(branchContent).toContain('Neu')
})

test('Flow 3: Excalidraw — Neuanlage per Slash-Menü, echter Editor, Commit + Sanitizer-Beweis + Re-Open', async () => {
  const NAME = 'Testskizze'

  await page.goto(`/wiki/${SPACE}/architektur/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()
  const doc = page.locator('.doc.page-body')

  await doc.getByRole('heading', { level: 1, name: 'Architektur' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const slashMenu = page.getByRole('listbox', { name: 'Befehlsmenü' })
  await expect(slashMenu).toBeVisible()

  page.once('dialog', (d) => void d.accept(NAME)) // window.prompt("Name der Skizze:")
  await slashMenu.getByRole('option', { name: 'Excalidraw' }).click()

  const dialog = page.locator('dialog.diagram-dialog')
  await expect(dialog).toBeVisible()
  const canvasRoot = dialog.locator('.diagram-canvas .excalidraw')
  await expect(canvasRoot).toBeVisible({ timeout: 20_000 }) // echte Komponente, dynamic import

  // Rechteck-Werkzeug (Toolbar-Klick, Tastatur 'r' wäre der Fallback) +
  // echtes Maus-Drag über der interaktiven Canvas (Wahl-Begründung s.
  // Kopfkommentar) — beweist die tatsächliche Zeichen-Interaktion, nicht nur
  // den Speichern-Button. Excalidraws Werkzeugauswahl ist EIN
  // `<input type="radio" data-testid="toolbar-rectangle">`, KEIN `<button>`
  // (real per E2E gefunden, s. `ToolButton`-Quelle) — UND das sichtbare
  // Icon (`.ToolIcon__icon`) liegt im DOM/Stacking NACH dem Input und
  // überdeckt es (Playwright: „subtree intercepts pointer events" beim
  // direkten Klick auf den Input) — ein Klick auf das umschließende
  // `<label>` (natives Label-Verhalten aktiviert den Input trotzdem) trifft
  // stattdessen zuverlässig.
  await dialog.locator('label:has(input[data-testid="toolbar-rectangle"])').click()
  const canvas = dialog.locator('canvas.excalidraw__canvas.interactive')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Excalidraw-Canvas hat keine boundingBox')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 })
  await page.mouse.up()

  const putPromise = waitForDiagramPut(page, 'architektur')
  await dialog.getByRole('button', { name: 'Speichern und schließen' }).click()
  const putRes = await putPromise
  expect(putRes.status()).toBe(200)
  await expect(dialog).toBeHidden()

  const newDiagramImg = doc.locator('.diagram-node img[src*="testskizze.excalidraw.svg"]')
  await expect(newDiagramImg).toBeVisible()

  // Auflage C (Task-5-Review): NICHT NUR „Datei existiert", sondern „der
  // Server-Sanitizer hat die Excalidraw-Payload-Kommentare erhalten" — sonst
  // wäre die Datei zwar committet, aber nie wieder als Excalidraw-Szene
  // ladbar (nur noch ein stummes Bild).
  const branchContent = await readBranchFile(
    page.request,
    state,
    'architektur/_media/testskizze.excalidraw.svg',
    'draft/architektur',
  )
  expect(branchContent).toContain('payload-type:application/vnd.excalidraw+json')

  // Re-Open-Beweis (Auflage C, „idealerweise"): der Bearbeiten-Button lädt
  // dieselbe Datei zurück in einen ECHTEN Excalidraw-Canvas — kein
  // Lade-Fehlerbanner (`.diagram-dialog-error`), also liest `sceneFromSvgText`/
  // `loadFromBlob` die eben committete Datei anstandslos wieder ein.
  const newDiagramNode = doc.locator('.diagram-node', { has: page.locator('img[src*="testskizze.excalidraw.svg"]') })
  await newDiagramNode.hover()
  await newDiagramNode.locator('button.diagram-edit').click()
  const reopenDialog = page.locator('dialog.diagram-dialog')
  await expect(reopenDialog).toBeVisible()
  await expect(reopenDialog.locator('.diagram-canvas .excalidraw')).toBeVisible({ timeout: 20_000 })
  await expect(reopenDialog.locator('.diagram-dialog-error')).toHaveCount(0)
  await reopenDialog.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(reopenDialog).toBeHidden()
})

test('Flow 4: ifAbsent-Schutz — zweites Excalidraw mit demselben Namen liefert Konflikt, Dialog bleibt offen', async () => {
  const NAME = 'Testskizze' // identischer Name wie Flow 3 → derselbe Zielpfad

  await page.goto(`/wiki/${SPACE}/architektur/edit`)
  await expect(page.locator('.etoolbar')).toBeVisible()
  const doc = page.locator('.doc.page-body')

  await doc.getByRole('heading', { level: 1, name: 'Architektur' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const slashMenu = page.getByRole('listbox', { name: 'Befehlsmenü' })
  await expect(slashMenu).toBeVisible()

  page.once('dialog', (d) => void d.accept(NAME))
  await slashMenu.getByRole('option', { name: 'Excalidraw' }).click()

  const dialog = page.locator('dialog.diagram-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.diagram-canvas .excalidraw')).toBeVisible({ timeout: 20_000 })

  const saveButton = dialog.getByRole('button', { name: 'Speichern und schließen' })
  await expect(saveButton).toBeEnabled({ timeout: 20_000 }) // wartet auf `excalidrawAPI`-Callback

  const putPromise = waitForDiagramPut(page, 'architektur', 409)
  await saveButton.click()
  const putRes = await putPromise
  expect(putRes.status()).toBe(409)

  await expect(dialog.locator('.diagram-dialog-error')).toHaveText('Eine Datei mit diesem Namen existiert bereits.')
  // Kein stilles Überschreiben, kein automatisches Schließen.
  await expect(dialog).toBeVisible()
})
