/**
 * Token-Katalog des Erscheinungsbilds 2026 („Editorial").
 *
 * Quelle: `docs/design/mockups-2026/editorial.html`, Kapitel 4 „Tokens" —
 * 103 Deklarationen, dazu die Nachträge (s. `addedAfterMockup`: Klassen,
 * Diagramme, Telefon) — die Zahlen je Ebene und Gruppe stehen in
 * `catalog.test.ts`. Dieser Katalog beschreibt jedes Token EINMAL: auf welcher
 * Ebene es liegt, in welche Gruppe der späteren Einstellungsseite es gehört,
 * welche Rolle es im Klartext hat, ob ein Anwender-Theme es setzen darf und
 * in welchem Wertbereich (`range`, Theming-Spec 2026-10-02 §4).
 *
 * Warum Katalog und Werte getrennt sind: Die Rollentexte werden von der
 * Einstellungsseite „Erscheinungsbild" angezeigt
 * (`2026-07-26-themefaehigkeit-design.md`, Abschnitt „Aufbau der Seite").
 * Stünden sie dort noch einmal, liefen sie mit jeder Wertänderung
 * auseinander — und zwar still, weil eine falsche Rollenbeschreibung
 * niemanden anschreit.
 *
 * Warum `settable`/`lockReason` schon hier stehen, obwohl es noch keine
 * Anwender-Themes gibt: Die Positivliste ist eine fachliche Entscheidung, die
 * je Token begründet gefallen ist (a. a. O., „Positivliste"). Wer sie später
 * aus Werten oder Namen rekonstruieren muss, erfindet sie neu — und zwar
 * anders.
 */

/**
 * Die drei Erzeugungsebenen des Entwurfs plus die Anzeigeschalter.
 *
 * - `theme`     — je ein Wert für Hell und Dunkel (Farben, Schatten).
 * - `derived`   — aus Theme-Farben gemischt, gilt in jedem Theme-Kontext.
 * - `structure` — theme-unabhängig: Typografie, Raum, Layout, Bewegung.
 * - `switch`    — kein Wert, sondern ein Anzeigezustand (nur lokal gesetzt).
 */
export type TokenLevel = 'theme' | 'derived' | 'structure' | 'switch'

/** Abschnitte der Einstellungsseite, Reihenfolge wie im Entwurf. */
export type TokenGroup =
  | 'Grundfarben'
  | 'Workflow-Status'
  | 'Satz von Code und Markierung'
  | 'Abgeleitet'
  | 'Schatten'
  | 'Schriftfamilien'
  | 'Schriftgrößen'
  | 'Satzdetails'
  | 'Maß, Raster, Dichte'
  | 'Linien, Radien, Bedienelemente'
  | 'Fokus und Bewegung'
  | 'Bausteine'
  | 'Rahmen'
  | 'Anzeigeschalter'
  | 'Diagramme'

/**
 * Wohin der Wert erzeugt wird.
 *
 * `component` heißt: Das Token existiert, hat aber keinen Wurzelwert — es wird
 * dort gesetzt, wo es gilt (`--layout-note-x` im Lesetext, damit das
 * `ch`-Maß im richtigen Schriftkontext rechnet; die Pfadschalter am
 * Kolumnentitel). Ein Wurzelwert wäre für diese drei nicht nur überflüssig,
 * sondern falsch.
 *
 * `generator` heißt: Der Wert speist den Diagramm-Generator, nicht das
 * Stylesheet. Ein Diagramm wird als Bild eingebunden, und ein SVG in einem
 * Bild-Element ist ein abgeschottetes Dokument — die CSS-Variablen der
 * Anwendung existieren dort nicht (`routes/media.ts` setzt dafür ausdrücklich
 * eine Sandbox-Richtlinie). Ein Wurzelwert im Stylesheet erweckte den Eindruck,
 * eine Farbänderung wirke auf vorhandene Diagramme; sie wirkt ausschließlich
 * auf neu erzeugte.
 *
 * `attribute` heißt: Das Token ist ein Bauart-Schalter (Gruppe „Bausteine").
 * Es erzeugt keine CSS-Variable, sondern ein `data-<name>`-Attribut am
 * `<html>` (nur bei Abweichung von Editorial, `toAttributes` in theme.ts);
 * die Bausteine verzweigen darauf per Attributselektor.
 */
export type TokenEmit = 'css' | 'component' | 'generator' | 'attribute'

/**
 * Wertgrammatik und Grenzen eines setzbaren Tokens.
 *
 * Jedes setzbare Token trägt genau eine; `checkValue` (grammar.ts) prüft einen
 * Wert dagegen, bevor er je ins CSS gelangt. Grenzen sind einschließlich, bei
 * `length` in der jeweiligen Einheit, bei `duration` in Millisekunden.
 *
 * - `text-size` — 0,5–6 rem oder die eingeschränkte `clamp()`-Form.
 * - `choice`    — exakter Treffer; für die Paare der Gliederungsnummerierung.
 */
export type TokenRange =
  | { kind: 'hex' }
  | { kind: 'length'; units: readonly ('px' | 'rem' | 'em' | 'ch')[]; min: number; max: number }
  | { kind: 'number'; min: number; max: number; integer?: boolean }
  | { kind: 'duration'; min: number; max: number }
  | { kind: 'font-stack' }
  | { kind: 'easing' }
  | { kind: 'shadow' }
  | { kind: 'text-size' }
  | { kind: 'choice'; values: readonly string[] }

type TokenMetaBase = {
  readonly level: TokenLevel
  readonly group: TokenGroup
  /** Rolle im Klartext, Wortlaut aus Kapitel 4 des Entwurfs. */
  readonly role: string
  readonly emit: TokenEmit
  /** Grammatik und Grenzen; Pflicht für jedes setzbare Token, bei gesperrten abwesend (`catalog.test.ts`). */
  readonly range?: TokenRange
  /**
   * Gesetzt, wenn das Token NACH der Abnahme hinzugekommen ist — der
   * Referenzentwurf kennt es nicht.
   *
   * Die Tests lesen die Namen aus `editorial.html` und verlangen Gleichstand
   * (`catalog.test.ts`, `css.test.ts`). Das ist die richtige Grundregel: Ein
   * vergessenes Token fiele sonst erst auf, wenn ein Baustein es braucht. Ein
   * Nachtrag darf sie aber nicht dazu zwingen, den abgenommenen Entwurf
   * nachträglich umzuschreiben — die Vorlage bleibt, was sie war. Deshalb hier
   * eine EINZELN begründete Ausnahme statt einer zweiten Liste im Test: Wer
   * nachträgt, muss sagen, warum der Entwurf es nicht hat.
   */
  readonly addedAfterMockup?: string
}

/**
 * Ein gesperrtes Token MUSS seine Begründung mitbringen: Die
 * Einstellungsseite zeigt sie als sichtbaren Nebentext an — eine Sperre ohne
 * Begründung sieht dort aus wie ein fehlendes Feature.
 */
export type TokenMeta =
  | (TokenMetaBase & { readonly settable: true })
  | (TokenMetaBase & { readonly settable: false; readonly lockReason: string })

const GRID_LOCK =
  'Rasterwerk: trägt die Monotonie-Zusage („beim Verschmälern kommt nie etwas hinzu") und die Haltepunkte.'

/**
 * Begründung für die 26 Diagramm-Tokens — einmal formuliert statt 26-mal
 * abgeschrieben. Sie ist für alle dieselbe, weil sie für alle denselben Grund
 * hat: Der Entwurf zeigt Bilder, keine Diagramme.
 */
const DIAGRAM_NEW =
  'Der Referenzentwurf zeigt Bilder, keine Diagramme — er hat für den Hausstil der Prozessgrafiken keinen Wert. '
  + 'Die Werte stammen aus zwei vom Auftraggeber im draw.io-Editor erstellten Vorlagen '
  + '(docs/design/diagramm-vorlagen/) und sind laut 2026-07-27-mcp-anhaenge-design.md verbindlich.'

export const catalog = {
  // ---- Ebene 1: theme-abhängige Farben und Schatten (21) ------------------
  '--color-bg': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Papier: Lese- und Grundfläche',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-bg-raised': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'abgesetzte Fläche: Karte, Diagrammkasten',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-bg-sunken': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'zurückgesetzter Rand: Navigation, Umfeld',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-text': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Tinte: Lesetext, primäre Schaltfläche',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-text-muted': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Nebentext: Marginalie, Metazeile, Etikett',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-accent': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Bedeutung: Verweise, Position im Text, Fokus',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-accent-contrast': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Schrift auf Akzentfläche',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-border': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Haarlinie: Trennung im Satz',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-danger': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'zerstörende Aktion, Fehlerblock',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-working': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'Entwurf',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-review': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'In Review, Warnung',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-released': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'Released, Erfolg',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-archived': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'Archiviert',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-code-bg': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Fläche des Codeblocks (Papierton, kein Kasten)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-code-text': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Code-Tinte',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-code-comment': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Kommentar (kursiv, nie farbig codiert)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-code-gutter': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Zeilennummern, Verzeichnisziffern',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-mark': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Textmarker, Suchtreffer',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--shadow-sm': {
    level: 'theme',
    group: 'Schatten',
    role: 'primäre Schaltfläche',
    settable: true,
    range: { kind: 'shadow' },
    emit: 'css',
  },
  '--shadow-md': {
    level: 'theme',
    group: 'Schatten',
    role: 'Dialog, Register',
    settable: true,
    range: { kind: 'shadow' },
    emit: 'css',
  },
  '--shadow-accent': {
    level: 'theme',
    group: 'Schatten',
    role: 'reserviert (Akzentfläche)',
    settable: true,
    range: { kind: 'shadow' },
    emit: 'css',
  },

  // ---- Ebene 2: abgeleitete Farben (13) ----------------------------------
  '--color-border-hair': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'feinste Linie in Tabellen',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-border-strong': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'tragende Linie: Eingabefeld, Markerlinie',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-glyph-state': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Zeichen, das einen Zustand trägt (Randschalter)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-surface-hover': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Zeile unter dem Zeiger',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-accent-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'aktive Zeile in Baum und Register',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-accent-line': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'zurückgenommene Akzentlinie',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-danger-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche des Fehlerblocks',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-working-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche Entwurf / Hinweis',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-review-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche In Review / Warnung',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-released-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche Released / Erfolg',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-status-archived-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche Archiviert',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-focus': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fokusring (= Akzent)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'css',
  },
  '--color-scrim': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Abdunklung hinter dem Dialog',
    settable: false,
    lockReason:
      'Kein Farbwert, sondern eine Deckung — sie trägt die Zusage, dass ein Dialog seinen Hintergrund wirklich abdeckt.',
    emit: 'css',
  },

  // ---- Ebene 3: strukturelle Tokens ---------------------------------------
  '--font-text': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Lesetext — der Kern der These',
    settable: true,
    range: { kind: 'font-stack' },
    emit: 'css',
  },
  '--font-display': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Überschriften, Titel',
    settable: true,
    range: { kind: 'font-stack' },
    emit: 'css',
  },
  '--font-sans': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Bedienoberfläche, Etiketten, Tabellen',
    settable: true,
    range: { kind: 'font-stack' },
    emit: 'css',
  },
  '--font-mono': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Code, Konsole, Werte',
    settable: true,
    range: { kind: 'font-stack' },
    emit: 'css',
  },

  '--text-2xs': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Kleinstbeschriftung: Tastenkürzel, Zähler, Graph-Etiketten',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
    addedAfterMockup:
      'Der Entwurf kennt keine Stufe unter 12 px, die Anwendung setzte 10 und 11 px aber an elf Stellen als Literal '
      + '(Tastenkürzel, Zähler, Graph). Entscheidung des Auftraggebers vom 2026-09-27 (#77): eine Stufe 11 px statt der Literale.',
  },
  '--text-xs': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Etikett, Marginalie, Bildunterschrift',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-sm': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Bedienoberfläche, Tabelle, Code',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-ui': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Grundschrift der Bedienoberfläche (body)',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
    addedAfterMockup:
      'Der Entwurf setzt den Grundtext der Oberfläche auf 15 px, führt ihn aber nicht als Stufe; 20-basis.css trug ihn '
      + 'deshalb als Literal, dazu 14/15 px an sechs weiteren Stellen. Entscheidung des Auftraggebers vom 2026-09-27 (#77).',
  },
  '--text-md': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Lesetext',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-lg': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Vorspann, h3',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'h2 im Satz',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-2xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Kapitelüberschrift',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-3xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Seitentitel',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--text-4xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Titelei des Musterbuchs',
    settable: true,
    range: { kind: 'text-size' },
    emit: 'css',
  },
  '--cap-ratio': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Versalhöhe der Serifenfamilie als Anteil der Schriftgröße',
    settable: true,
    range: { kind: 'number', min: 0.5, max: 0.85 },
    emit: 'css',
  },
  '--text-hang': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'hängende Gliederungsziffer: so hoch wie die Versalien der h2 daneben',
    settable: false,
    lockReason:
      'Rechnet sich aus --text-xl × --cap-ratio. Beide Eingänge sind setzbar; ein dritter, freier Wert könnte die Kopplung nur zerreißen.',
    emit: 'css',
  },

  '--leading-tight': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'große Titel',
    settable: true,
    range: { kind: 'number', min: 1.0, max: 2.4 },
    emit: 'css',
  },
  '--leading-heading': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Überschriften',
    settable: true,
    range: { kind: 'number', min: 1.0, max: 2.4 },
    emit: 'css',
  },
  '--leading-ui': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Bedienoberfläche',
    settable: true,
    range: { kind: 'number', min: 1.0, max: 2.4 },
    emit: 'css',
  },
  '--leading-text': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Lesetext',
    settable: true,
    range: { kind: 'number', min: 1.0, max: 2.4 },
    emit: 'css',
  },
  '--leading-code': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Codeblock',
    settable: true,
    range: { kind: 'number', min: 1.0, max: 2.4 },
    emit: 'css',
  },
  '--tracking-tight': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Titel',
    settable: true,
    range: { kind: 'length', units: ['em'], min: -0.05, max: 0.3 },
    emit: 'css',
  },
  '--tracking-normal': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Grundwert',
    settable: true,
    range: { kind: 'length', units: ['em'], min: -0.05, max: 0.3 },
    emit: 'css',
  },
  '--tracking-caps': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Kapitälchen-Etiketten',
    settable: true,
    range: { kind: 'length', units: ['em'], min: -0.05, max: 0.3 },
    emit: 'css',
  },
  '--weight-text': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Lesetext',
    settable: true,
    range: { kind: 'number', min: 100, max: 900, integer: true },
    emit: 'css',
  },
  '--weight-medium': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Reiter, Zweigknoten',
    settable: true,
    range: { kind: 'number', min: 100, max: 900, integer: true },
    emit: 'css',
  },
  '--weight-strong': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Auszeichnung, Schaltflächen',
    settable: true,
    range: { kind: 'number', min: 100, max: 900, integer: true },
    emit: 'css',
  },
  '--weight-display': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Titel',
    settable: true,
    range: { kind: 'number', min: 100, max: 900, integer: true },
    emit: 'css',
  },

  '--measure': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Zeilenlänge — gilt nur für Fließtext: Absatz, Liste, Zitat, Überschrift. Korridor 60–80ch: darin bleibt die Randspalte rechenbar (--layout-note-x).',
    settable: true,
    range: { kind: 'length', units: ['ch'], min: 60, max: 80 },
    emit: 'css',
  },
  '--measure-wide': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Textbereich mit Randspalte: Marginalie, Hinweisblock, Prozedurtext. Korridor 80–120ch: --layout-app-w rechnet sich daraus mit, die Einklapp-Zusage bleibt erhalten.',
    settable: true,
    range: { kind: 'length', units: ['ch'], min: 80, max: 120 },
    emit: 'css',
  },
  '--measure-full': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Ausbruch: Tabelle, Codeblock, Diagramm, Bild — volle Breite der Dokumentspalte',
    settable: false,
    lockReason:
      '100 % IST die Zusage „Tabelle, Code, Diagramm nutzen die volle Breite" — jeder andere Wert nimmt sie zurück.',
    emit: 'css',
  },
  '--density': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Faktor aller Innenabstände',
    settable: true,
    range: { kind: 'number', min: 0.75, max: 1.5 },
    emit: 'css',
  },
  '--rhythm': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Absatzabstand des Satzspiegels',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0.5, max: 3 },
    emit: 'css',
  },
  '--space-0': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Nullwert für Rechnungen (z. B. Untergrenze des Randabstands)',
    settable: false,
    lockReason: 'Rechen-Null. Ein --space-0 ≠ 0 ist kein Gestaltungswunsch, sondern ein Rechenfehler.',
    emit: 'css',
  },
  '--space-1': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 1',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-2': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 2',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-3': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 3',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-4': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 4',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-5': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 5',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-6': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 6',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-7': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 7',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-8': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 8',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-9': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Abstand zwischen Abschnitten',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-10': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Kapitelabstand',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--space-11': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Titelei, Grundmaß für Breiten',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 8 },
    emit: 'css',
  },
  '--layout-nav-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Breite des Seitenbaums (eingeklappt: Spalte entfällt ganz). Korridor 200–360px: Die Haltepunkte rechnen mit der Breite, und der Korridor bleibt unter ihrer Schranke.',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 200, max: 360 },
    emit: 'css',
  },
  '--layout-rail-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Breite der Info-Leiste (eingeklappt: Spalte entfällt ganz). Korridor 200–360px: Die Haltepunkte rechnen mit der Breite, und der Korridor bleibt unter ihrer Schranke.',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 200, max: 360 },
    emit: 'css',
  },
  '--layout-gutter': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Steg links und rechts der Dokumentspalte; trägt die hängenden Ziffern. Korridor 0,5–3rem: Der Steg bleibt breit genug für --layout-hang und nimmt dem Inhalt nie mehr als die Randspalte.',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0.5, max: 3 },
    emit: 'css',
  },
  '--layout-hang': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Rand für hängende Ziffern',
    settable: false,
    lockReason: GRID_LOCK,
    emit: 'css',
  },
  '--layout-note-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Breite der Marginalie. Korridor 160–320px: schmal genug, dass die Randspalte vor dem Satz abbricht, breit genug für ein lesbares Wort.',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 10, max: 20 },
    emit: 'css',
  },
  '--layout-note-gap': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Abstand zwischen Satz und Marginalie. Korridor 0–2rem: Er verschiebt nur die Randspalte, nie den Satz.',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 2 },
    emit: 'css',
  },
  '--layout-note-x': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Startpunkt der Randspalte; im Lesetext berechnet, damit das ch-Maß stimmt',
    settable: false,
    lockReason: `${GRID_LOCK} Zusätzlich ein per @property typisierter Rechenwert.`,
    emit: 'component',
  },
  '--layout-edge-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Außenspalte des Daumenregisters — genau eine Zielgröße breit, in jeder Fensterbreite vorhanden',
    settable: false,
    lockReason: `${GRID_LOCK} Trägt zusätzlich die 44-px-Zielgröße des Daumenregisters.`,
    emit: 'css',
  },
  '--layout-app-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Breite des Lesegerüsts; beim Einklappen fällt genau die Randbreite dem Inhalt zu',
    settable: false,
    lockReason: GRID_LOCK,
    emit: 'css',
  },
  '--layout-sheet-max': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Außenmaß des Satzspiegels. Korridor 480–960px: Er begrenzt nur die Außenbreite, die Spalten darin rechnen sich mit.',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 480, max: 960 },
    emit: 'css',
  },

  '--rule-hair': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Haarlinie',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 0, max: 4 },
    emit: 'css',
  },
  '--rule-strong': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Zäsur, Kartenkopf, Fokusring',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 0, max: 4 },
    emit: 'css',
  },
  '--rule-marker': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Markerlinie an Hinweis, Code, aktivem Eintrag',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 0, max: 4 },
    emit: 'css',
  },
  '--diagram-frame-w': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Rahmen um eingebettete Diagramme — 0 blendet ihn aus',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 0, max: 4 },
    emit: 'css',
    addedAfterMockup:
      'Der Entwurf kennt nur den einen Bildrahmen (.prose img). Dass draw.io- und Excalidraw-Diagramme ihren eigenen Rahmen im SVG mitbringen und dadurch doppelt gerahmt erscheinen, zeigt sich erst an echten Inhalten — der Entwurf zeigt Bilder, keine Diagramme.',
  },
  '--radius-sm': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Inline-Code, Farbfleck',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 2 },
    emit: 'css',
  },
  '--radius-md': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Schaltflächen, Felder',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 2 },
    emit: 'css',
  },
  '--radius-lg': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Dialog, Register',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 2 },
    emit: 'css',
  },
  '--radius-pill': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Status-Chip, Schrittziffer',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 100 },
    emit: 'css',
  },
  '--control-h': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Mindest-Zielgröße aller Bedienelemente. Korridor 44–64px: Die Untergrenze IST Zusicherung 4 (mindestens 44 × 44 px), nach oben ist nur mehr Platz.',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 44, max: 64 },
    emit: 'css',
  },
  '--control-pad-x': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'waagerechter Innenabstand',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 2 },
    emit: 'css',
  },
  '--control-pad-y': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'senkrechter Innenabstand',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 2 },
    emit: 'css',
  },

  '--focus-w': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Stärke des Fokusrings',
    settable: true,
    range: { kind: 'length', units: ['px'], min: 2, max: 6 },
    emit: 'css',
  },
  '--focus-offset': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Abstand des Fokusrings',
    settable: true,
    range: { kind: 'length', units: ['rem'], min: 0, max: 0.5 },
    emit: 'css',
  },
  '--motion-fast': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Übergänge (bei reduzierter Bewegung aus)',
    settable: true,
    range: { kind: 'duration', min: 0, max: 400 },
    emit: 'css',
  },
  '--motion-ease': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Beschleunigung',
    settable: true,
    range: { kind: 'easing' },
    emit: 'css',
  },

  // ---- Bausteine (13) — Bauart-Schalter, 2026-10-04-theming-struktur-1 ----
  '--table-style': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Tabelle im Lesetext: open ohne Rahmen mit Tintenlinie unter dem Kopf, framed mit Rahmen, Rundung und getöntem Kopf',
    settable: true,
    range: { kind: 'choice', values: ['open', 'framed'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf baut die Tabelle offen; die vier anderen Entwürfe und die Anwendung vor 1.2.5 rahmen sie.',
  },
  '--callout-style': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Hinweisblock: bar nur mit linkem Balken, box als umrandeter Kasten',
    settable: true,
    range: { kind: 'choice', values: ['bar', 'box'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf baut den Hinweisblock fest als Balken; Fokus, Klar & Warm und Werkbank zeigen den Kasten.',
  },
  '--card-top-rule': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Karte und Dialog: on mit 2-px-Tintenlinie oben, off ohne',
    settable: true,
    range: { kind: 'choice', values: ['on', 'off'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf gibt Karte und Dialog eine Oberlinie; die anderen Entwürfe und die Anwendung vor 1.2.5 nicht.',
  },
  '--button-primary': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Primärknopf: ink in Textfarbe, accent in Akzentfarbe mit Akzent-Kontrastschrift',
    settable: true,
    range: { kind: 'choice', values: ['ink', 'accent'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf setzt den Primärknopf fest in Tinte; die vier anderen Entwürfe in Akzent.',
  },
  '--chip-style': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Statusmarke: outline-caps mit Versalien und Kontur, filled gefüllt in Gemischtschreibung, marker mit Formmarke statt Zeichen',
    settable: true,
    range: { kind: 'choice', values: ['outline-caps', 'filled', 'marker'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf kennt nur die Versalienmarke; gefüllte Marke (Fokus, Klar & Warm) und Formmarke (System/Raster) kommen aus den anderen Entwürfen.',
  },
  '--heading-number': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Gliederungsziffer der Kapitelüberschriften: numeral zeigt sie, none verbirgt sie',
    settable: true,
    range: { kind: 'choice', values: ['numeral', 'none'] },
    emit: 'attribute',
    addedAfterMockup:
      'Der Entwurf verdrahtet die Ziffer fest (.prose h2::before { content: counter(sec) "." }). Erst die Einstellung „Gliederungsnummerierung" macht daraus einen Wert; seit 1.2.5 ein Schalter statt eines CSS-Werts.',
  },
  '--heading-depth': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Tiefe der Gliederungsziffern: top nur an Hauptkapiteln (h2), all auch an h3 und h4',
    settable: true,
    range: { kind: 'choice', values: ['top', 'all'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf nummeriert nur die Hauptkapitel; die hierarchische Variante ist nach der Abnahme dazugekommen (vormals --heading-number-sub).',
  },
  '--toc-style': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Inhaltsverzeichnis der Leiste: numbered-progress mit Kapitelnummern und Fortschrittslinie, bar als Liste an einem Balken',
    settable: true,
    range: { kind: 'choice', values: ['numbered-progress', 'bar'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf nummeriert das Inhaltsverzeichnis und führt eine Fortschrittslinie; die anderen Entwürfe und die Anwendung vor 1.2.5 zeigen den Balken.',
  },
  '--tree-guides': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Seitenbaum: on mit Führungslinien je Einrückungsstufe, off ohne',
    settable: true,
    range: { kind: 'choice', values: ['on', 'off'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf zeichnet Führungslinien im Baum; die anderen Entwürfe und die Anwendung vor 1.2.5 nicht.',
  },
  '--code-header': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Codeblock: on zeigt eine Kopfzeile mit der Sprache, off keine',
    settable: true,
    range: { kind: 'choice', values: ['off', 'on'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf zeigt Codeblöcke ohne Kopf; Fokus, Klar & Warm und Werkbank tragen eine Kopfzeile.',
  },
  '--rail-blocks': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Blöcke der Info-Leiste: rules durch Haarlinien getrennt, plain als Abschnitte ohne Rahmen und Linien, cards als Karten',
    settable: true,
    range: { kind: 'choice', values: ['rules', 'plain', 'cards'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf trennt die Leistenblöcke durch Haarlinien; die Anwendung vor 1.2.5 setzt sie schlicht, Klar & Warm und Werkbank als Karten.',
  },
  '--list-marker': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Aufzählungszeichen im Lesetext: disc Punkt, dash Gedankenstrich',
    settable: true,
    range: { kind: 'choice', values: ['disc', 'dash'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf lässt dem Browser den Punkt; System/Raster und Werkbank setzen den Gedankenstrich.',
  },
  '--marginalia': {
    level: 'structure',
    group: 'Bausteine',
    role: 'Fußnoten im Lesetext: margin als Randnotiz neben dem Absatz (in schmaler Spalte darunter), list als Fußnotenliste am Seitenende',
    settable: true,
    range: { kind: 'choice', values: ['margin', 'list'] },
    emit: 'attribute',
    addedAfterMockup:
      'Der Entwurf setzt Randnotizen; Markdown hat dafür nur GFM-Fußnoten, deren Ort der Schalter bestimmt. System/Raster, Werkbank und die Anwendung vor 1.2.5 lassen sie am Ende.',
  },

  // ---- Rahmen (5) — Rahmenschalter, 2026-10-05-theming-struktur-2 ---------
  '--topbar': {
    level: 'structure',
    group: 'Rahmen',
    role: 'Kopfleiste über dem Raster: off ohne, on mit Marke, Suche und Konto',
    settable: true,
    range: { kind: 'choice', values: ['off', 'on'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf kommt ohne Kopfleiste aus; die anderen Entwürfe und die Anwendung vor 1.2.6 tragen eine.',
  },
  '--page-head': {
    level: 'structure',
    group: 'Rahmen',
    role: 'Seitenkopf: title mit Titelzeile und Metazeile, toolbar mit Kolumnentitel, Werkzeugleiste und Zweitleiste',
    settable: true,
    range: { kind: 'choice', values: ['title', 'toolbar'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf setzt die Titelzeile fest; die Anwendung vor 1.2.6 und Werkbank tragen die Werkzeugleiste.',
  },
  '--pane-controls': {
    level: 'structure',
    group: 'Rahmen',
    role: 'Bedienung von Seitenbaum und Info-Leiste: edges mit Daumenregistern am Rand, topbar mit Schaltern in der Kopfleiste (verlangt --topbar: on)',
    settable: true,
    range: { kind: 'choice', values: ['edges', 'topbar'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf öffnet die Leisten über Register am Rand; andere Entwürfe schalten sie aus der Kopfleiste.',
  },
  '--rail-scroll': {
    level: 'structure',
    group: 'Rahmen',
    role: 'Info-Leiste: sticky klebt im Dokument-Scroll, own scrollt für sich',
    settable: true,
    range: { kind: 'choice', values: ['sticky', 'own'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf lässt die Info-Leiste kleben; die Anwendung vor 1.2.6 lässt sie für sich scrollen.',
  },
  '--status-bar': {
    level: 'structure',
    group: 'Rahmen',
    role: 'Statusleiste am Fuß des Hauptbereichs: off ohne, bottom mit Status, Stand und Abschnitt x/y',
    settable: true,
    range: { kind: 'choice', values: ['off', 'bottom'] },
    emit: 'attribute',
    addedAfterMockup: 'Der Entwurf kennt keine Statusleiste; Werkbank zeigt eine am Fuß.',
  },

  // ---- Anzeigeschalter (2) — Zustände, keine Werte ------------------------
  '--crumbs-mid': {
    level: 'switch',
    group: 'Anzeigeschalter',
    role: 'Zwischenebenen des Pfades im Satz oder verborgen (verborgen heißt sr-only, nie display:none)',
    settable: false,
    lockReason:
      'Anzeigezustand des Brotkrumenpfads, an genau einer Stelle ausgewertet — ein Verhaltens-, kein Gestaltungseingriff.',
    emit: 'component',
  },
  '--crumbs-more': {
    level: 'switch',
    group: 'Anzeigeschalter',
    role: 'Marke „…" an ihrer Stelle',
    settable: false,
    lockReason:
      'Anzeigezustand des Brotkrumenpfads, an genau einer Stelle ausgewertet — ein Verhaltens-, kein Gestaltungseingriff.',
    emit: 'component',
  },

  // ---- Diagramme (26) — Hausstil des Generators ---------------------------
  //
  // Dieser Block bricht die Ebenensortierung der Datei bewusst: Farben und
  // Maße stehen hier beieinander, weil sie EINE Sache beschreiben — den Stil,
  // in dem ein Diagramm gezeichnet wird. Auseinandergezogen auf „Ebene 1" und
  // „Ebene 3" wäre die Vorlage, aus der sie stammen, nicht mehr erkennbar.
  //
  // Herkunft: `docs/design/diagramm-vorlagen/` — zwei vom Auftraggeber im
  // draw.io-Editor erstellte Vorlagen, deren Stil-Zeichenketten maßgeblich
  // sind. Die Maße sind einheitenlos: mxGraph-Geometrie kennt keine Einheit,
  // und das erzeugte SVG rechnet in denselben Zahlen.
  //
  // Warum die Farben trotzdem auf der Theme-Ebene liegen, obwohl sie kein CSS
  // erzeugen: Ein Diagramm SOLL im Dunkelmodus anders aussehen dürfen. Der
  // Generator schreibt die Zwei-Modi-Schreibweise `light-dark(hell, dunkel)`
  // ins SVG — die wertet der Browser innerhalb des abgeschotteten Dokuments
  // aus, ohne etwas von außen zu brauchen. Ein Wert je Modus ist genau das,
  // was die Theme-Ebene führt.
  '--diagram-lane-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche einer Bahn (Zuständigkeitsstreifen)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand und Trennlinie einer Bahn',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-label': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Beschriftung der Bahn (senkrecht im Kopf)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-terminal-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche von Anfang und Ende',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-terminal-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand von Anfang und Ende',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-step-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche eines Schritts',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-step-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand eines Schritts im Bahnendiagramm',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  // Die beiden Vorlagen umranden ihre Schritte verschieden (#3b5ba5 im
  // Bahnen-, #5a6b85 im Flussdiagramm). Das ist kein Versehen, das man
  // vereinheitlichen dürfte: Im Bahnendiagramm steht der Rand gegen die
  // graue Bahnfläche, im Flussdiagramm gegen das Papier.
  '--diagram-flow-step-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand eines Schritts im Flussdiagramm',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-decision-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche einer Entscheidung (Raute)',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-decision-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand einer Entscheidung',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-label-color': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Schrift in Kästen und Rauten',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-edge-color': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Verbindungslinie samt Pfeilspitze',
    settable: true,
    range: { kind: 'hex' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },

  '--diagram-lane-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe einer Bahn',
    settable: true,
    range: { kind: 'number', min: 100, max: 500 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-title-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite des Bahnenkopfs mit der senkrechten Beschriftung',
    settable: true,
    range: { kind: 'number', min: 16, max: 80 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-step-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite eines Schritts im Bahnendiagramm',
    settable: true,
    range: { kind: 'number', min: 60, max: 300 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-step-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe eines Schritts im Bahnendiagramm',
    settable: true,
    range: { kind: 'number', min: 24, max: 200 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-step-gap': {
    level: 'structure',
    group: 'Diagramme',
    role: 'waagerechter Rasterabstand der Schritte (Mitte zu Mitte)',
    settable: true,
    range: { kind: 'number', min: 80, max: 400 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-node-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite eines Knotens im Flussdiagramm',
    settable: true,
    range: { kind: 'number', min: 80, max: 400 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-node-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe eines Schritts im Flussdiagramm',
    settable: true,
    range: { kind: 'number', min: 24, max: 200 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-terminal-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe von Anfang und Ende im Flussdiagramm',
    settable: true,
    range: { kind: 'number', min: 24, max: 120 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-decision-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite einer Entscheidung',
    settable: true,
    range: { kind: 'number', min: 80, max: 400 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-decision-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe einer Entscheidung',
    settable: true,
    range: { kind: 'number', min: 40, max: 240 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-row-gap': {
    level: 'structure',
    group: 'Diagramme',
    role: 'senkrechter Rasterabstand der Zeilen im Flussdiagramm',
    settable: true,
    range: { kind: 'number', min: 30, max: 200 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-corner-arc': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Eckenrundung von Anfang und Ende (mxGraph-arcSize)',
    settable: true,
    range: { kind: 'number', min: 0, max: 50 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-font-family': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Schrift der Beschriftungen im Diagramm',
    settable: true,
    range: { kind: 'font-stack' },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-font-size': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Schriftgröße der Beschriftungen; bestimmt zugleich den Zeilenumbruch',
    settable: true,
    range: { kind: 'number', min: 8, max: 32 },
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
} as const satisfies Record<`--${string}`, TokenMeta>

export type TokenName = keyof typeof catalog

type NamesOfLevel<L extends TokenLevel> = {
  [K in TokenName]: (typeof catalog)[K]['level'] extends L ? K : never
}[TokenName]

type NamesOfGroup<G extends TokenGroup> = {
  [K in TokenName]: (typeof catalog)[K]['group'] extends G ? K : never
}[TokenName]

/** Farben und Schatten mit je einem Wert für Hell und Dunkel. */
export type ThemeTokenName = NamesOfLevel<'theme'>
/** Aus Theme-Farben gemischt — gilt in jedem Theme-Kontext. */
export type DerivedTokenName = NamesOfLevel<'derived'>
/** Theme-unabhängig: Typografie, Raum, Layout, Bewegung. */
export type StructureTokenName = NamesOfLevel<'structure'>

export type ShadowTokenName = NamesOfGroup<'Schatten'>
export type ThemeColorTokenName = Exclude<ThemeTokenName, ShadowTokenName>

/** Nur `#rgb`, `#rrggbb`, `#rrggbbaa` — die Farbgrammatik der Themefähigkeit. */
export type HexColor = `#${string}`

export const tokenNames = Object.keys(catalog) as TokenName[]

export function namesOfLevel<L extends TokenLevel>(level: L): NamesOfLevel<L>[] {
  return tokenNames.filter((n) => catalog[n].level === level) as NamesOfLevel<L>[]
}
