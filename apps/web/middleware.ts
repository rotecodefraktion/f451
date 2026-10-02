import { NextResponse, type NextRequest } from 'next/server'
import { spaceFromPath } from './lib/space-from-path'

const SPACE_HEADER = 'x-f451-space'

/**
 * Task 4 (Security & Betrieb, Spec §7), Fix-Runde 1: Per-Request-Nonce-CSP
 * nach dem offiziellen Next.js-Muster (App-Router-CSP-Doku) statt der
 * ursprünglichen statischen Hash-CSP aus `next.config.ts#headers()`.
 *
 * WARUM Nonce statt Hash (Review-Blocker, per echtem `next build` + `next
 * start` + Playwright-Konsole bewiesen): der App Router streamt seine
 * Hydration-Payload über PER-REQUEST-GENERIERTE Inline-Skripte
 * (`self.__next_f.push(...)`) — deren Inhalt ist request-abhängig, ein zur
 * Build-Zeit fixierter sha256-Hash kann sie prinzipiell nicht abdecken. Eine
 * statische `script-src 'self' '<hash>'`-CSP blockt damit JEDE Hydration
 * (6 Violations schon auf der statischen not-found-Seite). Der Nonce-Weg ist
 * Next' offizieller Ausweg: die Middleware generiert pro Request einen
 * frischen Nonce, legt die CSP in die REQUEST-Header (daraus liest Next den
 * Nonce und hängt ihn AUTOMATISCH an alle eigenen Inline-Skripte) und
 * zusätzlich in die RESPONSE-Header (das ist die CSP, die der Browser
 * durchsetzt). Eigene Inline-Skripte (Theme-Script in `app/layout.tsx`)
 * lesen den Nonce aus dem `x-nonce`-Request-Header.
 *
 * Direktiven (Spec §7: iframes NUR draw.io-Embed und youtube-nocookie);
 * `frame-ancestors 'none'` statt X-Frame-Options (moderner Ersatz) — die
 * Wiki-Seiten selbst werden nirgends eingebettet. `form-action 'self'`/
 * `base-uri 'self'` härten Formular-Ziele/`<base>`-Manipulation ab, ohne den
 * OIDC-Login zu berühren (Server-Redirect zum IdP, keine `<form>`-Navigation).
 *
 * Dev-Zweig (`NODE_ENV !== 'production'`): NUR `'unsafe-eval'` (Webpacks
 * HMR-Runtime/React Refresh injizieren Update-Code über `eval()`/`new
 * Function()`) und `ws:` in `connect-src` (HMR-WebSocket). KEIN
 * `'unsafe-inline'` mehr nötig — empirisch verifiziert (next dev +
 * Playwright-Konsolen-Probe): mit Nonce-CSP im Request versieht Next auch im
 * Dev-Modus alle eigenen Inline-Skripte mit dem Nonce. Die CSP bleibt in Dev/E2E
 * AKTIV und bis auf eval/ws identisch zur Produktion (Plan-Entscheidung 3).
 */

// `frame-src`-Quelle für das draw.io-Embed — spiegelt `drawioBaseUrl()`
// (`lib/editor/drawio-protocol.ts`) exakt: ist `NEXT_PUBLIC_DRAWIO_URL` mit
// einer ABSOLUTEN Origin gesetzt, wird genau diese erlaubt; sonst gilt der
// RELATIVE Proxy-Default `/drawio` (same-origin) → `'self'` genügt. Bewusst
// nicht importiert (beide Stellen kommentieren aufeinander). Fail-Fast: ein
// als absolut aussehender, aber nicht parsbarer Wert lässt `new URL()` beim
// Modul-Init werfen — die App startet dann gar nicht erst mit einer kaputten CSP.
const DRAWIO_FRAME_SRC = (() => {
  const raw = process.env.NEXT_PUBLIC_DRAWIO_URL?.trim()
  const base = raw && raw.length > 0 ? raw : '/drawio'
  return /^https?:\/\//i.test(base) ? new URL(base).origin : "'self'"
})()

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV !== 'production'
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])]
  const connectSrc = ["'self'", ...(dev ? ['ws:'] : [])]
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    // KEIN Nonce in style-src: die CSP-Spec ignoriert 'unsafe-inline', sobald
    // ein Nonce/Hash in derselben Direktive steht — Next/Excalidraw injizieren
    // aber nonce-lose Inline-Styles, die weiter erlaubt bleiben müssen.
    "style-src 'self' 'unsafe-inline'",
    // i.ytimg.com: YouTube-Vorschaubilder (packages/markdown/src/render.ts,
    // Phase 3d „Thumbnail zuerst, iframe erst per Klick").
    "img-src 'self' data: blob: https://i.ytimg.com",
    `frame-src https://www.youtube-nocookie.com ${DRAWIO_FRAME_SRC}`,
    `connect-src ${connectSrc.join(' ')}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

export function middleware(request: NextRequest): NextResponse {
  // Web-Crypto (Edge-Runtime-kompatibel), 128 Bit Zufall, base64-kodiert.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const csp = buildCsp(nonce)

  // REQUEST-Header: `Content-Security-Policy` ist der Kanal, aus dem Next den
  // Nonce für seine EIGENEN Inline-Skripte (Hydration/`__next_f.push`) liest;
  // `x-nonce` ist der Kanal für UNSERE Server Components (`app/layout.tsx`
  // liest ihn via `headers()` und setzt ihn ans Theme-Script).
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  // Current space for the root layout's theme lookup (`app/layout.tsx`), which
  // has no route params. Carried URI-encoded: header values must be ByteStrings,
  // and space ids are free text (`Headers.set` throws beyond U+00FF). Always
  // overwritten or removed, so a client cannot inject its own value on a
  // matched request.
  const space = spaceFromPath(request.nextUrl.pathname)
  if (space !== null) requestHeaders.set(SPACE_HEADER, encodeURIComponent(space))
  else requestHeaders.delete(SPACE_HEADER)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  // RESPONSE-Header: die CSP, die der Browser tatsächlich durchsetzt.
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    // Nicht matchen (heutiges, vom Review als korrekt verifiziertes Verhalten
    // beibehalten): die `/api`/`/auth`/`/admin`/`/media`-Rewrites proxien
    // direkt zur API durch — deren Antworten tragen die API-eigenen Header
    // (apps/api/src/app.ts#onSend bzw. routes/media.ts), NICHT die Web-CSP.
    // `/drawio` gehört aus demselben Grund dazu: der Rewrite (next.config.ts)
    // proxied den self-hosted draw.io-Container durch (dessen eigene Assets/
    // Header) — eine per-Request-Web-CSP hätte auf diesen Antworten nichts
    // verloren (und würde nur die draw.io-SPA behindern).
    // `_next/static`/`_next/image`/favicon sind statische Assets ohne
    // Inline-Skripte — eine per-Request-CSP wäre dort nur Cache-Gift.
    // `missing`: Prefetch-Requests (RSC-Payloads, kein HTML-Dokument)
    // überspringen die Middleware ebenfalls (offizielles Next-CSP-Muster).
    {
      source: '/((?!api/|auth/|admin/|media/|webhooks/|drawio/|_next/static|_next/image|favicon\\.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
