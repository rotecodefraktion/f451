/**
 * Anzeige-Modell der Einstellungsseite „Erscheinungsbild".
 *
 * Die Seite zeigt alle Tokens des Katalogs gruppiert an, macht ihre Werte im
 * Browser änderbar und nennt bei Farben den Kontrast. Hier steht ausschließlich
 * die Datenschicht dazu: Was angezeigt wird, in welcher Reihenfolge, und wie
 * die Überschreibungen den Weg in den und aus dem localStorage finden.
 *
 * Alles Inhaltliche kommt aus `@f451/design-tokens` — Rollentexte, Sperren und
 * Sperrgründe aus dem Katalog, Werte aus dem Token-Satz, Kontrast aus derselben
 * Rechnung und derselben Paartabelle, gegen die auch geprüft wird. Eine zweite
 * Liste in der Web-App liefe still auseinander; genau davor warnt der Katalog
 * in seinem Kopfkommentar.
 */
import {
  KONTRASTPAARE,
  catalog,
  contrastRatio,
  design,
  formulaToCss,
  loeseBezug,
  tokenNames,
  type Bezug,
  type DerivedTokenName,
  type StructureTokenName,
  type ThemeTokenName,
  type TokenName,
} from '@f451/design-tokens'

export type Modus = 'light' | 'dark'

export interface TokenZeile {
  /** CSS-Variablenname, z.B. '--color-bg'. */
  name: string
  /** Rolle im Klartext aus dem Katalog. */
  rolle: string
  /** true, wenn der Wert eine Farbe ist (Farbwähler + Kontrastanzeige). */
  istFarbe: boolean
  /** Ausgelieferter Wert in diesem Modus. */
  wert: string
  /** false = im späteren echten Theme nicht freigegeben (hier trotzdem änderbar). */
  freigegeben: boolean
  /** Begründung, wenn `freigegeben` false ist. */
  sperrgrund?: string
  /** Kontrast gegen die zugehörige Fläche, wenn für dieses Token ein Bezug definiert ist. */
  kontrast?: { wert: number; gegen: string }
}

export interface TokenGruppe {
  titel: string
  zeilen: TokenZeile[]
  /** Nebentext unter der Gruppenüberschrift, wenn die Gruppe eine Einschränkung trägt. */
  hinweis?: string
}

/**
 * Die Gruppe „Diagramme" wirkt anders als alle übrigen, und das gehört
 * dazugesagt.
 *
 * Ein Diagramm wird als Bild eingebunden; ein SVG in einem Bild-Element ist ein
 * abgeschottetes Dokument, in dem die CSS-Variablen der Anwendung nicht
 * existieren (`routes/media.ts` setzt dafür eine Sandbox-Richtlinie). Der
 * Farbwähler dieser Seite schreibt seine Werte an `<html>` — bei jedem anderen
 * Token sieht man die Wirkung sofort, hier bei keinem. Ohne diesen Satz sähe
 * das aus wie ein Fehler.
 *
 * Bis Themes zentral gespeichert werden (Themefähigkeits-Spec, „Speicherort"),
 * erreicht eine Änderung hier auch den Generator (MCP-Dienst) und die
 * Formenbibliothek NICHT — beide lesen die eingebauten Katalogwerte. Der
 * frühere Wortlaut („zeigt sich am nächsten Diagramm") versprach das
 * (Abnahme #76).
 */
const HINWEIS_DIAGRAMME =
  'Diese Werte bestimmen, womit Diagramme ERZEUGT werden — vorhandene ändern sich nicht, denn ein Diagramm '
  + 'ist ein Bild. Eine Änderung hier ist derzeit nur eine Vorschau in diesem Browser: Der Diagramm-Generator '
  + 'und die Formenbibliothek im Editor arbeiten mit den Werten der Installation, bis sich Themes zentral '
  + 'speichern lassen.'

/** Nur `#rgb`, `#rrggbb`, `#rrggbbaa` — die Farbgrammatik der Themefähigkeit. */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Auf zwei Stellen gerundet — dieselbe Genauigkeit, in der die Spec messt. */
const gerundet = (x: number) => Math.round(x * 100) / 100

/** Das `~` der Paartabelle markiert einen abgeleiteten Bezug, es gehört nicht zum Namen. */
const ohneTilde = (bezug: Bezug) => bezug.replace('~', '')

/**
 * Der Wert, der in diesem Modus tatsächlich ankommt.
 *
 * Drei Fälle, die auseinandergehalten sein wollen:
 *
 * - `emit: 'component'` hat KEINEN Wurzelwert; das Token wird dort gesetzt, wo
 *   es gilt (`--layout-note-x` im Lesetext, damit das `ch`-Maß im richtigen
 *   Schriftkontext rechnet; die Pfadschalter am Kolumnentitel). Die Seite kann
 *   also nichts anzeigen — leerer Wert, und das ist die Wahrheit, kein
 *   fehlendes Feature.
 * - Abgeleitete Farben rechnen wir aus ihrer Mischvorschrift aus. Das ist genau
 *   der Wert, den der Browser aus dem `color-mix()` bildet, und nur so kann die
 *   Seite Farbwähler und Kontrast zeigen. Gerechnet wird mit dem Auflöser des
 *   Pakets — eine zweite Mischung hier liefe still gegen die geprüfte.
 * - Der Schleier (`--color-scrim`) bleibt seine CSS-Schreibweise: Er trägt eine
 *   Deckung, keinen Farbwert (so auch sein Sperrgrund im Katalog). Ein Hex-Wert
 *   ohne die 62 % behauptete etwas anderes.
 */
function wertVon(modus: Modus, name: TokenName): string {
  const meta = catalog[name]
  // Fängt zugleich die Anzeigeschalter (`level: 'switch'`) ab: Sie tragen einen
  // Zustand, keinen Wert, und sind ausnahmslos `emit: 'component'`. Ein eigener
  // `case 'switch'` unten wäre deshalb unerreichbar — TypeScript weist ihn ab.
  if (meta.emit === 'component') return ''
  switch (meta.level) {
    case 'theme':
      return design[modus][name as ThemeTokenName]
    case 'derived': {
      const formel = design.derived[name as DerivedTokenName]
      return formel.kind === 'veil' ? formulaToCss(formel) : loeseBezug(modus, `~${name}` as Bezug)
    }
    case 'structure':
      return design.structure[name as StructureTokenName]
  }
}

/**
 * Der Kontrastbezug des Tokens, falls die Paartabelle einen kennt.
 *
 * Gemessen wird nur, wo das Token VORNE steht: Ein Kontrast ist die Aussage
 * „diese Schrift auf jener Fläche". Steht ein Token in mehreren Paaren, zählt
 * das erste der Tabelle — deren Reihenfolge ist die der Spec, und das erste
 * Paar ist dort jeweils der Hauptfall (Lesetext auf Papier, nicht auf der
 * Hover-Fläche).
 */
function kontrastVon(modus: Modus, name: TokenName): TokenZeile['kontrast'] {
  const paar = KONTRASTPAARE.find((p) => ohneTilde(p.vorn) === name)
  if (!paar) return undefined
  return {
    wert: gerundet(contrastRatio(loeseBezug(modus, paar.vorn), loeseBezug(modus, paar.hinten))),
    gegen: ohneTilde(paar.hinten),
  }
}

/**
 * Alle Tokens des Modus, gruppiert in der Reihenfolge des Katalogs.
 *
 * Kein Token fällt weg — auch die gesperrten nicht. Die Seite sperrt nichts,
 * sie zeigt den Grund an: `settable` beschreibt, was ein späteres
 * Anwender-Theme setzen dürfte, nicht, was man hier im Browser ausprobieren
 * darf.
 */
export function baueGruppen(modus: Modus): TokenGruppe[] {
  const gruppen = new Map<string, TokenGruppe>()
  for (const name of tokenNames) {
    const meta = catalog[name]
    const wert = wertVon(modus, name)
    const zeile: TokenZeile = {
      name,
      rolle: meta.role,
      istFarbe: HEX.test(wert),
      wert,
      freigegeben: meta.settable,
      ...(meta.settable ? {} : { sperrgrund: meta.lockReason }),
    }
    const kontrast = kontrastVon(modus, name)
    if (kontrast) zeile.kontrast = kontrast

    let gruppe = gruppen.get(meta.group)
    if (!gruppe) {
      gruppe = {
        titel: meta.group,
        zeilen: [],
        ...(meta.group === 'Diagramme' ? { hinweis: HINWEIS_DIAGRAMME } : {}),
      }
      gruppen.set(meta.group, gruppe)
    }
    gruppe.zeilen.push(zeile)
  }
  return [...gruppen.values()]
}

const MODI: Modus[] = ['light', 'dark']

const leer = (): Record<Modus, Record<string, string>> => ({ light: {}, dark: {} })

/**
 * localStorage-Rohwert -> Überschreibungen je Modus.
 *
 * Wirft nie: Im localStorage steht, was irgendwann einmal jemand oder irgendeine
 * Vorversion hineingeschrieben hat. Ein Fehler beim Lesen bräche die
 * Einstellungsseite genau für die Anwender, die sie am dringendsten brauchen —
 * die mit einem kaputten Eintrag. Was sich nicht als Zeichenkette lesen lässt,
 * fällt weg; der Rest bleibt.
 */
export function leseUeberschreibungen(roh: string | null): Record<Modus, Record<string, string>> {
  if (!roh) return leer()
  let geparst: unknown
  try {
    geparst = JSON.parse(roh)
  } catch {
    return leer()
  }
  if (typeof geparst !== 'object' || geparst === null || Array.isArray(geparst)) return leer()

  const werte = leer()
  for (const modus of MODI) {
    const teil = (geparst as Record<string, unknown>)[modus]
    if (typeof teil !== 'object' || teil === null || Array.isArray(teil)) continue
    for (const [name, wert] of Object.entries(teil)) {
      if (typeof wert === 'string') werte[modus][name] = wert
    }
  }
  return werte
}

/** Überschreibungen -> localStorage-Rohwert. */
export function schreibeUeberschreibungen(werte: Record<Modus, Record<string, string>>): string {
  return JSON.stringify(werte)
}
