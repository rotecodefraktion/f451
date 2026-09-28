import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Phase-2d-Abnahme (Task 8): die fünf End-to-End-Workflow-Flows aus dem
 * Task-Brief PLUS ein sechster (Reset-Recovery, aus dem Task-6-Review-Ledger
 * nachgetragen) gegen denselben Stack wie `lese-ui.spec.ts`/`editor.spec.ts`
 * (EIN `globalSetup`-Lauf für den gesamten Playwright-Prozess, `workers: 1` —
 * alle drei Spec-Dateien teilen sich Postgres/Forgejo/Mock-IdP/`next dev`).
 * Eigene, von `editor.spec.ts` UNBERÜHRTE Seiten (`workflow-*`, s.
 * `setup/start-stack.ts#seedRepo`), damit die Reihenfolge der Spec-Dateien
 * keine Rolle spielt.
 *
 * ZWEI ECHTE Identitäten (Brief: „Nutzer A" / „Nutzer B") in ZWEI getrennten
 * Browser-Kontexten (eigenes Session-Cookie je Kontext) — der Mock-IdP kennt
 * normalerweise nur EINE aktive Identität (`startMockIdp`); der eigens für
 * diesen Task ergänzte Test-Kontroll-Endpunkt `POST /test/user`
 * (`test/helpers/mock-idp.ts`) schaltet sie um, BEVOR sich der zweite Kontext
 * einloggt — danach bleiben beide Sessions über ihre Cookies unabhängig
 * voneinander bestehen, kein weiteres Umschalten nötig. Nutzer B ist ein
 * ECHTER zweiter Forgejo-Collaborator mit Schreibrecht (`setup/start-stack.ts`
 * Punkt 6c) — „Freigeben & mergen" ist damit kein Self-Review.
 *
 *   1. Voller Freigabe-Zyklus: A bearbeitet `workflow-a`, tippt einen Marker
 *      in den bestehenden Absatz (→ EIN `changed`-Block, Wort-Diff) →
 *      „Review anfordern" → Review-Seite zeigt `.chip.rev`, der Marker steht
 *      als `ins.add` im Diff, die Rail-Summary stimmt (1 geändert) → B
 *      (zweiter Kontext) öffnet dieselbe Review-Seite, „Freigeben & mergen"
 *      mit Kommentar → Leseansicht zeigt den Marker, Chip „Released",
 *      `GET .../draft` → 404, der Draft-Branch ist laut Forgejo-REST weg.
 *   2. Leseansichts-Hinweise: A bearbeitet `workflow-a` (jetzt released)
 *      erneut → Leseansicht zeigt `.notice.draft` + `.chip.work`; nach
 *      „Review anfordern" `.chip.rev` mit einem auf die Review-Route
 *      zeigenden Link.
 *   3. Konflikt-Flow: A legt auf `workflow-conflict` einen Draft mit Text X
 *      an, EIN direkter main-Commit (rohe Forgejo-REST-API, Admin/Seed-Token
 *      aus dem State-File — Interop-Pfad, kein `@f451/git-provider`-Import
 *      im Testprozess möglich, s. `setup/start-stack.ts`-Kopfkommentar)
 *      ändert dieselbe Quellzeile ANDERS → „Review anfordern" → Review-Seite
 *      zeigt `.notice.conflict`, Merge-Button disabled → „Entwurf
 *      aktualisieren" → „Meine Fassung behalten" → Notice verschwindet, der
 *      Diff zeigt weiter Text X → B gibt frei → Leseansicht enthält X.
 *   4. Neue Seite: „+ Neue Seite" im Baum → Titel → Editor öffnet mit
 *      `# <Titel>` → tippen → Review → B gibt frei → die Seite erscheint im
 *      Seitenbaum UND in der Leseansicht.
 *   5. Responsive: Review-Route bei 390×844 → kein horizontaler Scroll.
 *   6. Reset-Recovery (Task-6-Review-Ledger, zusätzlich zum Brief): ein
 *      `page.route`-Stub lässt `POST .../draft/update` mit 502 +
 *      `preservedContent` fehlschlagen (simuliert einen Provider-Ausfall
 *      GENAU im Fenster nach dem Verwerfen des alten Branches, s.
 *      `apps/api/src/drafts/update.ts#DraftUpdateContentLostError") →
 *      „Auf letzte Freigabe zurücksetzen" → der Recovery-Dialog zeigt den
 *      geretteten Inhalt → „Inhalt in den Editor übernehmen" stellt ihn im
 *      Editor wieder her.
 */
const SPACE = 'e2e-handbuch'

interface StackState {
  webOrigin: string
  apiUrl: string
  idpIssuer: string
  forgejoBaseUrl: string
  forgejoToken: string
  repoOwner: string
  repoName: string
  reviewer: { sub: string; email: string; name: string }
}

const STATE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '.stack-state.json')

function readStackState(): StackState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState
}

/** Forgejo-Contents-API-Pfad (identisch zu `packages/git-provider/src/forgejo.ts#encodePath`
 *  — hier lokal nachgebaut, da dieser Testprozess das Paket nicht importieren
 *  kann, s. Kopfkommentar). */
function forgejoContentsUrl(state: StackState, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${state.forgejoBaseUrl}/api/v1/repos/${state.repoOwner}/${state.repoName}/contents/${encoded}`
}

/** Liest main-Inhalt + Blob-Sha einer Datei direkt über die Forgejo-REST-API
 *  (Interop-Pfad, s. Kopfkommentar) — Grundlage für den direkten main-Commit
 *  in Flow 3, der die eigentliche Konflikt-Provokation ist (unsere eigene API
 *  hat absichtlich KEINEN Endpunkt, der main direkt beschreibt). */
async function readMainFile(request: APIRequestContext, state: StackState, path: string): Promise<{ content: string; sha: string }> {
  const res = await request.get(`${forgejoContentsUrl(state, path)}?ref=main`, {
    headers: { Authorization: `token ${state.forgejoToken}` },
  })
  expect(res.ok(), `Forgejo GET ${path}@main sollte 200 liefern`).toBe(true)
  const body = (await res.json()) as { content: string; sha: string }
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha }
}

async function writeMainFile(request: APIRequestContext, state: StackState, path: string, content: string, sha: string): Promise<void> {
  const res = await request.put(forgejoContentsUrl(state, path), {
    headers: { Authorization: `token ${state.forgejoToken}` },
    data: {
      branch: 'main',
      message: `e2e: direkter main-Commit (Konflikt-Provokation) — ${path}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha,
    },
  })
  expect(res.ok(), `Forgejo PUT ${path}@main sollte 2xx liefern`).toBe(true)
}

/** `true`, solange der Branch laut Forgejo noch existiert — Grundlage für die
 *  „Draft-Branch weg"-Assertion in Flow 1 (Cleanup-Beweis auf Provider-Ebene,
 *  nicht nur über unsere eigene Draft-API). */
async function forgejoBranchExists(request: APIRequestContext, state: StackState, branch: string): Promise<boolean> {
  const res = await request.get(
    `${state.forgejoBaseUrl}/api/v1/repos/${state.repoOwner}/${state.repoName}/branches/${encodeURIComponent(branch)}`,
    { headers: { Authorization: `token ${state.forgejoToken}` } },
  )
  return res.ok()
}

async function login(page: Page): Promise<void> {
  await page.goto('/wiki')
  await page.getByRole('link', { name: /Mit Microsoft Entra anmelden/i }).click()
  await page.waitForURL(new RegExp(`/wiki/${SPACE}`))
}

/** Flusht den Autosave über ⌘S (Brief: nie auf den 30s-Debounce warten) und
 *  wartet auf die Bestätigung in der Statuszeile — identisches Muster wie
 *  `editor.spec.ts`. */
async function saveNow(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.statusbar .saved')).toContainText('Zuletzt gespeichert', { timeout: 15_000 })
}

/** Tippt `marker` ans Ende des ERSTEN Absatzes (kein Enter davor) — bleibt
 *  dadurch derselbe Block wie im Ausgangsstand, der Diff-Engine matcht ihn
 *  per LCS an dieselbe Position → `kind: 'changed'` statt `'added'` (Flow 1
 *  braucht explizit den Wort-Diff-Pfad, `ins.add`, nicht einen neuen Block). */
async function appendToFirstParagraph(page: Page, marker: string): Promise<void> {
  const doc = page.locator('.doc.page-body')
  await doc.locator('p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(` ${marker}`)
}

test.describe.configure({ mode: 'serial' })

let state: StackState
let pageA: Page
let pageB: Page

test.beforeAll(async ({ browser }) => {
  state = readStackState()
  const contextA = await browser.newContext()
  pageA = await contextA.newPage()
  const contextB = await browser.newContext()
  pageB = await contextB.newPage()
})

test.afterAll(async () => {
  await pageA.context().close()
  await pageB.context().close()
})

test('Login: zwei getrennte Identitäten (Autorin A, Reviewerin B)', async () => {
  // A: Standard-Identität des Mock-IdP (unverändert seit `start-stack.ts`).
  await login(pageA)
  await expect(pageA.locator('button.avatar')).toBeVisible()

  // Mock-IdP auf die Reviewer-Identität umschalten (Test-Kontroll-Endpunkt,
  // s. Kopfkommentar) — WIRKT NUR auf den NÄCHSTEN Login, A bleibt über sein
  // bereits gesetztes Cookie unverändert eingeloggt.
  const switchRes = await pageA.request.post(`${state.idpIssuer}/test/user`, { data: state.reviewer })
  expect(switchRes.ok()).toBe(true)

  await login(pageB)
  await expect(pageB.locator('button.avatar')).toBeVisible()
})

test('Flow 1: Voller Freigabe-Zyklus — Review anfordern (A) → Freigeben & mergen (B)', async () => {
  const MARKER = 'E2E-WORKFLOW-FLOW1-6621'

  await pageA.goto(`/wiki/${SPACE}/workflow-a/edit`)
  await expect(pageA.locator('.etoolbar')).toBeVisible()
  await appendToFirstParagraph(pageA, MARKER)
  await saveNow(pageA)

  await pageA.getByRole('button', { name: 'Review anfordern' }).click()
  await pageA.waitForURL(new RegExp(`/wiki/${SPACE}/workflow-a/review`))

  await expect(pageA.locator('.chip.rev')).toContainText('In Review')
  // Wort-Diff: der getippte Marker steht als `ins.add` in einem `changed`-Block.
  await expect(pageA.locator('.dchange.chg ins.add')).toContainText(MARKER)
  await expect(pageA.locator('.rsum .s.add')).toHaveText('0')
  await expect(pageA.locator('.rsum .s.chg')).toHaveText('1')
  await expect(pageA.locator('.rsum .s.rm')).toHaveText('0')

  // Nutzer B (zweite Identität, zweiter Browser-Kontext) öffnet dieselbe
  // Review-Seite frisch und gibt frei.
  await pageB.goto(`/wiki/${SPACE}/workflow-a/review`)
  await expect(pageB.locator('.chip.rev')).toContainText('In Review')
  await pageB.locator('.commentbox').fill('Sieht gut aus, danke!')
  await pageB.getByRole('button', { name: 'Freigeben & mergen' }).click()
  await pageB.waitForURL(new RegExp(`/wiki/${SPACE}/workflow-a$`))

  await expect(pageB.locator('.page-body')).toContainText(MARKER)
  await expect(pageB.locator('.chip.rel')).toContainText('Released')

  // Cleanup bewiesen: Draft-API 404 UND der Branch existiert laut Forgejo
  // nicht mehr (API-Assertion über request-Context, kein UI-Umweg).
  const draftRes = await pageA.request.get('/api/pages/workflow-a/draft')
  expect(draftRes.status()).toBe(404)
  expect(await forgejoBranchExists(pageA.request, state, 'draft/workflow-a')).toBe(false)
})

test('Flow 2: Leseansichts-Hinweise — .notice.draft/.chip.work, danach .chip.rev mit Review-Link', async () => {
  const MARKER = 'E2E-WORKFLOW-FLOW2-7734'

  await pageA.goto(`/wiki/${SPACE}/workflow-a/edit`)
  await expect(pageA.locator('.etoolbar')).toBeVisible()
  await appendToFirstParagraph(pageA, MARKER)
  await saveNow(pageA)

  await pageA.goto(`/wiki/${SPACE}/workflow-a`)
  await expect(pageA.locator('.notice.draft')).toBeVisible()
  await expect(pageA.locator('.notice.draft')).toContainText('noch nicht freigegeben')
  await expect(pageA.locator('.chip.work')).toContainText('Entwurf')

  await pageA.goto(`/wiki/${SPACE}/workflow-a/edit`)
  await pageA.getByRole('button', { name: 'Review anfordern' }).click()
  await pageA.waitForURL(new RegExp(`/wiki/${SPACE}/workflow-a/review`))

  await pageA.goto(`/wiki/${SPACE}/workflow-a`)
  await expect(pageA.locator('.chip.rev')).toContainText('In Review')
  await expect(pageA.locator('.notice.draft')).toContainText('im Review')
  await expect(pageA.locator('.notice.draft a')).toHaveAttribute('href', new RegExp(`/wiki/${SPACE}/workflow-a/review$`))
})

test('Flow 3: Konflikt — .notice.conflict blockiert den Merge, „Entwurf aktualisieren" → keep-mine löst ihn sichtbar', async () => {
  // Bewusst je EIN zusammenhängendes alphanumerisches Token OHNE Bindestriche:
  // die Wort-Diff-Engine trennt an Wortgrenzen (Bindestriche zählen als
  // Grenze) — zwei bindestrich-getrennte Marker mit gemeinsamem Präfix (wie
  // an anderer Stelle in dieser Datei) würden HIER wortweise verschachtelt
  // dargestellt (del/ins im Wechsel je Teilwort) statt als EIN zusammen-
  // hängender Insertions-Block, und `TEXT_X` stünde dann nicht als
  // durchgehende Zeichenkette im Diff (in einem Testlauf real beobachtet).
  const TEXT_X = 'E2EKonfliktMarkerX8845'
  const MAIN_DIRECT = 'MainDirektMarkerY9956'
  const ORIGINAL_LINE = 'Ursprüngliche Konfliktzeile für den Test.'

  // A: Draft anlegen, Text X in dieselbe Zeile schreiben, die gleich darauf
  // DIREKT auf main geändert wird (garantierter Zeilenkonflikt beim Merge).
  await pageA.goto(`/wiki/${SPACE}/workflow-conflict/edit`)
  await expect(pageA.locator('.etoolbar')).toBeVisible()
  await appendToFirstParagraph(pageA, TEXT_X)
  await saveNow(pageA)

  const pageInfo = (await (await pageA.request.get('/api/pages/workflow-conflict')).json()) as { path: string }
  const mainFile = await readMainFile(pageA.request, state, pageInfo.path)
  expect(mainFile.content).toContain(ORIGINAL_LINE)
  await writeMainFile(
    pageA.request,
    state,
    pageInfo.path,
    mainFile.content.replace(ORIGINAL_LINE, `${ORIGINAL_LINE} ${MAIN_DIRECT}`),
    mainFile.sha,
  )

  await pageA.getByRole('button', { name: 'Review anfordern' }).click()
  await pageA.waitForURL(new RegExp(`/wiki/${SPACE}/workflow-conflict/review`))

  // Der Konflikt muss von Forgejo erst berechnet werden — `POST /review`
  // pollt das bereits serverseitig (s. `apps/api/src/routes/workflow.ts`),
  // ein Reload-Retry fängt den seltenen Rest-Fall ab, in dem die Review-Seite
  // (die selbst NICHT pollt) trotzdem noch den alten `mergeable:null`-Stand liest.
  await expect(async () => {
    await pageA.reload()
    await expect(pageA.locator('.notice.conflict')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 20_000 })

  const mergeBtn = pageA.getByRole('button', { name: 'Freigeben & mergen' })
  await expect(mergeBtn).toBeDisabled()

  await pageA.getByRole('button', { name: 'Entwurf aktualisieren' }).click()
  const updateDialog = pageA.getByRole('dialog', { name: 'Entwurf aktualisieren' })
  await expect(updateDialog).toBeVisible()
  await updateDialog.getByRole('button', { name: 'Meine Fassung behalten' }).click()

  await expect(pageA.locator('.notice.conflict')).toBeHidden()
  await expect(mergeBtn).toBeEnabled()
  await expect(pageA.locator('.dchange').filter({ hasText: TEXT_X })).toBeVisible()

  // B gibt frei — Leseansicht enthält Text X.
  await pageB.goto(`/wiki/${SPACE}/workflow-conflict/review`)
  await pageB.getByRole('button', { name: 'Freigeben & mergen' }).click()
  await pageB.waitForURL(new RegExp(`/wiki/${SPACE}/workflow-conflict$`))
  await expect(pageB.locator('.page-body')).toContainText(TEXT_X)
})

test('Flow 4: Neue Seite — „+ Neue Seite" → Editor mit Titel-Heading → Review → Freigeben (B) → im Baum + Leseansicht', async () => {
  const TITLE = 'Workflow Neue Seite E2E'
  const MARKER = 'E2E-WORKFLOW-FLOW4-3312'

  await pageA.goto(`/wiki/${SPACE}/workflow-a`)
  await pageA.getByRole('button', { name: 'Neue Seite anlegen' }).click()
  const newPageDialog = pageA.getByRole('dialog', { name: 'Neue Seite anlegen' })
  await expect(newPageDialog).toBeVisible()
  await newPageDialog.getByLabel('Titel').fill(TITLE)
  await newPageDialog.getByRole('radio', { name: 'Space-Wurzel' }).check()
  await newPageDialog.getByRole('button', { name: 'Anlegen' }).click()

  await pageA.waitForURL(new RegExp(`/wiki/${SPACE}/[^/]+/edit$`))
  // Bewusst der ROHE (bereits URL-kodierte) Pfadsegment-String, NICHT
  // dekodiert: neue Seiten haben KEIN Frontmatter-`id` (s.
  // `apps/api/src/drafts/create-page.ts`), ihre Id ist der Fallback
  // `path:<space>/<Pfad>` (`:`/`/` enthalten) — als EIN URL-Segment
  // `encodeURIComponent`-kodiert (`lib/urls.ts#wikiPageHref`). Ein Decode+Neubau
  // per Template-String würde die enthaltenen `/` als ZUSÄTZLICHE Pfadsegmente
  // in die nächste URL einschleusen (in einem Testlauf real beobachtet:
  // `waitForURL` traf nie, weil die erwartete Regex unkodierte Literalzeichen
  // gegen eine tatsächlich kodierte URL prüfte) — das rohe Segment bleibt
  // deshalb unverändert wiederverwendbar.
  const encodedPageId = new URL(pageA.url()).pathname.split('/')[3]!

  await expect(pageA.locator('.etoolbar')).toBeVisible()
  const doc = pageA.locator('.doc.page-body')
  await expect(doc.getByRole('heading', { level: 1, name: TITLE })).toBeVisible()

  await doc.getByRole('heading', { level: 1, name: TITLE }).click()
  await pageA.keyboard.press('End')
  await pageA.keyboard.press('Enter')
  await pageA.keyboard.type(MARKER)
  await saveNow(pageA)

  await pageA.getByRole('button', { name: 'Review anfordern' }).click()
  await pageA.waitForURL(new RegExp(`/wiki/${SPACE}/${encodedPageId}/review`))

  await pageB.goto(`/wiki/${SPACE}/${encodedPageId}/review`)
  await pageB.getByRole('button', { name: 'Freigeben & mergen' }).click()
  // Web-first auf ein leseansicht-eigenes Element warten (`.chip.rel` existiert
  // NUR auf der Leseansicht, nie auf der Review-Seite) statt nur auf die URL —
  // robuster gegen einen rein clientseitigen Soft-Navigation-Zwischenstand.
  await expect(pageB.locator('.chip.rel')).toBeVisible({ timeout: 20_000 })

  await expect(pageB.locator('nav.tree').getByRole('link', { name: TITLE })).toBeVisible()
  await expect(pageB.locator('.page-body')).toContainText(MARKER)
})

test('Flow 5: Responsive — Review-Route bei 390×844 ohne horizontalen Scroll', async () => {
  const MARKER = 'E2E-WORKFLOW-FLOW5-4423'

  await pageA.goto(`/wiki/${SPACE}/workflow-responsive/edit`)
  await expect(pageA.locator('.etoolbar')).toBeVisible()
  await appendToFirstParagraph(pageA, MARKER)
  await saveNow(pageA)
  await pageA.getByRole('button', { name: 'Review anfordern' }).click()
  await pageA.waitForURL(new RegExp(`/wiki/${SPACE}/workflow-responsive/review`))

  await pageA.setViewportSize({ width: 390, height: 844 })
  await pageA.reload()
  await expect(pageA.locator('.chip.rev')).toBeVisible()

  const scrollWidth = await pageA.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(390)

  // Für die folgenden Flows zurück auf die Standardgröße.
  await pageA.setViewportSize({ width: 1280, height: 900 })
})

test('Flow 6: Reset-Recovery — Zurücksetzen schlägt fehl (502-Stub), Recovery-Dialog stellt den geretteten Inhalt wieder her', async () => {
  const MARKER = 'E2E-WORKFLOW-FLOW6-GERETTET-5534'
  const preservedContent = `---\nid: workflow-reset\ntitle: Workflow Reset\nlang: de\ntags: [workflow]\n---\n# Workflow Reset\n\n${MARKER} — dieser Text stand kurz vor dem fehlgeschlagenen Zurücksetzen im Entwurf.\n`

  await pageA.goto(`/wiki/${SPACE}/workflow-reset/edit`)
  await expect(pageA.locator('.etoolbar')).toBeVisible()

  // Netzwerk-Stub (Task-6-Review-Ledger): `POST .../draft/update` schlägt mit
  // 502 fehl, GENAU wie `DraftUpdateContentLostError` es real tut (der alte
  // Branch ist zu diesem Zeitpunkt bereits weg, `preservedContent` ist die
  // einzige Rettung) — simuliert hier über einen Route-Abfang statt einen
  // echten Provider-Ausfall zu provozieren.
  await pageA.route('**/api/pages/*/draft/update', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        reason: 'Provider-Fehler: simulierter Ausfall (E2E Flow 6)',
        preservedContent,
      }),
    })
  })

  await pageA.getByRole('button', { name: 'Verwerfen' }).click()
  pageA.once('dialog', (dialog) => dialog.accept())
  await pageA.getByRole('menuitem', { name: 'Auf letzte Freigabe zurücksetzen' }).click()

  const recoveryDialog = pageA.getByRole('dialog', { name: 'Zurücksetzen fehlgeschlagen' })
  await expect(recoveryDialog).toBeVisible()
  await expect(recoveryDialog.locator('pre')).toContainText(MARKER)

  await recoveryDialog.getByRole('button', { name: 'Inhalt in den Editor übernehmen' }).click()
  await expect(recoveryDialog).toBeHidden()
  await expect(pageA.locator('.doc.page-body')).toContainText(MARKER)

  await pageA.unroute('**/api/pages/*/draft/update')
})
