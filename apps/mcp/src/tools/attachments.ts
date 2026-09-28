/**
 * Anhänge (`2026-07-27-mcp-anhaenge-design.md`): ein Diagramm erzeugen, eine
 * Datei anhängen.
 *
 * Zwei Werkzeuge mit deutlich verschiedenem Zuschnitt, weil die zugrunde
 * liegenden Probleme verschieden sind:
 *
 * - **`save_diagram`** nimmt eine BESCHREIBUNG entgegen und erzeugt daraus die
 *   fertige Zeichnung im Hausstil. Der Agent beschreibt den Prozess, nicht die
 *   Grafik. Das Ergebnis geht als Text über die bestehende JSON-Route — kein
 *   Binärtransport, kein Base64.
 * - **`attach_file`** transportiert NICHTS. Es gibt dem Agenten den fertigen
 *   Befehl an die Hand, mit dem er die Datei aus seiner eigenen Umgebung
 *   hochlädt. Der Grund ist Sparsamkeit: Ein Bildschirmabzug dieses Projekts
 *   ist 100 bis 160 KB groß, als Base64 im Werkzeugaufruf sind das 35.000 bis
 *   55.000 Tokens — die durch das Kontextfenster des Agenten laufen, bevor sie
 *   den Dienst erreichen. Ein Artikel mit fünf Abzügen kostete damit eine
 *   Viertelmillion Tokens allein für den Transport.
 *
 * Der Preis der zweiten Entscheidung ist bekannt und akzeptiert: Agenten ohne
 * Kommandozeile können keine Dateien anhängen. Die Antwort sagt das
 * ausdrücklich, statt sie in eine Ablehnung laufen zu lassen.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { tokenFromExtra } from '../auth.js'
import { apiRequest, F451Error } from '../client.js'
import { generateDiagram, validateDiagram, type DiagramSpec } from '../diagram/generate.js'
import { guard } from './read.js'

/** Die Endung, die `PUT /api/pages/:id/draft/diagram` für draw.io-Diagramme verlangt. */
const DIAGRAM_SUFFIX = '.drawio.svg'

/**
 * Erlaubte Dateiendungen — Spiegel der Whitelist in
 * `apps/api/src/drafts/upload.ts`.
 *
 * Eine Kopie, und das ist hier die kleinere Sünde: Die API bietet keinen
 * Endpunkt, der ihre Grenzen nennt, und ein Agent, der sie erst durch eine
 * Ablehnung erfährt, hat die Datei bereits hochgeladen. Läuft die Liste
 * auseinander, ist die Folge eine überflüssige 415 — kein Datenverlust.
 */
const ERLAUBTE_ENDUNGEN = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'pdf', 'docx', 'xlsx', 'pptx', 'zip', 'txt', 'csv', 'md',
]

const BILD_ENDUNGEN = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/**
 * Größengrenze in MB.
 *
 * Der Dienst kennt die Einstellung der API nicht (sie steht dort in
 * `F451_MAX_UPLOAD_MB`); wo beide im selben Stack laufen, ist die Variable
 * meist auch hier gesetzt. Ohne sie gilt die Voreinstellung der API, und die
 * Antwort sagt dazu, dass ein Betreiber sie verschoben haben kann.
 */
const MAX_UPLOAD_MB = Number(process.env.F451_MAX_UPLOAD_MB ?? 10)

const edgeSchema = z.object({
  from: z.string().min(1).describe('Kennung des Schritts, von dem die Verbindung ausgeht.'),
  to: z.string().min(1).describe('Kennung des Schritts, zu dem sie führt.'),
  label: z.string().optional().describe('Beschriftung der Verbindung, z.B. "ja" oder "abgelehnt".'),
})

const swimlaneSchema = z.object({
  kind: z.literal('swimlane'),
  lanes: z
    .array(z.string().min(1))
    .min(1)
    .describe('Die Bahnen (Zuständigkeiten) von oben nach unten, z.B. ["Fachbereich", "Betrieb"].'),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).describe('Eindeutige Kennung des Schritts, für die Verbindungen.'),
        label: z.string().min(1).describe('Beschriftung im Kasten.'),
        lane: z.number().int().min(0).describe('Nullbasierter Index der Bahn, in der der Schritt liegt.'),
        kind: z
          .enum(['step', 'terminal'])
          .optional()
          .describe('"terminal" für Anfang und Ende der Kette, sonst weglassen.'),
      }),
    )
    .min(1)
    .describe(
      'Die Schritte IN DER REIHENFOLGE DER PROZESSKETTE. Die waagerechte Lage rechnet der Dienst daraus — '
        + 'Koordinaten werden nicht angegeben.',
    ),
  edges: z.array(edgeSchema).describe('Verbindungen zwischen den Schritten.'),
})

const flowSchema = z.object({
  kind: z.literal('flow'),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).describe('Eindeutige Kennung des Knotens.'),
        label: z.string().min(1).describe('Beschriftung im Kasten bzw. in der Raute.'),
        kind: z
          .enum(['terminal', 'step', 'decision'])
          .describe('"terminal" = Anfang/Ende, "step" = Schritt, "decision" = Verzweigung.'),
        x: z.number().describe('Waagerechte Lage der linken oberen Ecke.'),
        y: z.number().describe('Senkrechte Lage der linken oberen Ecke.'),
        w: z.number().optional().describe('Abweichende Breite; ohne Angabe das Hausmaß.'),
        h: z.number().optional().describe('Abweichende Höhe; ohne Angabe das Hausmaß.'),
      }),
    )
    .min(1)
    .describe(
      'Die Knoten mit ihren Koordinaten. Anders als beim Bahnendiagramm ordnet der Dienst hier NICHT selbst an — '
        + 'Verzweigungen sauber zu platzieren ist ein eigenes Problem. Als Anhalt: Zeilenabstand 70, Kastenbreite 170.',
    ),
  edges: z.array(edgeSchema).describe('Verbindungen zwischen den Knoten.'),
})

export function registerAttachmentTools(server: McpServer): void {
  server.registerTool(
    'save_diagram',
    {
      title: 'Diagramm erzeugen und im Entwurf ablegen',
      description:
        'Erzeugt aus einer BESCHREIBUNG des Ablaufs ein Diagramm im Hausstil des Wikis und legt es im Entwurf '
        + 'der Seite ab (`<Seitenordner>/_media/<name>.drawio.svg`). Es wird KEIN fertiges SVG erwartet — der '
        + 'Dienst zeichnet, damit Grafik und eingebettetes mxGraph-XML deckungsgleich bleiben und das Diagramm '
        + 'im Editor bearbeitbar ist. Zwei Arten: "swimlane" (Prozessablauf über Zuständigkeiten; die Anordnung '
        + 'rechnet der Dienst aus der Reihenfolge der Schritte) und "flow" (Programmablauf mit Verzweigungen; '
        + 'hier setzt der Aufrufer die Koordinaten). Voraussetzung: Für die Seite muss ein Entwurf offen sein '
        + '(sonst zuerst edit_page bzw. create_page). Liefert Ablagepfad und den Markdown-Schnipsel zum Einfügen.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID.'),
        name: z
          .string()
          .min(1)
          .describe('Dateiname ohne Endung, z.B. "freigabeablauf". Die Endung .drawio.svg wird angehängt.'),
        title: z.string().optional().describe('Alternativtext des Bildes im Markdown; ohne Angabe der Dateiname.'),
        diagram: z.discriminatedUnion('kind', [swimlaneSchema, flowSchema]).describe('Die Beschreibung des Ablaufs.'),
        ifAbsent: z
          .boolean()
          .optional()
          .describe(
            'true = nur anlegen, ein vorhandenes Diagramm gleichen Namens NICHT überschreiben (Antwort dann 409). '
              + 'Sinnvoll, wenn fremde Arbeit an derselben Stelle liegen könnte.',
          ),
      },
    },
    async ({ id, name, title, diagram, ifAbsent }, extra) =>
      guard(async () => {
        const spec = diagram as DiagramSpec

        // Zuerst prüfen, dann zeichnen: Eine Verbindung auf einen Schritt, den
        // es nicht gibt, soll eine Klartextmeldung ergeben — keine kaputte
        // Grafik im Repository und keinen technischen Fehler, aus dem der
        // Agent nicht schließen kann, was er falsch gemacht hat.
        const fehler = validateDiagram(spec)
        if (fehler.length > 0) {
          throw new Error(
            `Die Diagrammbeschreibung ist nicht schlüssig — es wurde nichts gespeichert:\n- ${fehler.join('\n- ')}`,
          )
        }

        const dateiname = name.endsWith(DIAGRAM_SUFFIX) ? name : `${name}${DIAGRAM_SUFFIX}`
        const pfad = `_media/${dateiname}`
        const svg = generateDiagram(spec)

        await apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/draft/diagram`, {
          method: 'PUT',
          body: { path: pfad, content: svg, ...(ifAbsent === undefined ? {} : { ifAbsent }) },
        })

        const markdown = `![${title ?? name}](${pfad})`
        return (
          `Diagramm gespeichert: ${pfad}\n\n`
          + `Zum Einfügen in den Seitentext (mit update_page_draft):\n${markdown}\n\n`
          + 'Der Pfad ist seitenrelativ — genau so gehört er in den Markdown-Text.'
        )
      }),
  )

  server.registerTool(
    'attach_file',
    {
      title: 'Datei anhängen — Anleitung statt Transport',
      description:
        'Erklärt, wie eine Datei (Bildschirmabzug, PDF, Tabelle …) an den Entwurf einer Seite angehängt wird, '
        + 'und liefert den fertig zusammengesetzten Befehl für die Kommandozeile samt Markdown-Schnipsel. '
        + 'Dieses Werkzeug überträgt die Datei NICHT — Binärdaten durch das Kontextfenster zu schleusen wäre um '
        + 'Größenordnungen teurer als der Upload selbst. Wer keine Kommandozeile hat, kann Dateien nicht anhängen '
        + 'und sollte einen Menschen darum bitten; Diagramme dagegen gehen ohne Umweg über save_diagram.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID.'),
        filename: z.string().min(1).describe('Dateiname mit Endung, z.B. "anmeldemaske.png".'),
      },
    },
    async ({ id, filename }, extra) =>
      guard(async () => {
        const endung = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
        const grenzen =
          `Erlaubte Endungen: ${ERLAUBTE_ENDUNGEN.join(', ')}. `
          + `Größengrenze: ${MAX_UPLOAD_MB} MB (Voreinstellung; der Betreiber kann sie verschoben haben).`

        if (!ERLAUBTE_ENDUNGEN.includes(endung)) {
          return `Die Endung ".${endung}" nimmt f451 nicht an. ${grenzen}`
        }

        // Der Upload-Endpunkt legt NIE selbst einen Entwurf an; ohne offenen
        // Entwurf antwortet er mit „nicht gefunden". Ein Agent, der diesen Code
        // aus seiner Kommandozeile bekommt, sieht nur eine Zahl — deshalb der
        // Abruf vorweg und im Zweifel der Verweis auf edit_page.
        try {
          await apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/draft`)
        } catch (error) {
          if (error instanceof F451Error && error.status === 404) {
            return (
              `Für die Seite "${id}" ist kein Entwurf offen — ohne Entwurf nimmt f451 keine Anhänge an.\n\n`
              + 'Zuerst edit_page mit dieser Seiten-ID aufrufen (das legt den Entwurfszweig an), danach dieses '
              + 'Werkzeug erneut. Bei einer neuen Seite stattdessen create_page.'
            )
          }
          throw error
        }

        // Der Agent nennt womöglich einen Pfad („abzuege/maske.png") — für curl
        // ist das richtig so, für den Ablagepfad zählt nur der Dateiname: Die
        // API legt jede Datei flach unter `_media/` ab.
        const name = filename.split('/').pop()!
        const basis = name.replace(/\.[^.]+$/, '')
        const pfad = `_media/${name}`
        const markdown = BILD_ENDUNGEN.has(endung) ? `![${basis}](${pfad})` : `[${filename}](${pfad})`
        const route = `/api/pages/${encodeURIComponent(id)}/draft/media`

        return (
          `Für die Seite "${id}" ist ein Entwurf offen — die Datei kann angehängt werden.\n\n`
          + 'DIESES WERKZEUG ÜBERTRÄGT NICHTS. Der Upload läuft über die Kommandozeile der eigenen Umgebung; '
          + 'ohne Kommandozeile ist Anhängen nicht möglich — dann muss ein Mensch die Datei im Editor einfügen.\n\n'
          + `Befehl (im Verzeichnis, in dem "${filename}" liegt):\n\n`
          + `  curl -X POST "<WIKI>${route}" \\\n`
          + '    -H "Authorization: Bearer <TOKEN>" \\\n'
          + `    -F "file=@${filename}"\n\n`
          + '<WIKI> ist die eigene Verbindungsadresse zu diesem Dienst OHNE den abschließenden Pfad "/mcp" — '
          + 'aus "https://wiki.example.org/mcp" wird also "https://wiki.example.org". <TOKEN> ist derselbe '
          + 'f451-Token, mit dem diese Verbindung läuft.\n\n'
          + `Erwarteter Ablagepfad: ${pfad}\n`
          + `Markdown zum Einfügen:  ${markdown}\n\n`
          + 'Die Antwort des Uploads nennt den TATSÄCHLICHEN Pfad und den fertigen Markdown-Schnipsel — bei '
          + 'Sonderzeichen im Namen oder einer Namenskollision weicht er ab (dann gilt die Antwort, nicht die '
          + `Vorschau oben).\n\n${grenzen}`
        )
      }),
  )
}
