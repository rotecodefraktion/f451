'use client'

import { useEffect, useState } from 'react'
import {
  leseUeberschreibungen,
  schreibeUeberschreibungen,
  type Modus,
  type TokenGruppe,
  type TokenZeile,
} from '../lib/erscheinungsbild'
import { useT } from '../lib/i18n/provider'

/**
 * localStorage-Schlüssel der Token-Überschreibungen. Derselbe Schlüssel steht
 * wörtlich im Inline-Script von `app/layout.tsx` (Konstante
 * `NO_FLASH_TOKENS`) — das Script läuft VOR jedem Modul und kann deshalb
 * nichts von hier importieren. Wer ihn hier ändert, muss ihn dort mitändern.
 */
const SPEICHER_SCHLUESSEL = 'erscheinungsbild'

/** Ab hier gilt ein Farbpaar als zu schwach (WCAG AA für Fließtext). */
const KONTRAST_SCHWELLE = 4.5

/**
 * `<input type="color">` versteht ausschließlich `#rrggbb`. Ein Token in einer
 * anderen Schreibweise (z. B. `color-mix(…)` oder `rgba(…)`) bekommt deshalb
 * KEINEN Farbwähler: ein Wähler, der einen nicht lesbaren Wert stumm als
 * Schwarz anzeigt, wäre eine Falschauskunft über den eigenen Wert. Das
 * Textfeld bleibt in jedem Fall, dort ist jede Schreibweise editierbar.
 */
function alsHexFarbe(wert: string): string | null {
  const roh = wert.trim()
  const kurz = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(roh)
  if (kurz) return `#${kurz[1]}${kurz[1]}${kurz[2]}${kurz[2]}${kurz[3]}${kurz[3]}`.toLowerCase()
  return /^#[0-9a-f]{6}$/i.test(roh) ? roh.toLowerCase() : null
}

/**
 * Setzt EINEN Modus-Satz und lässt den anderen unangetastet. Ausgeschrieben
 * statt `{ ...alle, [modus]: satz }`, weil ein berechneter Schlüssel aus einem
 * Vereinigungstyp den Record-Typ verliert.
 */
function mitModus(
  alle: Record<Modus, Record<string, string>>,
  modus: Modus,
  satz: Record<string, string>,
): Record<Modus, Record<string, string>> {
  return modus === 'light' ? { light: satz, dark: alle.dark } : { light: alle.light, dark: satz }
}

export interface ErscheinungsbildEditorProps {
  /** Beide Wertesätze, von der Server Component aus `baueGruppen()` geladen. */
  gruppen: Record<Modus, TokenGruppe[]>
}

/**
 * Der Token-Editor der Seite „Erscheinungsbild".
 *
 * Drei Dinge hängen zusammen und werden bewusst gemeinsam geführt:
 * 1. der bearbeitete Modus (`light`/`dark`) — er schaltet zugleich die
 *    tatsächliche Ansicht um (`data-theme` am <html>, gleicher Mechanismus wie
 *    `app/theme-toggle.tsx`), damit man sieht, woran man dreht;
 * 2. die Überschreibungen beider Modi im Zustand;
 * 3. die Wirkung im Dokument (`style.setProperty` an <html>) — sie gilt immer
 *    nur für den gerade angezeigten Modus, weil Inline-Stile am Wurzelelement
 *    keine Theme-Bedingung kennen. Beim Umschalten werden deshalb erst die
 *    alten Eigenschaften entfernt und dann die des neuen Modus gesetzt.
 */
export function ErscheinungsbildEditor({ gruppen }: ErscheinungsbildEditorProps) {
  const { t } = useT()
  // Serverseitig ist kein Modus bekannt (das Theme steht erst im Browser fest,
  // s. Inline-Script in `app/layout.tsx`). `light` ist der Startwert für
  // Server- UND ersten Client-Render — der Effekt unten zieht danach auf den
  // tatsächlich aktiven Modus nach. Damit bleibt die Hydration konfliktfrei.
  const [modus, setModus] = useState<Modus>('light')
  const [werte, setWerte] = useState<Record<Modus, Record<string, string>>>({ light: {}, dark: {} })

  useEffect(() => {
    const wurzel = document.documentElement
    const gesetzt = wurzel.getAttribute('data-theme')
    const aktiv: Modus =
      gesetzt === 'dark' || gesetzt === 'light'
        ? gesetzt
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
    setModus(aktiv)

    let roh: string | null = null
    try {
      roh = localStorage.getItem(SPEICHER_SCHLUESSEL)
    } catch {
      /* localStorage kann blockiert sein — dann startet die Seite ohne Überschreibungen */
    }
    const gelesen = leseUeberschreibungen(roh)
    setWerte(gelesen)
    // Erneutes Anwenden, obwohl das Inline-Script im <head> das schon getan
    // hat: es ist idempotent und deckt den Fall ab, dass das Script nicht lief.
    for (const [name, wert] of Object.entries(gelesen[aktiv])) {
      wurzel.style.setProperty(name, wert)
    }
  }, [])

  function speichere(naechste: Record<Modus, Record<string, string>>) {
    const leer = Object.keys(naechste.light).length === 0 && Object.keys(naechste.dark).length === 0
    try {
      // Kein leerer Eintrag im Speicher: „nichts überschrieben" ist die
      // Abwesenheit des Schlüssels, nicht ein Objekt ohne Inhalt.
      if (leer) localStorage.removeItem(SPEICHER_SCHLUESSEL)
      else localStorage.setItem(SPEICHER_SCHLUESSEL, schreibeUeberschreibungen(naechste))
    } catch {
      /* localStorage kann blockiert sein — die Änderung wirkt trotzdem für diese Sitzung */
    }
  }

  function setzeWert(name: string, wert: string) {
    const naechste = mitModus(werte, modus, { ...werte[modus], [name]: wert })
    setWerte(naechste)
    speichere(naechste)
    document.documentElement.style.setProperty(name, wert)
  }

  function wechsleModus(naechster: Modus) {
    if (naechster === modus) return
    const wurzel = document.documentElement
    // Erst die Inline-Eigenschaften des bisherigen Modus abräumen — sie würden
    // sonst im neuen Modus weiterwirken (Inline-Stil schlägt jede Theme-Regel).
    for (const name of Object.keys(werte[modus])) wurzel.style.removeProperty(name)
    wurzel.setAttribute('data-theme', naechster)
    try {
      localStorage.setItem('theme', naechster)
    } catch {
      /* s. `app/theme-toggle.tsx`: Umschalten funktioniert auch ohne Speicher */
    }
    for (const [name, wert] of Object.entries(werte[naechster])) wurzel.style.setProperty(name, wert)
    setModus(naechster)
  }

  /** `namen === null` heißt: alles, in BEIDEN Modi. */
  function setzeZurueck(namen: string[] | null) {
    const wurzel = document.documentElement
    if (namen === null) {
      for (const satz of [werte.light, werte.dark]) {
        for (const name of Object.keys(satz)) wurzel.style.removeProperty(name)
      }
      const leer: Record<Modus, Record<string, string>> = { light: {}, dark: {} }
      setWerte(leer)
      speichere(leer)
      return
    }
    const uebrig = { ...werte[modus] }
    for (const name of namen) {
      delete uebrig[name]
      wurzel.style.removeProperty(name)
    }
    const naechste = mitModus(werte, modus, uebrig)
    setWerte(naechste)
    speichere(naechste)
  }

  return (
    <div className="eb">
      <div className="eb-kopf">
        <div className="btn-row" role="group" aria-label={t('settings.appearance.modeLabel')}>
          <button
            type="button"
            className={modus === 'light' ? 'btn primary' : 'btn'}
            aria-pressed={modus === 'light'}
            onClick={() => wechsleModus('light')}
          >
            {t('settings.appearance.modeLight')}
          </button>
          <button
            type="button"
            className={modus === 'dark' ? 'btn primary' : 'btn'}
            aria-pressed={modus === 'dark'}
            onClick={() => wechsleModus('dark')}
          >
            {t('settings.appearance.modeDark')}
          </button>
        </div>
        <button type="button" className="btn" onClick={() => setzeZurueck(null)}>
          {t('settings.appearance.resetAll')}
        </button>
      </div>
      <p className="eb-hinweis">{t('settings.appearance.storageHint')}</p>

      {gruppen[modus].map((gruppe) => (
        <section className="eb-gruppe" key={gruppe.titel}>
          <div className="eb-gruppe-kopf">
            <h2>{gruppe.titel}</h2>
            <button
              type="button"
              className="btn small"
              onClick={() => setzeZurueck(gruppe.zeilen.map((zeile) => zeile.name))}
            >
              {t('settings.appearance.resetGroup')}
            </button>
          </div>
          {gruppe.hinweis ? <p className="eb-hinweis">{gruppe.hinweis}</p> : null}
          <div className="eb-zeilen">
            {gruppe.zeilen.map((zeile) => (
              <TokenFeld
                key={zeile.name}
                zeile={zeile}
                wert={werte[modus][zeile.name] ?? zeile.wert}
                onWert={setzeWert}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

interface TokenFeldProps {
  zeile: TokenZeile
  /** Überschriebener Wert, sonst der ausgelieferte aus dem Katalog. */
  wert: string
  onWert: (name: string, wert: string) => void
}

/** Eine Zeile des Katalogs: Rolle als Beschriftung, Token-Name, Feld und —
 *  soweit vorhanden — Farbwähler, Kontrastangabe und Nebentexte. */
function TokenFeld({ zeile, wert, onWert }: TokenFeldProps) {
  const { t, locale } = useT()
  const id = `eb-${zeile.name.replace(/^--/, '')}`
  // Ein Token ohne Wurzelwert ist nicht kaputt — es wird erst dort gesetzt, wo
  // es gebraucht wird (Baustein-lokale Variablen). Ein Feld dafür anzubieten
  // würde einen Wert vorspiegeln, den es global nicht gibt.
  const ohneWurzelwert = zeile.wert === ''
  const hex = zeile.istFarbe && !ohneWurzelwert ? alsHexFarbe(wert) : null

  return (
    <div className="eb-zeile">
      <div className="eb-zeile-kopf">
        {ohneWurzelwert ? (
          <span className="eb-rolle">{zeile.rolle}</span>
        ) : (
          <label className="eb-rolle" htmlFor={id}>
            {zeile.rolle}
          </label>
        )}
        <code className="eb-name">{zeile.name}</code>
        {ohneWurzelwert ? <span className="eb-nebentext">{t('settings.appearance.noRootValue')}</span> : null}
        {zeile.freigegeben ? null : (
          <span className="eb-nebentext">
            {zeile.sperrgrund
              ? t('settings.appearance.notAllowed', { grund: zeile.sperrgrund })
              : t('settings.appearance.notAllowedNoReason')}
          </span>
        )}
      </div>
      <div className="eb-eingabe">
        {ohneWurzelwert ? null : (
          <>
            <input
              id={id}
              className="input eb-text"
              type="text"
              value={wert}
              onChange={(event) => onWert(zeile.name, event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {hex ? (
              <input
                className="eb-farbe"
                type="color"
                value={hex}
                aria-label={t('settings.appearance.colorPickerLabel', { token: zeile.name })}
                onChange={(event) => onWert(zeile.name, event.target.value)}
              />
            ) : null}
          </>
        )}
        {zeile.kontrast ? (
          <span className="eb-kontrast">
            {t('settings.appearance.contrast', {
              wert: zeile.kontrast.wert.toLocaleString(locale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
              gegen: zeile.kontrast.gegen,
            })}
            {/* Zeichen UND Wort, nicht Farbe allein (Baustein `.chip.warn`
                setzt das „!" selbst, s. `app/styles/42-marke.css`). */}
            {zeile.kontrast.wert < KONTRAST_SCHWELLE ? (
              <span className="chip warn">{t('settings.appearance.contrastLow')}</span>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  )
}
