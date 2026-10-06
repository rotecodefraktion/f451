/**
 * f451-MCP-Server — Einstiegspunkt.
 *
 * Stellt die f451-Wiki-API als MCP-Tools für KI-Agenten bereit. Betriebsmodell
 * (s. `docs/superpowers/plans/2026-07-18-mcp-server.md`): interner Docker-Dienst
 * hinter dem bestehenden Reverse-Proxy unter dem Pfad-Präfix `/mcp`; der Dienst
 * spricht die f451-API intern über `http://api:3001` an.
 *
 * Transport: Streamable HTTP im STATELOSS-Modus (`sessionIdGenerator: undefined`).
 * Zustandslos ist hier keine Sparmaßnahme, sondern Voraussetzung: Der Dienst ist
 * multi-user, und jeder Request trägt seinen eigenen Nutzer-Token. Ein
 * sitzungsbehafteter Transport würde Server-Instanzen über Requests hinweg
 * wiederverwenden und damit den Token des einen Nutzers an den nächsten binden.
 * Deshalb werden McpServer UND Transport pro Request neu erzeugt und danach
 * geschlossen.
 */

import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import Fastify from 'fastify'
import { extractToken, MISSING_TOKEN_MESSAGE, toAuthInfo } from './auth.js'
import { registerAttachmentTools } from './tools/attachments.js'
import { registerReadTools } from './tools/read.js'
import { registerWriteTools } from './tools/write.js'

const PORT = Number(process.env.PORT ?? 3002)
const HOST = process.env.HOST ?? '0.0.0.0'

/** Erzeugt eine frische Server-Instanz mit allen Tools (pro Request, s. oben). */
function createServer(): McpServer {
  const server = new McpServer(
    { name: 'f451-wiki', version: '1.0.0' },
    {
      instructions:
        'Zugriff auf das f451-Wiki im Namen des Nutzers, der den API-Token ausgestellt hat. ' +
        'Lesen: mit list_spaces/get_tree orientieren, mit search_wiki finden, mit read_page (gerendert) ' +
        'oder get_page_source (Markdown) lesen. ' +
        'Schreiben läuft immer über den Review-Workflow und nie direkt auf die veröffentlichte Fassung: ' +
        'create_page oder edit_page legt einen Draft an, update_page_draft schreibt weitere Änderungen, ' +
        'request_review eröffnet die Review, release_page veröffentlicht. ' +
        'GFM-Fußnoten (`Text[^1]` … `[^1]: Notiz`) werden unterstützt und als Randnotizen dargestellt. ' +
        'Beim Bearbeiten gilt ein SHA-Vertrag — den `baseSha` aus der jeweils letzten Antwort ' +
        'unverändert in den nächsten Schreibaufruf übernehmen; bei einem Konflikt (409) den ' +
        'mitgelieferten currentSha/currentContent als neue Basis nehmen. ' +
        'Anhänge gehören in denselben Draft: save_diagram erzeugt aus einer Beschreibung des Ablaufs ein ' +
        'Diagramm im Hausstil (kein fertiges SVG senden), attach_file erklärt den Upload einer Datei über ' +
        'die eigene Kommandozeile — Binärdaten werden über diesen Dienst NICHT übertragen.',
    },
  )
  registerReadTools(server)
  registerWriteTools(server)
  registerAttachmentTools(server)
  return server
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Der Authorization-Header trägt den Klartext-Token des Nutzers — niemals
    // in die Logs (gleiche Maskierung wie in apps/api).
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
  genReqId: () => randomUUID(),
})

/** Liveness/Readiness für den Docker-Healthcheck. */
app.get('/healthz', async () => ({ status: 'ok' }))

/**
 * Der MCP-Endpunkt.
 *
 * Der Pfad wird sowohl als `/mcp` als auch als `/` bedient: Je nachdem, ob der
 * Reverse-Proxy das `/mcp`-Präfix beim Weiterleiten abschneidet oder nicht,
 * kommt hier das eine oder das andere an — beides zu akzeptieren erspart eine
 * fehleranfällige Kopplung zwischen Proxy-Regel und Dienst.
 */
async function handleMcp(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<void> {
  const token = extractToken(request.headers.authorization)
  if (!token) {
    // 401 mit `WWW-Authenticate`, damit MCP-Clients den Fehler als
    // Authentifizierungsproblem erkennen und nicht als Serverfehler.
    await reply
      .code(401)
      .header('www-authenticate', 'Bearer realm="f451", error="invalid_token"')
      .send({ error: 'invalid_token', message: MISSING_TOKEN_MESSAGE })
    return
  }

  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // Aufräumen, sobald die Antwort durch ist — sonst sammeln sich pro Request
  // erzeugte Server-/Transport-Instanzen an.
  reply.raw.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)

  // Fastify hat den Körper bereits geparst; er wird dem Transport übergeben,
  // damit dieser den Stream nicht ein zweites Mal zu lesen versucht. `hijack`
  // übergibt die Hoheit über die Antwort an den Transport (er schreibt direkt
  // auf `reply.raw`, ggf. als SSE-Stream).
  reply.hijack()
  const raw = Object.assign(request.raw, { auth: toAuthInfo(token) })
  await transport.handleRequest(raw, reply.raw, request.body)
}

app.post('/mcp', handleMcp)
app.post('/', handleMcp)

/**
 * GET/DELETE gehören im Streamable-HTTP-Protokoll zu sitzungsbehafteten
 * Strömen (server-initiierte Nachrichten, Sitzungsabbau). Im zustandslosen
 * Betrieb gibt es die nicht — sauberes 405 statt eines irreführenden 404.
 */
for (const path of ['/mcp', '/']) {
  app.route({
    method: ['GET', 'DELETE'],
    url: path,
    handler: async (_request, reply) =>
      reply.code(405).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Dieser MCP-Server läuft zustandslos; nur POST wird unterstützt.' },
        id: null,
      }),
  })
}

try {
  await app.listen({ port: PORT, host: HOST })
  app.log.info({ apiUrl: process.env.F451_API_URL ?? 'http://api:3001' }, 'f451-MCP-Server bereit')
} catch (error) {
  app.log.error(error, 'f451-MCP-Server konnte nicht starten')
  process.exit(1)
}
