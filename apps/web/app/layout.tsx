import type { Metadata } from 'next'
import { headers } from 'next/headers'
import localFont from 'next/font/local'
import { PreviewBanner } from '../components/theme-editor/preview-banner'
import { LocaleProvider } from '../lib/i18n/provider.js'
import { getT } from '../lib/i18n/server.js'
import { getBrand, getResolvedTheme } from '../lib/resolved-theme.js'
import { themeAttributes, themeStyleText } from '../lib/theme-style.js'
// Ein einziger Stil-Einstieg: `globals.css` ist nur noch die @import-Liste
// (s. Kopfkommentar dort). Die Graph-Ansicht stand bis Teilschritt H5 des
// Bausteinsystem-Umbaus als zweiter Import daneben und damit hinter allem in
// der Kaskade; sie ist jetzt die letzte Zeile jener Liste — gleiche
// Reihenfolge, aber die Bausteine erreichen die Ansicht wieder.
import './globals.css'

/**
 * The three typefaces ship with the repository (`app/fonts/`, latin subsets as
 * woff2, SIL OFL — licence texts next to them) and are loaded through
 * `next/font/local`. Until now `next/font/google` fetched them from Google at
 * build time, which made every build depend on Google's servers — CI and the
 * demo deploy failed repeatedly with "An error occurred in `next/font`". The
 * app has a strict nonce CSP (`script-src 'self' 'nonce-…'`, `middleware.ts`),
 * so serving the files from the own host (`'self'`) is also the only option
 * that works without touching the CSP. Jede Instanz exportiert ihre Werte über eine CSS-Variable
 * (`variable: '--font-…'`), die per `.variable`-Klasse an `<html>` gehängt
 * wird; `globals.css` referenziert diese Variablen für `--font-sans` /
 * `--font-display` / `--font-mono` (s. dortiger `:root`-Block).
 */
const hankenGrotesk = localFont({
  src: [
    { path: './fonts/hanken-grotesk-latin.woff2', style: 'normal' },
    { path: './fonts/hanken-grotesk-italic-latin.woff2', style: 'italic' },
  ],
  weight: '100 900',
  variable: '--font-hanken-grotesk',
  display: 'swap',
})
const schibstedGrotesk = localFont({
  src: [
    { path: './fonts/schibsted-grotesk-latin.woff2', style: 'normal' },
    { path: './fonts/schibsted-grotesk-italic-latin.woff2', style: 'italic' },
  ],
  weight: '400 900',
  variable: '--font-schibsted-grotesk',
  display: 'swap',
})
const jetbrainsMono = localFont({
  src: [
    { path: './fonts/jet-brains-mono-latin.woff2', style: 'normal' },
    { path: './fonts/jet-brains-mono-italic-latin.woff2', style: 'italic' },
  ],
  weight: '100 800',
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

/**
 * Lokalisierter Titel (Phase 1 Sprach-Infrastruktur, siehe `lib/i18n/`):
 * `generateMetadata` statt eines statischen `metadata`-Exports, weil der
 * Titel von der per-Request ermittelten Sprache (`getLocale()`) abhängt.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  // A brand name replaces "f451" in the title (addendum §5).
  const name = (await getBrand())?.name
  return { title: name ? t('shell.meta.brandTitle', { name }) : t('shell.meta.title') }
}

// Flash-frei: setzt data-theme aus localStorage VOR dem ersten Paint. Ohne
// gespeicherte Wahl bleibt das Attribut leer und prefers-color-scheme greift.
const NO_FLASH_THEME = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`

// Leisten-Zustand des Fünf-Spalten-Rasters, ebenfalls VOR dem ersten Paint
// (`data-nav`/`data-rail` am <html>, s. `styles/60-chrome-raster.css` und
// `app/pane-edges.tsx`). Ohne dieses Script blitzte eine gespeichert
// eingeklappte Leiste bei jedem Seitenaufruf einmal auf.
//
// Der gespeicherte Zustand gilt unverändert — er übersteht das Neuladen in
// JEDER Fensterbreite (die Untergrenze der Dokumentspalte in
// `60-chrome-raster.css` hält sie auch im engen Fenster lesbar). Die
// Fensterbreite entscheidet nur beim ERSTEN Besuch, wenn nichts gespeichert
// ist: unter 1180px startet die Info-Leiste zu, unter 900px auch der
// Seitenbaum. Kein Effekt auf spätere Größenänderungen — der Zustand ändert
// sich ausschließlich durch den Nutzer (Begründung in `pane-edges.tsx`).
// Der Schlüssel `panes` steht zugleich dort (PANE_STORAGE_KEY).
const NO_FLASH_PANES = `(function(){try{var r=document.documentElement,s=null;try{s=JSON.parse(localStorage.getItem('panes')||'null');}catch(e){}var nav,rail;if(s&&typeof s.nav==='boolean'&&typeof s.rail==='boolean'){nav=s.nav;rail=s.rail;}else{nav=matchMedia('(min-width: 900px)').matches;rail=matchMedia('(min-width: 1180px)').matches;}r.setAttribute('data-nav',nav?'on':'off');r.setAttribute('data-rail',rail?'on':'off');}catch(e){}})();`

// The token overrides of the program preview ("Im ganzen Programm
// ausprobieren" on the appearance page), also applied BEFORE the first paint.
// Without this script every page load would briefly show the saved theme
// before the preview's values arrive.
//
// The key `erscheinungsbild` (`PREVIEW_STORAGE_KEY` in `lib/theme-preview.ts`)
// is written by the program preview (`components/theme-editor/program-preview.tsx`)
// and read by the preview banner (`components/theme-editor/preview-banner.tsx`),
// which also re-applies the values when the mode changes after load.
//
// It MUST run after NO_FLASH_THEME: which value set applies depends on the
// `data-theme` set there (if absent, prefers-color-scheme decides — the same
// rule as in `tokens.css`).
//
// Stored is `{ light: {…}, dark: {…} }`, from the preview with a top-level
// `preview: true` marker this script ignores (`lib/erscheinungsbild.ts`). The script checks every step on its
// own and never throws: a hand-bent or stale entry must not stop the app, only
// stay without effect. Only strings under `--` names are taken over — nothing
// else belongs on the root element.
//
// Program preview (`localStorage['erscheinungsbild']`, lib/erscheinungsbild.ts): the
// per-mode custom properties as before, plus `attributes` — the FULL switch set of
// the previewed draft as `data-<name>`, so a deviation the server rendered onto
// <html> cannot show through while a preview is running. Same grammar as
// lib/theme-style.ts#themeAttributes.
const NO_FLASH_TOKENS = `(function(){try{var r=document.documentElement,s=null;try{s=JSON.parse(localStorage.getItem('erscheinungsbild')||'null');}catch(e){}if(!s||typeof s!=='object')return;var a=s.attributes;if(a&&typeof a==='object'){for(var n in a){if(Object.prototype.hasOwnProperty.call(a,n)&&typeof a[n]==='string'&&/^[a-z][a-z0-9-]{0,40}$/.test(n)&&/^[a-z0-9-]{1,40}$/.test(a[n])&&n!=='theme'&&n!=='nav'&&n!=='rail'&&n!=='altlasten'){r.setAttribute('data-'+n,a[n]);}}}var m=r.getAttribute('data-theme');if(m!=='dark'&&m!=='light'){m=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var w=s[m];if(!w||typeof w!=='object')return;for(var k in w){if(Object.prototype.hasOwnProperty.call(w,k)&&typeof w[k]==='string'&&k.slice(0,2)==='--'){r.style.setProperty(k,w[k]);}}}catch(e){}})();`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // CSP-Nonce (Phase 4a Task 4, s. `middleware.ts`): die Middleware generiert
  // ihn pro Request und reicht ihn als `x-nonce`-Request-Header herein — nur
  // mit diesem nonce-Attribut lässt die `script-src 'self' 'nonce-…'`-CSP das
  // Inline-Theme-Script durch. `headers()` macht das Layout dynamisch — die
  // Routen sind es (bis auf not-found) ohnehin, und eine per-Request-CSP
  // schließt statisches Prerendering des Dokuments prinzipbedingt aus.
  const requestHeaders = await headers()
  const nonce = requestHeaders.get('x-nonce') ?? undefined
  // Sprache serverseitig ermitteln (Cookie `lang` > Accept-Language > `de`,
  // s. `lib/i18n/server.ts#getLocale`) und den Client-`<LocaleProvider>`
  // damit seeden — der Client leitet die Sprache NIE selbst ab, das hält
  // Server-/Client-Render hydration-sicher konsistent (s. `provider.tsx`).
  const { locale, messages, t } = await getT()
  // UI-sprachige Beschriftungen für sprachneutral gespeichertes Seiten-HTML
  // (Issue #9: Alert-/Callout-Titel, YouTube-Abspiel-Beschriftung). Markdown
  // rendert dafür nur leere Struktur-Elemente (packages/markdown/src/alerts.ts,
  // render.ts) — der Text kommt hier als CSS Custom Property herein, gelesen
  // von `::before { content: var(--label-…) }` in `app/styles/61-lese.css`/
  // `62-editor.css`. `JSON.stringify` liefert den nötigen Anführungszeichen-Wert
  // für die CSS-`content`-Eigenschaft UND escaped darin enthaltene Sonderzeichen
  // sicher (z. B. ein `"` im übersetzten Text).
  const contentLabels = {
    '--label-alert-note': JSON.stringify(t('read.alerts.note')),
    '--label-alert-tip': JSON.stringify(t('read.alerts.tip')),
    '--label-alert-important': JSON.stringify(t('read.alerts.important')),
    '--label-alert-warning': JSON.stringify(t('read.alerts.warning')),
    '--label-alert-caution': JSON.stringify(t('read.alerts.caution')),
    '--label-youtube-play': JSON.stringify(t('read.youtube.play')),
  } as React.CSSProperties
  // Operator stylesheet (F451_CUSTOM_STYLESHEET), loaded after f451's own CSS,
  // e.g. an instance's colours and self-hosted typefaces. Same-origin paths
  // only — that is what the CSP (`style-src 'self'`, `font-src 'self'`) allows.
  const customStylesheet = process.env.F451_CUSTOM_STYLESHEET
  // Resolved theme (instance, space and user layer) and the brand; `null` on any
  // failure — then the built-in tokens and the f451 icon apply. Shared per
  // request with `generateMetadata` and the `<Shell>` (`lib/resolved-theme.ts`).
  const resolvedTheme = await getResolvedTheme()
  const themeCss = themeStyleText(resolvedTheme?.css)
  // Brand favicon (instance only, addendum §5). Without one, `app/icon.svg`
  // (Next's file convention) stays the icon.
  const faviconUrl = resolvedTheme?.brand?.faviconUrl ?? null
  const switchAttributes = themeAttributes(resolvedTheme?.attributes)
  return (
    <html
      lang={locale}
      style={contentLabels}
      // Der Schalter des Bausteinsystem-Umbaus (Etappe 2, Teilschritt I).
      // Bis hierher hielten die Baustein-Dateien `40-schaltflaeche.css`,
      // `41-eingabe.css` und `45-auswahl.css` an ihrem Dateifuß je einen
      // Übergangsblock, der die neuen Eigenschaften (`min-height` 44 px,
      // `line-height`, Fokus-Abstand) auf dem Wert VOR dem Umbau festhielt,
      // solange dieses Attribut fehlte. Die Blöcke sind entfernt; was am
      // Schalter hängt, ist nur noch die unsichtbare 44-px-Trefferfläche der
      // klein gebauten Schaltflächen (`.btn.small`, `.mf-chip-remove`) — sie
      // FÄNGT Klicks und ist deshalb an genau einer Stelle ein- und
      // ausschaltbar geblieben.
      data-altlasten="weg"
      className={`${hankenGrotesk.variable} ${schibstedGrotesk.variable} ${jetbrainsMono.variable}`}
      // Building-block switches of the resolved theme (structure spec 1); the no-flash script below may override them with a running program preview.
      {...switchAttributes}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME + NO_FLASH_PANES + NO_FLASH_TOKENS }} />
        {/* After the built-in tokens (globals.css), before the operator stylesheet. */}
        {themeCss ? <style id="f451-theme" dangerouslySetInnerHTML={{ __html: themeCss }} /> : null}
        {customStylesheet?.startsWith('/') ? <link rel="stylesheet" href={customStylesheet} /> : null}
        {faviconUrl ? <link rel="icon" type="image/svg+xml" href={faviconUrl} /> : null}
      </head>
      <body>
        <LocaleProvider locale={locale} messages={messages}>
          {children}
          {/* "Vorschau aktiv — beenden": only renders while a program preview is stored. */}
          <PreviewBanner />
        </LocaleProvider>
      </body>
    </html>
  )
}
