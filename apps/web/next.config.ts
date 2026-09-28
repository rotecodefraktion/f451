import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  // Der draw.io-Embed-iframe lädt unter `/drawio/?embed=1` (Trailing Slash NÖTIG:
  // draw.io referenziert seine Assets RELATIV — `js/main.js` etc. — die nur mit
  // Trailing Slash unter `/drawio/…` bleiben und so vom `/drawio`-Rewrite erfasst
  // werden). Nexts Default-Verhalten (`trailingSlash: false`) würde `/drawio/`
  // per 308 auf `/drawio` umleiten → die Assets lösten dann gegen die App-Wurzel
  // auf (`/js/main.js` → 404) und der Editor bliebe leer. `skipTrailingSlashRedirect`
  // schaltet NUR den automatischen Redirect ab (der Rewrite übernimmt die
  // Trailing-Slash-Semantik); die App selbst verlinkt ausschließlich ohne
  // Trailing Slash, ist davon also nicht betroffen.
  skipTrailingSlashRedirect: true,
  // `@f451/editor`/`@f451/markdown` sind Workspace-Pakete, deren TS-Quellen
  // (NodeNext-Konvention: relative Importe mit `.js`-Endung, die tsc/vitest
  // gegen die `.ts`-Datei auflösen) direkt als `main` referenziert werden
  // (kein `dist`-Build). Ohne `transpilePackages` behandelt Webpack sie wie
  // gewöhnliches `node_modules`-JS und scheitert an den `.js`-Importen, die
  // es nicht auf `.ts`-Dateien mappt (`Module not found: Can't resolve
  // './extensions.js'`) — mit `transpilePackages` laufen sie stattdessen
  // durch Next.js' eigenen SWC/TS-Loader, genau wie die App selbst.
  // `@f451/design-tokens` kam mit der Einstellungsseite „Erscheinungsbild"
  // dazu: Bis dahin wurde das Paket nur beim Bauen ausgeführt (CSS-Erzeugung),
  // seither importiert die Seite Katalog und Werte zur Laufzeit — es gilt
  // damit dieselbe Begründung wie für die beiden anderen.
  transpilePackages: ['@f451/editor', '@f451/markdown', '@f451/design-tokens'],
  // `transpilePackages` allein reicht nicht: Webpack löst die `.js`-Endung
  // der NodeNext-Importe innerhalb dieser Pakete sonst NICHT gegen die
  // tatsächliche `.ts`-Datei auf (anders als `tsc`/`tsx`/`vitest`, die genau
  // dieses Mapping beherrschen). `extensionAlias` schließt diese Lücke im
  // Webpack-Resolver.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.js', '.ts', '.tsx'],
    }
    return config
  },
  async rewrites() {
    const apiUrl = process.env.API_URL ?? 'http://localhost:3001'
    // Self-hosted draw.io über die App-Origin proxien (Phase 4c Deployment-Fix):
    // `drawioBaseUrl()` liefert per Default die RELATIVE URL `/drawio`, sodass der
    // Embed-iframe SAME-ORIGIN lädt (CSP `frame-src 'self'`) — unabhängig von der
    // Deployment-URL und ohne Rebuild pro Host/IP. Ziel ist der interne
    // Container (`http://drawio:8080`); wie `API_URL` zur BUILD-Zeit gebacken
    // (Dockerfile-ARG) und zur Laufzeit als env gespiegelt.
    const drawioUrl = process.env.DRAWIO_INTERNAL_URL ?? 'http://drawio:8080'
    // MCP-Dienst (KI-Agenten-Zugriff) unter dem Pfad-Präfix `/mcp` auf derselben
    // Origin. Der Dienst selbst bleibt intern (kein Port-Export); Agenten
    // erreichen ihn über `https://<wiki-host>/mcp` mit ihrem persönlichen
    // `f451_pat_…`-Token im Authorization-Header. Der MCP spricht die API
    // seinerseits intern an (F451_API_URL), nicht über diesen Umweg.
    const mcpUrl = process.env.MCP_INTERNAL_URL ?? 'http://mcp:3002'
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/mcp', destination: `${mcpUrl}/mcp` },
      { source: '/auth/:path*', destination: `${apiUrl}/auth/:path*` },
      { source: '/admin/:path*', destination: `${apiUrl}/admin/:path*` },
      { source: '/media/:path*', destination: `${apiUrl}/media/:path*` },
      { source: '/drawio/:path*', destination: `${drawioUrl}/:path*` },
    ]
  },
  // Task 4 (Security & Betrieb, Spec §7): statische Security-Header auf JEDER
  // Next-eigenen Antwort (Seiten, RSC-Payloads, statische Assets). Die
  // Content-Security-Policy lebt dagegen NICHT hier, sondern in
  // `middleware.ts` — sie braucht einen per-Request-Nonce für die Inline-
  // Skripte (Next-Hydration + Theme-Script), ein statischer Wert aus
  // `headers()` kann das prinzipiell nicht (s. Kommentar dort). Die BEIDEN
  // Header hier sind request-unabhängig und gehören auch auf die
  // `_next/static`-Asset-Antworten, die der Middleware-Matcher bewusst
  // ausnimmt — `headers()` ist deshalb der passendere Ort. WICHTIG:
  // `headers()` gilt NUR für Antworten, die Next selbst erzeugt — die
  // `/api`/`/auth`/`/admin`/`/media`-Rewrites oben proxien direkt zur API
  // durch (kein Next-Response dazwischen), tragen also die API-eigenen
  // Header (`app.ts`s `onSend`-Hook bzw. `routes/media.ts`s sandboxte CSP).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}

export default config
