// EINE Prüfung für alles, vom Orchestrator, am Ende. Läuft gegen den gebauten Stack.
// Aufruf: node pruefung.mjs [basis-url]
import { chromium } from 'playwright'

const BASIS = process.argv[2] ?? 'http://localhost:8080'
const BREITEN = [1600, 1200, 800]
const befunde = []
const melde = (schwere, wo, was) => befunde.push({ schwere, wo, was })

const browser = await chromium.launch()
const seite = await browser.newPage()
seite.on('console', (m) => { if (m.type() === 'error') melde('hart', 'Konsole', m.text().slice(0, 90)) })
seite.on('pageerror', (e) => melde('hart', 'Seitenfehler', String(e).slice(0, 90)))

for (const pfad of ['/', '/wiki']) {
  for (const breite of BREITEN) {
    await seite.setViewportSize({ width: breite, height: 1000 })
    const a = await seite.goto(BASIS + pfad, { waitUntil: 'networkidle' })
    if (!a || a.status() >= 400) { melde('hart', `${pfad} @${breite}`, `HTTP ${a?.status()}`); continue }

    const r = await seite.evaluate(() => {
      const d = document.documentElement
      const ausserhalb = [...document.querySelectorAll('*')].filter((e) => {
        const b = e.getBoundingClientRect()
        return b.width > 0 && (b.right > d.clientWidth + 1 || b.left < -1)
      }).slice(0, 3).map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''))

      // überlappende Textknoten
      const blaetter = [...document.querySelectorAll('a,button,li,td,th,p,span,h1,h2,h3')]
        .filter((e) => !e.childElementCount && e.textContent.trim())
      const ueber = []
      for (let i = 0; i < blaetter.length && ueber.length < 3; i++)
        for (let j = i + 1; j < blaetter.length; j++) {
          const x = blaetter[i].getBoundingClientRect(), y = blaetter[j].getBoundingClientRect()
          if (x.width < 2 || y.width < 2) continue
          const w = Math.min(x.right, y.right) - Math.max(x.left, y.left)
          const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top)
          if (w > 2 && h > 2) { ueber.push(`"${blaetter[i].textContent.trim().slice(0,18)}" x "${blaetter[j].textContent.trim().slice(0,18)}"`); break }
        }

      // Fokusring + Zielgröße
      const ohneRing = [], zuKlein = []
      for (const e of [...document.querySelectorAll('a[href],button:not([disabled]),input,select')].slice(0, 40)) {
        e.focus()
        const s = getComputedStyle(e)
        const n = e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')
        if (document.activeElement === e && !((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none')) ohneRing.push(n)
        const b = e.getBoundingClientRect(), na = getComputedStyle(e, '::after')
        const hh = Math.max(b.height, parseFloat(na.height) || 0), ww = Math.max(b.width, parseFloat(na.width) || 0)
        if (hh > 0 && (hh < 44 || ww < 44)) zuKlein.push(`${Math.round(ww)}x${Math.round(hh)} ${n}`)
      }
      return { diff: d.scrollWidth - d.clientWidth, ausserhalb, ueber, ohneRing, zuKlein }
    })

    if (r.diff > 0) melde('hart', `${pfad} @${breite}`, `Überlauf ${r.diff}px — ${r.ausserhalb.join(', ')}`)
    r.ueber.forEach((u) => melde('hart', `${pfad} @${breite}`, `Textüberlappung ${u}`))
    r.ohneRing.slice(0, 3).forEach((f) => melde('hart', `${pfad} @${breite}`, `kein Fokusring: ${f}`))
    r.zuKlein.slice(0, 4).forEach((z) => melde('weich', `${pfad} @${breite}`, `Zielgröße ${z}`))
  }
}

// Merkmale des Entwurfs im ausgelieferten CSS
const css = await seite.evaluate(async () => {
  const u = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href)
  return (await Promise.all(u.map((x) => fetch(x).then((r) => r.text()).catch(() => '')))).join('\n')
})
for (const [name, pat] of [['Papierweiß', '#fffdf8'], ['Zinnober', '#b3341c'], ['Serifen', 'Iowan Old Style'],
  ['Gliederungsziffer', 'counter(sec)'], ['Daumenregister', 'pane-edge'], ['Kolumnentitel', 'runhead'],
  ['Breitenstufe voll', '--measure-full']])
  if (!css.includes(pat)) melde('hart', 'ausgeliefertes CSS', `fehlt: ${name}`)

await browser.close()
const hart = befunde.filter((b) => b.schwere === 'hart')
const weich = befunde.filter((b) => b.schwere === 'weich')
console.log(`\n=== ${BASIS} — ${hart.length} harte, ${weich.length} weiche Befunde ===\n`)
hart.forEach((b) => console.log(`  HART   ${b.wo.padEnd(22)} ${b.was}`))
weich.slice(0, 10).forEach((b) => console.log(`  weich  ${b.wo.padEnd(22)} ${b.was}`))
if (weich.length > 10) console.log(`  … ${weich.length - 10} weitere weiche`)
process.exit(hart.length ? 1 : 0)
