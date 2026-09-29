import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Hanken_Grotesk, JetBrains_Mono, Schibsted_Grotesk } from 'next/font/google'
import { LocaleProvider } from '../lib/i18n/provider.js'
import { getT } from '../lib/i18n/server.js'
// Ein einziger Stil-Einstieg: `globals.css` ist nur noch die @import-Liste
// (s. Kopfkommentar dort). Die Graph-Ansicht stand bis Teilschritt H5 des
// Bausteinsystem-Umbaus als zweiter Import daneben und damit hinter allem in
// der Kaskade; sie ist jetzt die letzte Zeile jener Liste — gleiche
// Reihenfolge, aber die Bausteine erreichen die Ansicht wieder.
import './globals.css'

/**
 * Redesign Phase 1 (Design-Handoff „f451 Knowledge Base"): die drei
 * Google-Fonts werden CSP-sicher über `next/font/google` self-hosted — die
 * App hat eine strenge Nonce-CSP (`script-src 'self' 'nonce-…'`, s.
 * `middleware.ts`); ein externes `<link href="https://fonts.googleapis.com/…">`
 * würde daran brechen. `next/font/google` lädt die Font-Dateien beim Build
 * und liefert sie vom eigenen Host aus (`'self'`), keine externe Anfrage zur
 * Laufzeit. Jede Instanz exportiert ihre Werte über eine CSS-Variable
 * (`variable: '--font-…'`), die per `.variable`-Klasse an `<html>` gehängt
 * wird; `globals.css` referenziert diese Variablen für `--font-sans` /
 * `--font-display` / `--font-mono` (s. dortiger `:root`-Block).
 */
const hankenGrotesk = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hanken-grotesk',
  display: 'swap',
})
const schibstedGrotesk = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-schibsted-grotesk',
  display: 'swap',
})
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
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
  return { title: t('shell.meta.title') }
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

// Die auf der Seite „Erscheinungsbild" eingestellten Token-Überschreibungen,
// ebenfalls VOR dem ersten Paint. Ohne dieses Script erschiene bei jedem
// Seitenaufruf kurz das ausgelieferte Farbschema, bevor die Client-Insel
// (`components/erscheinungsbild-editor.tsx`) ihre Werte anlegt.
//
// Es MUSS nach NO_FLASH_THEME laufen: welcher Wertesatz gilt, hängt am dort
// gesetzten `data-theme` (fehlt es, entscheidet prefers-color-scheme — dieselbe
// Regel wie in `tokens.css`).
//
// Gespeichert liegt `{ light: {…}, dark: {…} }` unter dem Schlüssel
// `erscheinungsbild` (SPEICHER_SCHLUESSEL in der Insel). Das Script prüft jeden
// Schritt einzeln und wirft nie: ein von Hand verbogener oder veralteter
// Eintrag darf die Anwendung nicht anhalten, sondern nur wirkungslos bleiben.
// Übernommen werden ausschließlich Zeichenketten unter `--`-Namen — nichts
// anderes gehört an ein Wurzelelement.
const NO_FLASH_TOKENS = `(function(){try{var r=document.documentElement,m=r.getAttribute('data-theme');if(m!=='dark'&&m!=='light'){m=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var s=null;try{s=JSON.parse(localStorage.getItem('erscheinungsbild')||'null');}catch(e){}if(!s||typeof s!=='object')return;var w=s[m];if(!w||typeof w!=='object')return;for(var k in w){if(Object.prototype.hasOwnProperty.call(w,k)&&typeof w[k]==='string'&&k.slice(0,2)==='--'){r.style.setProperty(k,w[k]);}}}catch(e){}})();`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // CSP-Nonce (Phase 4a Task 4, s. `middleware.ts`): die Middleware generiert
  // ihn pro Request und reicht ihn als `x-nonce`-Request-Header herein — nur
  // mit diesem nonce-Attribut lässt die `script-src 'self' 'nonce-…'`-CSP das
  // Inline-Theme-Script durch. `headers()` macht das Layout dynamisch — die
  // Routen sind es (bis auf not-found) ohnehin, und eine per-Request-CSP
  // schließt statisches Prerendering des Dokuments prinzipbedingt aus.
  const nonce = (await headers()).get('x-nonce') ?? undefined
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
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME + NO_FLASH_PANES + NO_FLASH_TOKENS }} />
      </head>
      <body>
        <LocaleProvider locale={locale} messages={messages}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  )
}
