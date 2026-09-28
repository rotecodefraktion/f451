/**
 * Token-Katalog des Erscheinungsbilds 2026 („Editorial").
 *
 * Quelle: `docs/design/mockups-2026/editorial.html`, Kapitel 4 „Tokens" —
 * 103 Deklarationen, dazu zwei Nachträge (s. `addedAfterMockup`), zusammen
 * 105. Dieser Katalog beschreibt jedes davon EINMAL: auf welcher
 * Ebene es liegt, in welche Gruppe der späteren Einstellungsseite es gehört,
 * welche Rolle es im Klartext hat und ob ein Anwender-Theme es setzen darf.
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
 */
export type TokenEmit = 'css' | 'component' | 'generator'

type TokenMetaBase = {
  readonly level: TokenLevel
  readonly group: TokenGroup
  /** Rolle im Klartext, Wortlaut aus Kapitel 4 des Entwurfs. */
  readonly role: string
  readonly emit: TokenEmit
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
    emit: 'css',
  },
  '--color-bg-raised': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'abgesetzte Fläche: Karte, Diagrammkasten',
    settable: true,
    emit: 'css',
  },
  '--color-bg-sunken': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'zurückgesetzter Rand: Navigation, Umfeld',
    settable: true,
    emit: 'css',
  },
  '--color-text': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Tinte: Lesetext, primäre Schaltfläche',
    settable: true,
    emit: 'css',
  },
  '--color-text-muted': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Nebentext: Marginalie, Metazeile, Etikett',
    settable: true,
    emit: 'css',
  },
  '--color-accent': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Bedeutung: Verweise, Position im Text, Fokus',
    settable: true,
    emit: 'css',
  },
  '--color-accent-contrast': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Schrift auf Akzentfläche',
    settable: true,
    emit: 'css',
  },
  '--color-border': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'Haarlinie: Trennung im Satz',
    settable: true,
    emit: 'css',
  },
  '--color-danger': {
    level: 'theme',
    group: 'Grundfarben',
    role: 'zerstörende Aktion, Fehlerblock',
    settable: true,
    emit: 'css',
  },
  '--color-status-working': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'Entwurf',
    settable: true,
    emit: 'css',
  },
  '--color-status-review': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'In Review, Warnung',
    settable: true,
    emit: 'css',
  },
  '--color-status-released': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'Released, Erfolg',
    settable: true,
    emit: 'css',
  },
  '--color-status-archived': {
    level: 'theme',
    group: 'Workflow-Status',
    role: 'Archiviert',
    settable: true,
    emit: 'css',
  },
  '--color-code-bg': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Fläche des Codeblocks (Papierton, kein Kasten)',
    settable: true,
    emit: 'css',
  },
  '--color-code-text': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Code-Tinte',
    settable: true,
    emit: 'css',
  },
  '--color-code-comment': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Kommentar (kursiv, nie farbig codiert)',
    settable: true,
    emit: 'css',
  },
  '--color-code-gutter': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Zeilennummern, Verzeichnisziffern',
    settable: true,
    emit: 'css',
  },
  '--color-mark': {
    level: 'theme',
    group: 'Satz von Code und Markierung',
    role: 'Textmarker, Suchtreffer',
    settable: true,
    emit: 'css',
  },
  '--shadow-sm': {
    level: 'theme',
    group: 'Schatten',
    role: 'primäre Schaltfläche',
    settable: true,
    emit: 'css',
  },
  '--shadow-md': {
    level: 'theme',
    group: 'Schatten',
    role: 'Dialog, Register',
    settable: true,
    emit: 'css',
  },
  '--shadow-accent': {
    level: 'theme',
    group: 'Schatten',
    role: 'reserviert (Akzentfläche)',
    settable: true,
    emit: 'css',
  },

  // ---- Ebene 2: abgeleitete Farben (13) ----------------------------------
  '--color-border-hair': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'feinste Linie in Tabellen',
    settable: true,
    emit: 'css',
  },
  '--color-border-strong': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'tragende Linie: Eingabefeld, Markerlinie',
    settable: true,
    emit: 'css',
  },
  '--color-glyph-state': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Zeichen, das einen Zustand trägt (Randschalter)',
    settable: true,
    emit: 'css',
  },
  '--color-surface-hover': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Zeile unter dem Zeiger',
    settable: true,
    emit: 'css',
  },
  '--color-accent-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'aktive Zeile in Baum und Register',
    settable: true,
    emit: 'css',
  },
  '--color-accent-line': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'zurückgenommene Akzentlinie',
    settable: true,
    emit: 'css',
  },
  '--color-danger-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche des Fehlerblocks',
    settable: true,
    emit: 'css',
  },
  '--color-status-working-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche Entwurf / Hinweis',
    settable: true,
    emit: 'css',
  },
  '--color-status-review-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche In Review / Warnung',
    settable: true,
    emit: 'css',
  },
  '--color-status-released-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche Released / Erfolg',
    settable: true,
    emit: 'css',
  },
  '--color-status-archived-wash': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fläche Archiviert',
    settable: true,
    emit: 'css',
  },
  '--color-focus': {
    level: 'derived',
    group: 'Abgeleitet',
    role: 'Fokusring (= Akzent)',
    settable: true,
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

  // ---- Ebene 3: strukturelle Tokens (69) ---------------------------------
  '--font-text': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Lesetext — der Kern der These',
    settable: true,
    emit: 'css',
  },
  '--font-display': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Überschriften, Titel',
    settable: true,
    emit: 'css',
  },
  '--font-sans': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Bedienoberfläche, Etiketten, Tabellen',
    settable: true,
    emit: 'css',
  },
  '--font-mono': {
    level: 'structure',
    group: 'Schriftfamilien',
    role: 'Code, Konsole, Werte',
    settable: true,
    emit: 'css',
  },

  '--text-2xs': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Kleinstbeschriftung: Tastenkürzel, Zähler, Graph-Etiketten',
    settable: true,
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
    emit: 'css',
  },
  '--text-sm': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Bedienoberfläche, Tabelle, Code',
    settable: true,
    emit: 'css',
  },
  '--text-ui': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Grundschrift der Bedienoberfläche (body)',
    settable: true,
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
    emit: 'css',
  },
  '--text-lg': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Vorspann, h3',
    settable: true,
    emit: 'css',
  },
  '--text-xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'h2 im Satz',
    settable: true,
    emit: 'css',
  },
  '--text-2xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Kapitelüberschrift',
    settable: true,
    emit: 'css',
  },
  '--text-3xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Seitentitel',
    settable: true,
    emit: 'css',
  },
  '--text-4xl': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Titelei des Musterbuchs',
    settable: true,
    emit: 'css',
  },
  '--cap-ratio': {
    level: 'structure',
    group: 'Schriftgrößen',
    role: 'Versalhöhe der Serifenfamilie als Anteil der Schriftgröße',
    settable: true,
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
    emit: 'css',
  },
  '--leading-heading': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Überschriften',
    settable: true,
    emit: 'css',
  },
  '--leading-ui': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Bedienoberfläche',
    settable: true,
    emit: 'css',
  },
  '--leading-text': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Lesetext',
    settable: true,
    emit: 'css',
  },
  '--leading-code': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Codeblock',
    settable: true,
    emit: 'css',
  },
  '--tracking-tight': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Titel',
    settable: true,
    emit: 'css',
  },
  '--tracking-normal': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Grundwert',
    settable: true,
    emit: 'css',
  },
  '--tracking-caps': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Kapitälchen-Etiketten',
    settable: true,
    emit: 'css',
  },
  '--weight-text': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Lesetext',
    settable: true,
    emit: 'css',
  },
  '--weight-medium': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Reiter, Zweigknoten',
    settable: true,
    emit: 'css',
  },
  '--weight-strong': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Auszeichnung, Schaltflächen',
    settable: true,
    emit: 'css',
  },
  '--weight-display': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Titel',
    settable: true,
    emit: 'css',
  },

  /**
   * Gliederungsnummerierung der Überschriften — ZWEI Tokens, nicht eines.
   *
   * Gewünscht sind drei Einstellungen: aus, nur die obersten Kapitel (Vorgabe,
   * so zeigt es der Entwurf), oder hierarchisch über alle Ebenen (1., 1.1,
   * 1.1.1). Ein einzelnes Inhalts-Token käme damit nur aus, wenn `counters(sec,
   * '.')` an einer h3 die Kette „1.1" liefern könnte. Kann es hier nicht: Die
   * Verschachtelung der CSS-Zähler folgt der DOM-Verschachtelung, und im
   * Lesekörper stehen h2, h3 und h4 als GESCHWISTER nebeneinander (kein
   * `<section>`-Baum). Eine Zählerinstanz, die ein Geschwister aufmacht, ersetzt
   * die vorige auf derselben Ebene, statt sich in sie zu schachteln —
   * `counters()` gäbe also auch dort nur eine einzige Zahl aus. Die Ebenen
   * brauchen deshalb je einen eigenen Zählernamen, und damit steht der INHALT
   * je Ebene fest (`61-lese.css`).
   *
   * Was bleibt, ist genau die Unterscheidung, die die Einstellung braucht:
   * WELCHE Ebenen ihre Ziffer zeigen. Deshalb ein Inhalts-Token für die
   * oberste Ebene (dessen `none` zugleich das Ganze abschaltet) und ein
   * Sichtbarkeits-Token für die Unterebenen. Die drei Einstellungen sind die
   * drei zulässigen Paare:
   *
   *   aus              --heading-number: none            --heading-number-sub: none
   *   oberste Ebene    --heading-number: counter(sec) '.'  --heading-number-sub: none
   *   hierarchisch     --heading-number: counter(sec) '.'  --heading-number-sub: inline-block
   */
  '--heading-number': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Gliederungsziffer der Hauptkapitel: Inhalt der hängenden Ziffer, oder none für keine Nummerierung',
    settable: true,
    emit: 'css',
    addedAfterMockup:
      'Der Entwurf verdrahtet die Ziffer fest (.prose h2::before { content: counter(sec) "." }). Erst die Einstellung „Gliederungsnummerierung" macht daraus einen Wert.',
  },
  '--heading-number-sub': {
    level: 'structure',
    group: 'Satzdetails',
    role: 'Gliederungsziffern der Unterkapitel (h3, h4): inline-block zeigt sie hierarchisch an, none verbirgt sie',
    settable: true,
    emit: 'css',
    addedAfterMockup:
      'Der Entwurf nummeriert nur die Hauptkapitel; die hierarchische Variante ist nach der Abnahme dazugekommen.',
  },

  '--measure': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Zeilenlänge — gilt nur für Fließtext: Absatz, Liste, Zitat, Überschrift',
    settable: false,
    lockReason: 'Trägt die Breitenstufen-Zusage und geht über --layout-note-x in die Randspalte ein.',
    emit: 'css',
  },
  '--measure-wide': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Textbereich mit Randspalte: Marginalie, Hinweisblock, Prozedurtext',
    settable: false,
    lockReason: 'Geht in --layout-app-w ein und verschiebt damit das Verhalten beim Ein- und Ausklappen.',
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
    emit: 'css',
  },
  '--rhythm': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Absatzabstand des Satzspiegels',
    settable: true,
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
    emit: 'css',
  },
  '--space-2': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 2',
    settable: true,
    emit: 'css',
  },
  '--space-3': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 3',
    settable: true,
    emit: 'css',
  },
  '--space-4': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 4',
    settable: true,
    emit: 'css',
  },
  '--space-5': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 5',
    settable: true,
    emit: 'css',
  },
  '--space-6': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 6',
    settable: true,
    emit: 'css',
  },
  '--space-7': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 7',
    settable: true,
    emit: 'css',
  },
  '--space-8': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Grundskala, Stufe 8',
    settable: true,
    emit: 'css',
  },
  '--space-9': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Abstand zwischen Abschnitten',
    settable: true,
    emit: 'css',
  },
  '--space-10': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Kapitelabstand',
    settable: true,
    emit: 'css',
  },
  '--space-11': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Titelei, Grundmaß für Breiten',
    settable: true,
    emit: 'css',
  },
  '--layout-nav-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Breite des Seitenbaums (eingeklappt: Spalte entfällt ganz)',
    settable: false,
    lockReason: GRID_LOCK,
    emit: 'css',
  },
  '--layout-rail-w': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Breite der Info-Leiste (eingeklappt: Spalte entfällt ganz)',
    settable: false,
    lockReason: GRID_LOCK,
    emit: 'css',
  },
  '--layout-gutter': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Steg links und rechts der Dokumentspalte; trägt die hängenden Ziffern',
    settable: false,
    lockReason: GRID_LOCK,
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
    role: 'Breite der Marginalie',
    settable: false,
    lockReason: GRID_LOCK,
    emit: 'css',
  },
  '--layout-note-gap': {
    level: 'structure',
    group: 'Maß, Raster, Dichte',
    role: 'Abstand zwischen Satz und Marginalie',
    settable: false,
    lockReason: GRID_LOCK,
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
    role: 'Außenmaß des Satzspiegels',
    settable: false,
    lockReason: GRID_LOCK,
    emit: 'css',
  },

  '--rule-hair': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Haarlinie',
    settable: true,
    emit: 'css',
  },
  '--rule-strong': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Zäsur, Kartenkopf, Fokusring',
    settable: true,
    emit: 'css',
  },
  '--rule-marker': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Markerlinie an Hinweis, Code, aktivem Eintrag',
    settable: true,
    emit: 'css',
  },
  '--diagram-frame-w': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Rahmen um eingebettete Diagramme — 0 blendet ihn aus',
    settable: true,
    emit: 'css',
    addedAfterMockup:
      'Der Entwurf kennt nur den einen Bildrahmen (.prose img). Dass draw.io- und Excalidraw-Diagramme ihren eigenen Rahmen im SVG mitbringen und dadurch doppelt gerahmt erscheinen, zeigt sich erst an echten Inhalten — der Entwurf zeigt Bilder, keine Diagramme.',
  },
  '--radius-sm': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Inline-Code, Farbfleck',
    settable: true,
    emit: 'css',
  },
  '--radius-md': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Schaltflächen, Felder',
    settable: true,
    emit: 'css',
  },
  '--radius-lg': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Dialog, Register',
    settable: true,
    emit: 'css',
  },
  '--radius-pill': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Status-Chip, Schrittziffer',
    settable: true,
    emit: 'css',
  },
  '--control-h': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'Mindest-Zielgröße aller Bedienelemente',
    settable: false,
    lockReason: 'Zusicherung 4 der Erscheinungsbild-Spec: mindestens 44 × 44 px. Der Wert IST die Zusage.',
    emit: 'css',
  },
  '--control-pad-x': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'waagerechter Innenabstand',
    settable: true,
    emit: 'css',
  },
  '--control-pad-y': {
    level: 'structure',
    group: 'Linien, Radien, Bedienelemente',
    role: 'senkrechter Innenabstand',
    settable: true,
    emit: 'css',
  },

  '--focus-w': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Stärke des Fokusrings',
    settable: true,
    emit: 'css',
  },
  '--focus-offset': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Abstand des Fokusrings',
    settable: true,
    emit: 'css',
  },
  '--motion-fast': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Übergänge (bei reduzierter Bewegung aus)',
    settable: true,
    emit: 'css',
  },
  '--motion-ease': {
    level: 'structure',
    group: 'Fokus und Bewegung',
    role: 'Beschleunigung',
    settable: true,
    emit: 'css',
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
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand und Trennlinie einer Bahn',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-label': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Beschriftung der Bahn (senkrecht im Kopf)',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-terminal-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche von Anfang und Ende',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-terminal-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand von Anfang und Ende',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-step-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche eines Schritts',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-step-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand eines Schritts im Bahnendiagramm',
    settable: true,
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
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-decision-fill': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Fläche einer Entscheidung (Raute)',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-decision-stroke': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Rand einer Entscheidung',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-label-color': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Schrift in Kästen und Rauten',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-edge-color': {
    level: 'theme',
    group: 'Diagramme',
    role: 'Verbindungslinie samt Pfeilspitze',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },

  '--diagram-lane-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe einer Bahn',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-title-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite des Bahnenkopfs mit der senkrechten Beschriftung',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-step-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite eines Schritts im Bahnendiagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-step-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe eines Schritts im Bahnendiagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-lane-step-gap': {
    level: 'structure',
    group: 'Diagramme',
    role: 'waagerechter Rasterabstand der Schritte (Mitte zu Mitte)',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-node-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite eines Knotens im Flussdiagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-node-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe eines Schritts im Flussdiagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-terminal-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe von Anfang und Ende im Flussdiagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-decision-w': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Breite einer Entscheidung',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-decision-h': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Höhe einer Entscheidung',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-flow-row-gap': {
    level: 'structure',
    group: 'Diagramme',
    role: 'senkrechter Rasterabstand der Zeilen im Flussdiagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-corner-arc': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Eckenrundung von Anfang und Ende (mxGraph-arcSize)',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-font-family': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Schrift der Beschriftungen im Diagramm',
    settable: true,
    emit: 'generator',
    addedAfterMockup: DIAGRAM_NEW,
  },
  '--diagram-font-size': {
    level: 'structure',
    group: 'Diagramme',
    role: 'Schriftgröße der Beschriftungen; bestimmt zugleich den Zeilenumbruch',
    settable: true,
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
