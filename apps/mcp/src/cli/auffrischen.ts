/**
 * Auffrisch-Lauf für Diagramme (MCP-Anhänge, Paket 7, Issue #72).
 *
 * Zeichnet die Diagramme des Generators in einem Space mit den aktuellen
 * Diagramm-Tokens neu. Fremde Diagramme (Import, von Hand) bleiben unberührt —
 * Entscheidung #72: Die Import-Diagramme behalten ihre Palette.
 *
 * Geschrieben wird wie von einem Menschen: über die HTTP-API, mit dem eigenen
 * API-Token, über den Review-Workflow (Entscheidung #72). Je Seite ein Entwurf
 * mit allen veralteten Diagrammen darin, danach ein Review; die Freigabe
 * bleibt beim Menschen. Eine Seite, für die schon ein Entwurf offen ist, lässt
 * der Lauf aus: Er schriebe sonst in fremde, unfertige Arbeit und legte sie
 * mit dem Review zur Freigabe vor.
 *
 * Aufruf (ohne --schreiben nur Bericht, nichts wird geändert):
 *   F451_API_URL=http://localhost:8080 F451_TOKEN=f451_pat_… \
 *     pnpm --filter @f451/mcp auffrischen -- --space handbuch [--schreiben]
 * Der Token braucht Scope „write" und ein verknüpftes Forgejo-/GitHub-Konto.
 */
import { apiRequest, F451Error } from '../client.js'
import { generateDiagram } from '../diagram/generate.js'
import { normalform, specAusSvg } from '../diagram/reverse.js'

interface TreeNode {
  id: string
  title: string
  children: TreeNode[]
}

const args = process.argv.slice(2)
const space = args[args.indexOf('--space') + 1]
const schreiben = args.includes('--schreiben')
const token = process.env.F451_TOKEN

if (!space || args.indexOf('--space') < 0 || !token) {
  console.error('Aufruf: F451_TOKEN=f451_pat_… auffrischen --space <space> [--schreiben]')
  process.exit(2)
}

/**
 * Gedrosselter Aufruf: Das Anfragebudget für API-Tokens zählt pro Nutzer
 * (#73, Standard 300/min). Ein Space mit 70 Seiten und 100 Diagrammen braucht
 * mehr — ungedrosselt bräche der Lauf nach einer Minute ab. Deshalb höchstens
 * eine Anfrage je 220 ms, und bei 429 abwarten statt abbrechen.
 */
let letzte = 0
async function api<T>(pfad: string, options?: Parameters<typeof apiRequest>[2]): Promise<T> {
  for (let versuch = 0; ; versuch++) {
    const warten = letzte + 220 - Date.now()
    if (warten > 0) await new Promise((r) => setTimeout(r, warten))
    letzte = Date.now()
    try {
      return await apiRequest<T>(token!, pfad, options)
    } catch (err) {
      if (!(err instanceof F451Error && err.status === 429) || versuch >= 3) throw err
      await new Promise((r) => setTimeout(r, 15_000))
    }
  }
}

const seiten = (knoten: TreeNode[]): TreeNode[] => knoten.flatMap((k) => [k, ...seiten(k.children ?? [])])
const enc = encodeURIComponent

async function main(): Promise<void> {
  const baum = await api<TreeNode[]>(`/api/spaces/${enc(space!)}/tree`)
  const zaehler = { aktuell: 0, veraltet: 0, fremd: 0, fehler: 0 }

  for (const seite of seiten(baum)) {
    const text = await api<string>(`/api/pages/${enc(seite.id)}/raw`, { accept: 'text' })
    const pfade = [...new Set([...text.matchAll(/\]\((?:\.\/)?(_media\/[^)\s]+\.drawio\.svg)\)/g)].map((m) => m[1]!))]
    const veraltet: Array<{ pfad: string; neu: string }> = []

    for (const pfad of pfade) {
      const datei = pfad.slice('_media/'.length).split('/').map(enc).join('/')
      let svg: string
      try {
        svg = await api<string>(`/media/${enc(seite.id)}/${datei}`, { accept: 'text' })
      } catch (err) {
        zaehler.fehler++
        console.log(`  FEHLER    ${seite.title} · ${pfad}: ${err instanceof Error ? err.message : err}`)
        continue
      }
      const spec = specAusSvg(svg)
      if (!spec) {
        zaehler.fremd++
        continue
      }
      const neu = generateDiagram(spec)
      // In Normalform vergleichen — der Sanitizer serialisiert beim Speichern neu.
      if (normalform(neu) === normalform(svg)) {
        zaehler.aktuell++
        continue
      }
      zaehler.veraltet++
      veraltet.push({ pfad, neu })
      console.log(`  veraltet  ${seite.title} · ${pfad}`)
    }

    if (!schreiben || veraltet.length === 0) continue

    // Offener Entwurf → auslassen (s. Kopfkommentar). 404 heißt: keiner da.
    try {
      await api(`/api/pages/${enc(seite.id)}/draft`)
      console.log(`  AUSGELASSEN ${seite.title}: Es ist bereits ein Entwurf offen.`)
      continue
    } catch (err) {
      if (!(err instanceof F451Error && err.status === 404)) throw err
    }

    await api(`/api/pages/${enc(seite.id)}/draft`, { method: 'POST' })
    for (const { pfad, neu } of veraltet) {
      await api(`/api/pages/${enc(seite.id)}/draft/diagram`, {
        method: 'PUT',
        body: { path: pfad, content: neu },
      })
    }
    const review = await api<{ number: number; url: string }>(`/api/pages/${enc(seite.id)}/review`, {
      method: 'POST',
      body: {},
    })
    console.log(`  REVIEW    ${seite.title}: #${review.number} ${review.url}`)
  }

  console.log(
    `\n${space}: ${zaehler.aktuell} aktuell, ${zaehler.veraltet} veraltet, ${zaehler.fremd} fremd (nicht angefasst), ${zaehler.fehler} Fehler`
      + (schreiben ? '' : '\nNur Bericht — mit --schreiben werden Entwürfe und Reviews angelegt.'),
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
