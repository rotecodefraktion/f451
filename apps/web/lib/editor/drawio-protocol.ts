// draw.io-Embed-postMessage-JSON-Protokoll (https://www.drawio.com/doc/faq/embed-mode):
// iframe → host: {event:'init'|'save'|'export'|'exit', …}; host → iframe:
// {action:'load'|'export', …}. Nachrichten sind JSON-STRINGS. Pure Zustandslogik
// ohne DOM, damit der komplette Ablauf ohne draw.io testbar ist (E2E nutzt einen
// Stub, der genau dieses Protokoll spricht — Plan-Entscheidung 7).

export function drawioBaseUrl(): string {
  // Default: die RELATIVE, same-origin-Adresse `/drawio` — der Next-Rewrite
  // (`next.config.ts`) proxied sie im internen Docker-Netz an den self-hosted
  // draw.io-Container (`http://drawio:8080`). So funktioniert der Editor über
  // JEDE Deployment-URL OHNE Rebuild und OHNE hartkodierte Host-IP, und die CSP
  // `frame-src 'self'` genügt (draw.io läuft dann unter der App-Origin).
  // `NEXT_PUBLIC_DRAWIO_URL` überschreibt das mit einer ABSOLUTEN Origin (z. B.
  // `https://embed.diagrams.net` oder eine externe draw.io-Instanz) — dann wird
  // KEIN Proxy genutzt und die CSP muss genau diese Origin erlauben (middleware.ts).
  const configured = process.env.NEXT_PUBLIC_DRAWIO_URL?.trim()
  return configured && configured.length > 0 ? configured : '/drawio'
}

export function drawioEmbedUrl(baseUrl: string): string {
  // `configure=1`: Der Editor fragt vor dem Start nach seiner Konfiguration und
  // wartet auf die Antwort (Formenbibliothek „Hausstil", `drawio-library.ts`).
  return `${baseUrl.replace(/\/+$/, '')}/?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&configure=1`
}

const SVG_DATA_PREFIX = 'data:image/svg+xml;base64,'

/** `data:image/svg+xml;base64,<b64>` → SVG-Text (UTF-8); alles andere → `null`. */
export function decodeSvgDataUri(data: string): string | null {
  if (typeof data !== 'string' || !data.startsWith(SVG_DATA_PREFIX)) return null
  try {
    const b64 = data.slice(SVG_DATA_PREFIX.length)
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export interface DrawioCallbacks {
  /** init empfangen → Rückgabe wird als load.xml gesendet ('' für neues Diagramm). */
  getInitialContent(): string
  /** export empfangen und dekodiert → persistieren (PUT) + schließen. */
  onSave(svgText: string, exit: boolean): void
  /** exit ohne Speichern. */
  onExit(): void
  /** configure empfangen → Rückgabe als `config` (Formenbibliothek). Mit
   *  `configure=1` WARTET der Editor auf diese Antwort; fehlt der Callback,
   *  geht eine leere Konfiguration raus, damit er trotzdem startet. */
  getConfig?(): Record<string, unknown>
}

export interface DrawioProtocol {
  /** window-message-Handler: prüft origin (=== new URL(embedUrl).origin) und
   *  ev.data (JSON-String); reagiert auf init/save/export/exit. */
  handleMessage(ev: { origin: string; data: unknown }): void
}

export function createDrawioProtocol(
  embedOrigin: string,
  post: (msg: Record<string, unknown>) => void, // JSON.stringify + postMessage macht der Aufrufer
  callbacks: DrawioCallbacks,
): DrawioProtocol {
  // save-Event trägt das exit-Flag, die SVG kommt erst im folgenden export-Event —
  // zwischenspeichern, damit onSave weiß, ob der Dialog danach schließt.
  let pendingExit = false
  return {
    handleMessage(ev) {
      if (ev.origin !== embedOrigin || typeof ev.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(ev.data)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const message = parsed as { event?: string; exit?: boolean; data?: string }
      switch (message.event) {
        case 'configure':
          post({ action: 'configure', config: callbacks.getConfig?.() ?? {} })
          return
        case 'init':
          post({ action: 'load', xml: callbacks.getInitialContent(), autosave: 0 })
          return
        case 'save':
          // Self-Review-Fund (Task 4, manueller Smoke gegen den echten
          // jgraph/drawio-Container): der reale „Save & Exit"-Button — mit
          // `noSaveBtn=1` der EINZIGE Button, der ein `save`-Event auslöst —
          // sendet dabei KEIN `exit`-Feld (anders als die Embed-Doku
          // suggeriert; geprüft gegen `jgraph/drawio:latest`). Ein
          // `message.exit === true`-Check hätte den Dialog nach JEDEM
          // erfolgreichen Speichern fälschlich offen gelassen. Da
          // `noSaveBtn=1` ohnehin ausschließt, dass ein `save`-Event etwas
          // anderes als „speichern und schließen" bedeuten kann, gilt exit
          // als wahr — außer eine Nachricht sagt explizit `exit:false`.
          pendingExit = message.exit !== false
          post({ action: 'export', format: 'xmlsvg' })
          return
        case 'export': {
          const svg = typeof message.data === 'string' ? decodeSvgDataUri(message.data) : null
          if (svg !== null) callbacks.onSave(svg, pendingExit)
          return
        }
        case 'exit':
          callbacks.onExit()
          return
      }
    },
  }
}
