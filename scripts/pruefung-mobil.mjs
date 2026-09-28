// Bestandsaufnahme Telefon/Tablet (Issue #63): misst, wo die Anwendung auf
// schmalem Schirm bricht — es repariert nichts. Emulation als Regressionsnetz;
// die Abnahme am echten Gerät ersetzt es nicht (Browserleiste, Tastatur und
// Impulsscrollen gibt es in der Emulation nicht).
//
// Aufruf:  node scripts/pruefung-mobil.mjs [basis-url] [--seite <space>/<pageId>] [--json] [--streng]
//   basis-url  Standard: F451_PUBLIC_BASE_URL aus deploy/wiki/.env, sonst
//              http://localhost:8080. Muss die öffentliche Adresse sein, auf
//              die der OIDC-Rücksprung zeigt — sonst landet das Session-Cookie
//              auf dem anderen Host.
//   --seite    Beispielseite für Lese-, Editor- und Review-Ansicht; ohne Angabe
//              das erste Blatt im Baum des ersten Space
//   --json     Befunde als JSON statt als Liste
//   --streng   Exit-Code 1 bei harten Befunden (Regressionsnetz)
//   --bilder <verzeichnis>  legt je Messung ein Bildschirmfoto ab
// Anmeldung über Forgejo: FORGEJO_USER / FORGEJO_PASS (Standard wiki-admin / admin1234).
//
// Nebenwirkung: Die Editor-Ansicht legt beim Öffnen einen Entwurf an. Gab es
// vorher keinen, verwirft das Skript ihn danach wieder (DELETE …/draft).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium, devices } = require('@playwright/test')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
function oeffentlicheBasis() {
  try {
    const env = readFileSync(new URL('../deploy/wiki/.env', import.meta.url), 'utf8')
    return env.match(/^F451_PUBLIC_BASE_URL=(.+)$/m)?.[1].trim()
  } catch {
    return undefined
  }
}
const BASIS = (args.find((a, i) => !a.startsWith('--') && !['--seite', '--bilder'].includes(args[i - 1])) ?? oeffentlicheBasis() ?? 'http://localhost:8080').replace(/\/$/, '')
const USER = process.env.FORGEJO_USER ?? 'wiki-admin'
const PASS = process.env.FORGEJO_PASS ?? 'admin1234'

const GERAETE = [
  { name: 'Telefon 390', ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
  { name: 'Tablet 768', ...devices['iPad Mini'], viewport: { width: 768, height: 1024 } },
]
// iOS Safari blendet unten eine Leiste von rund 80 px ein; was dort sitzt,
// liegt bei `100vh`-Höhe hinter ihr (Issue #65). Wert ist eine Schätzung.
const BROWSERLEISTE_PX = 80
const ZIEL_PX = 44

/** Läuft im Browser: misst die aktuelle Ansicht. */
function messen({ browserleiste, ziel }) {
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  const name = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    const label = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}${label ? ` „${label}"` : ''}`
  }
  const sichtbar = (e) => {
    const s = getComputedStyle(e)
    const b = e.getBoundingClientRect()
    return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0
  }

  // 1. Waagerechter Überlauf — Dokument und innenliegende Scrollbereiche
  const ueberlauf = []
  const dokDiff = document.documentElement.scrollWidth - vw
  if (dokDiff > 0) {
    const schuld = [...document.querySelectorAll('body *')]
      .filter((e) => sichtbar(e) && e.getBoundingClientRect().right > vw + 1)
      // nur die äußersten Übeltäter, nicht jedes Kind darin
      .filter((e, _, alle) => !alle.some((a) => a !== e && a.contains(e)))
      .slice(0, 5)
      .map((e) => `${name(e)} (${Math.round(e.getBoundingClientRect().right - vw)} px)`)
    ueberlauf.push(`Dokument ${dokDiff} px breiter als der Schirm — ${schuld.join(', ') || 'Ursache unklar'}`)
  }
  for (const e of document.querySelectorAll('body *')) {
    if (!sichtbar(e)) continue
    const s = getComputedStyle(e)
    if (!/(auto|scroll)/.test(s.overflowX) && !/(auto|scroll)/.test(s.overflow)) continue
    const diff = e.scrollWidth - e.clientWidth
    if (diff > 1) ueberlauf.push(`Scrollbereich ${name(e)} scrollt seitlich (${diff} px)`)
  }

  // 2. Unerreichbare Bedienelemente — außerhalb des Schirms oder verdeckt.
  // Ist ein modaler Dialog offen, ist alles dahinter absichtlich unerreichbar;
  // gemessen wird dann nur der Dialog.
  const modal = [...document.querySelectorAll('dialog[open]')].find((d) => d.matches(':modal'))
  const wurzel = modal ?? document
  const bedien = [...wurzel.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])')].filter(sichtbar)
  const unerreichbar = []
  const zuKlein = []
  const unten = []
  for (const e of bedien) {
    const b = e.getBoundingClientRect()
    if (b.right <= 0 || b.left >= vw) {
      unerreichbar.push(`${name(e)} liegt außerhalb (x ${Math.round(b.left)})`)
      continue
    }
    const cx = Math.min(Math.max(b.left + b.width / 2, 0), vw - 1)
    const cy = b.top + b.height / 2
    // Im eigenen Scrollbereich weggescrollt ist nicht „verdeckt": Der Mittelpunkt
    // liegt dann außerhalb des sichtbaren Ausschnitts eines Vorfahren mit
    // eigenem Überlauf — erreichbar durch Scrollen.
    let weggescrollt = false
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (!/(auto|scroll|hidden)/.test(getComputedStyle(a).overflowY)) continue
      const r = a.getBoundingClientRect()
      if (cy < r.top || cy > r.bottom) { weggescrollt = true; break }
    }
    if (!weggescrollt && cy >= 0 && cy < vh) {
      const oben = document.elementFromPoint(cx, cy)
      if (oben && oben !== e && !e.contains(oben) && !oben.contains(e)) unerreichbar.push(`${name(e)} verdeckt von ${name(oben)}`)
    }
    // 3. Zielgrößen — das ::after-Trefferfeld (40-schaltflaeche.css) zählt mit
    const after = getComputedStyle(e, '::after')
    const h = Math.max(b.height, parseFloat(after.height) || 0)
    const w = Math.max(b.width, parseFloat(after.width) || 0)
    if (h < ziel || w < ziel) zuKlein.push(`${Math.round(w)}×${Math.round(h)} ${name(e)}`)
    // 5. Höhe — Bedienelemente im Streifen, den die Browserleiste verdeckt
    if (b.bottom > vh - browserleiste && b.top < vh) unten.push(name(e))
  }

  // 4. Überlappende und abgeschnittene Beschriftungen
  const blaetter = [...wurzel.querySelectorAll('a, button, li, td, th, p, span, h1, h2, h3, label, b, small')]
    .filter((e) => !e.childElementCount && e.textContent.trim() && sichtbar(e))
  const ueberlappung = []
  for (let i = 0; i < blaetter.length && ueberlappung.length < 8; i++) {
    const x = blaetter[i].getBoundingClientRect()
    for (let j = i + 1; j < blaetter.length; j++) {
      if (blaetter[i].contains(blaetter[j]) || blaetter[j].contains(blaetter[i])) continue
      const y = blaetter[j].getBoundingClientRect()
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left)
      const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top)
      if (w > 2 && h > 2) {
        ueberlappung.push(`${name(blaetter[i])} × ${name(blaetter[j])}`)
        break
      }
    }
  }
  const abgeschnitten = blaetter
    .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible')
    .slice(0, 8)
    .map((e) => `${name(e)} (${e.clientWidth} von ${e.scrollWidth} px sichtbar)`)

  const shell = document.querySelector('.shell')
  const scrollt = document.scrollingElement.scrollHeight > vh + 1
  return {
    ueberlauf,
    unerreichbar,
    zuKlein,
    ueberlappung,
    abgeschnitten,
    hoehe: {
      shellHoehe: shell ? Math.round(shell.getBoundingClientRect().height) : null,
      shellHoeheCss: shell ? getComputedStyle(shell).height : null,
      dokumentScrollt: scrollt,
      imLeistenstreifen: unten,
    },
  }
}

async function anmelden(seite) {
  await seite.goto(`${BASIS}/auth/login`, { waitUntil: 'domcontentloaded' })
  await seite.waitForURL(/\/(user\/login|login\/oauth)|:\d+\/?$/, { timeout: 20000 })
  if (/user\/login/.test(seite.url())) {
    await seite.fill('input[name="user_name"]', USER)
    await seite.fill('input[name="password"]', PASS)
    await seite.click('button[type="submit"], form button')
  }
  const erlauben = seite.locator('button:has-text("Authorize"), button#authorize-app, button[name="granted"]').first()
  if (await erlauben.count().catch(() => 0)) await erlauben.click().catch(() => {})
  await seite.waitForURL((u) => u.origin === new URL(BASIS).origin, { timeout: 20000 })
}

function erstesBlatt(knoten) {
  for (const k of knoten) {
    if (k.archived) continue
    if (!k.children?.length) return k
    const tief = erstesBlatt(k.children)
    if (tief) return tief
  }
  return null
}

async function beispielseite(anfrage) {
  const vorgabe = option('--seite')
  if (vorgabe) {
    const [space, pageId] = vorgabe.split('/')
    return { space, pageId }
  }
  const spaces = await (await anfrage.get(`${BASIS}/api/spaces`)).json()
  if (!Array.isArray(spaces) || !spaces.length) throw new Error('Keine Spaces sichtbar — Forgejo-Verknüpfung prüfen.')
  const baum = await (await anfrage.get(`${BASIS}/api/spaces/${spaces[0].id}/tree`)).json()
  const blatt = erstesBlatt(baum)
  if (!blatt) throw new Error(`Space ${spaces[0].id} hat keine Seite.`)
  return { space: spaces[0].id, pageId: blatt.id }
}

const befunde = []
const browser = await chromium.launch()
try {
  for (const geraet of GERAETE) {
    const { name: geraetName, ...kontextOptionen } = geraet
    const kontext = await browser.newContext(kontextOptionen)
    const seite = await kontext.newPage()
    const fehler = []
    seite.on('pageerror', (e) => fehler.push(String(e).slice(0, 120)))

    let status = null
    seite.on('response', (r) => {
      if (r.request().isNavigationRequest() && r.frame() === seite.mainFrame()) status = r.status()
    })
    const pruefe = async (ansicht, vorbereiten) => {
      fehler.length = 0
      status = null
      try {
        await vorbereiten()
        await seite.waitForLoadState('networkidle').catch(() => {})
        const r = await seite.evaluate(messen, { browserleiste: BROWSERLEISTE_PX, ziel: ZIEL_PX })
        const bilder = option('--bilder')
        if (bilder) await seite.screenshot({ path: `${bilder}/${geraetName}-${ansicht}.png`.replace(/\s+/g, '_') })
        befunde.push({ ansicht, geraet: geraetName, url: seite.url().replace(BASIS, ''), status, ...r, seitenfehler: [...fehler] })
      } catch (err) {
        befunde.push({ ansicht, geraet: geraetName, abbruch: String(err).split('\n')[0] })
      }
    }

    await pruefe('Anmeldung', () => seite.goto(BASIS + '/', { waitUntil: 'networkidle' }))
    await anmelden(seite)
    const { space, pageId } = await beispielseite(kontext.request)
    const seitenUrl = `${BASIS}/wiki/${space}/${pageId}`

    await pruefe('Leseansicht', () => seite.goto(seitenUrl, { waitUntil: 'networkidle' }))
    await pruefe('Space-Übersicht', () => seite.goto(`${BASIS}/wiki/${space}`, { waitUntil: 'networkidle' }))
    await pruefe('Suche', async () => {
      await seite.goto(seitenUrl, { waitUntil: 'networkidle' })
      await seite.keyboard.press('Control+k')
      await seite.locator('dialog.search-dialog[open]').waitFor({ timeout: 5000 })
    })
    const draftVorher = (await kontext.request.get(`${BASIS}/api/pages/${pageId}/draft`)).status()
    await pruefe('Editor', () => seite.goto(`${seitenUrl}/edit`, { waitUntil: 'networkidle' }))
    if (draftVorher === 404) await kontext.request.delete(`${BASIS}/api/pages/${pageId}/draft`).catch(() => {})
    await pruefe('Review', () => seite.goto(`${seitenUrl}/review`, { waitUntil: 'networkidle' }))
    await pruefe('Graph', () => seite.goto(`${BASIS}/wiki/${space}/graph`, { waitUntil: 'networkidle' }))
    for (const [werkzeug, pfad] of [['Werkzeug Bericht', 'report'], ['Werkzeug Schema', 'schema'], ['Werkzeug Vorlagen', 'templates']])
      await pruefe(werkzeug, () => seite.goto(`${BASIS}/wiki/${space}/${pfad}`, { waitUntil: 'networkidle' }))
    await pruefe('Einstellungen Verbindungen', () => seite.goto(`${BASIS}/einstellungen/verbindungen`, { waitUntil: 'networkidle' }))
    await pruefe('Einstellungen Erscheinungsbild', () => seite.goto(`${BASIS}/einstellungen/erscheinungsbild`, { waitUntil: 'networkidle' }))
    await kontext.close()
  }
} finally {
  await browser.close()
}

const hart = (b) => (b.abbruch ? 1 : 0) + (b.ueberlauf?.length ?? 0) + (b.unerreichbar?.length ?? 0) + (b.ueberlappung?.length ?? 0) + (b.seitenfehler?.length ?? 0)

if (flag('--json')) {
  console.log(JSON.stringify({ basis: BASIS, befunde }, null, 2))
} else {
  const liste = (titel, eintraege, max = 6) => {
    if (!eintraege?.length) return
    console.log(`  ${titel} (${eintraege.length})`)
    eintraege.slice(0, max).forEach((e) => console.log(`    - ${e}`))
    if (eintraege.length > max) console.log(`    … ${eintraege.length - max} weitere`)
  }
  for (const b of befunde) {
    console.log(`\n## ${b.ansicht} — ${b.geraet}${b.url ? `  (${b.url}${b.status && b.status !== 200 ? `, HTTP ${b.status}` : ''})` : ''}`)
    if (b.abbruch) {
      console.log(`  ABBRUCH: ${b.abbruch}`)
      continue
    }
    liste('Waagerechter Überlauf', b.ueberlauf)
    liste('Unerreichbar', b.unerreichbar)
    liste(`Zielgröße unter ${ZIEL_PX} px`, b.zuKlein, 4)
    liste('Überlappung', b.ueberlappung)
    liste('Abgeschnitten', b.abgeschnitten, 4)
    liste('Seitenfehler', b.seitenfehler)
    const h = b.hoehe
    console.log(`  Höhe: .shell ${h.shellHoeheCss ?? '—'}, Dokument scrollt: ${h.dokumentScrollt ? 'ja' : 'nein'}, Bedienelemente im Leistenstreifen: ${h.imLeistenstreifen.length}${h.imLeistenstreifen.length ? ' — ' + h.imLeistenstreifen.slice(0, 4).join(', ') : ''}`)
  }
  const summe = befunde.reduce((n, b) => n + hart(b), 0)
  console.log(`\n=== ${BASIS} — ${befunde.length} Messungen, ${summe} harte Befunde ===`)
}
process.exit(flag('--streng') && befunde.some((b) => hart(b) > 0) ? 1 : 0)
