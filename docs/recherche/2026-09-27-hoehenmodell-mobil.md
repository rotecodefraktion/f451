# Höhenmodell auf dem Telefon — Recherche zu Issue #65

Recherche-Grundlage für GitHub-Issue #65 (Wegfindungs-Karte, Mobilversion). Reiner
Faktenstand zu Viewport-Einheiten, Bildschirmtastatur und innenliegenden Scrollbereichen auf
Touch-Geräten — keine Bewertung, keine Empfehlung für die App.

## Zusammenfassung

- `dvh` ist die CSS-Einheit, die „so hoch wie der gerade sichtbare Bereich" abbildet — sie liegt
  laut Spezifikation zwischen `svh` (Symbolleisten ausgefahren) und `lvh` (Symbolleisten
  eingefahren) und folgt dem tatsächlichen Zustand der Browser-Oberfläche. `vh` selbst entspricht
  `lvh`, nicht dem sichtbaren Bereich (W3C CSS Values and Units Module Level 4).
- `dvh` aktualisiert laut Chrome-Team-Blog **nicht mit 60 fps**: Alle Browser drosseln die
  Neuberechnung beim Ein-/Ausfahren der Symbolleiste, manche verwerfen Zwischenwerte je nach
  Geste ganz (browserspezifische Unterschiede zwischen iOS Safari, Chrome Android und Firefox
  Android sind dabei nicht mit einer Primärquelle belegbar). `svh`/`lvh`/`dvh` sind dafür breit
  unterstützt (Chrome/Edge 108, Firefox 101, Safari 15.4 macOS+iOS, nach MDN-Kompatibilitätsdaten).
- Bei aufgehender Bildschirmtastatur verkleinert sich unter dem **Standardverhalten von Chrome**
  (`resizes-visual`) nur der *visuelle* Viewport, nicht der Layout-Viewport — `dvh`/`100vh`
  ändern sich dadurch **nicht**, `window.visualViewport.height` dagegen schon. Das Standardmaß
  reicht also nicht aus, um ein Layout automatisch an die Tastatur anzupassen; dafür existieren
  das Meta-Tag `interactive-widget` und `window.visualViewport`.
- `interactive-widget=resizes-content` erzwingt eine echte Verkleinerung von Layout-Viewport und
  `dvh`; unterstützt seit Chrome 108 (nicht auf Chrome iOS/iPadOS) und Firefox 133. WebKit/Safari
  unterstützt es (Stand 27.09.2026) **nicht** — der zugehörige WebKit-Bug ist offen und niemandem
  zugewiesen.
- Die `VirtualKeyboard`-API (`navigator.virtualKeyboard.overlaysContent`,
  `env(keyboard-inset-*)`) ist ein **Chromium-exklusives** Feature (Chrome/Edge ab 94); weder
  Firefox noch Safari unterstützen sie.
- Reale Editor-Bugs (ProseMirror-basiert, u. a. OpenProject/BlockNote, Tiptap) zeigen exakt das
  Szenario dieser App: Ein Editor in einem inneren Scroll-Container fester Höhe
  (`calc(100dvh - Kopfzeile)`) bemerkt die aufgehende Tastatur nicht, weil `dvh` sich unter dem
  Standardverhalten nicht ändert — der Cursor bleibt scheinbar „sichtbar" und wird nicht
  hochgescrollt.
- Zum eigentlichen Scroll-Chaining-Verhalten mehrerer `overflow:auto`-Bereiche auf Touch-Geräten
  gibt es solide Spezifikations- und MDN-Belege (`overscroll-behavior`), aber zur konkreten
  Nebenwirkung „Adressleiste fährt nicht ein, wenn nur ein innerer Container scrollt" ist die
  Beleglage uneinheitlich und veraltet (Apple-Forenbeitrag von 2021 behauptet das Gegenteil) —
  hier ist ein Gerätetest nötig.
- Zu den Fremdwerkzeugen (Notion, Google Docs mobile web, GitHub-Web-Editor, Outline, Obsidian
  Publish) ließ sich **keine** offizielle Dokumentation zu deren internem Scroll-/Höhenmodell
  finden; einzig für Obsidian Publish ist klar dokumentiert, dass es kein Browser-Editor ist.

## Frage 1: `vh`, `svh`, `lvh`, `dvh` — Definitionen, Kosten, Browser

### Definitionen (W3C CSS Values and Units Module Level 4)

Die Spezifikation unterscheidet drei Viewport-Größen und vier Einheitenfamilien:

- **Large Viewport** (`lv*`, und die „normalen" `v*`-Einheiten sind an diese gebunden): Viewport
  so groß angenommen, als wären alle dynamisch ein-/ausfahrbaren UA-Oberflächen (Adressleiste,
  Symbolleisten) **eingefahren**.
- **Small Viewport** (`sv*`): Viewport so klein angenommen, als wären diese Oberflächen
  **ausgefahren**.
- **Dynamic Viewport** (`dv*`): folgt dem tatsächlichen, aktuellen Zustand der Oberflächen; Werte
  liegen zwischen `sv*` und `lv*` und ändern sich, wenn sich die Oberflächen ein-/ausfahren.

Quelle: <https://www.w3.org/TR/css-values-4/> (Abschnitt zu viewport-percentage lengths).

`vh` ist damit **kein** Maß für den gerade sichtbaren Bereich, sondern für den größtmöglichen
Viewport (äquivalent zu `lvh`) — Quelle: MDN, <https://developer.mozilla.org/en-US/docs/Web/CSS/length>.
`dvh` ist die Einheit, die dem „gerade sichtbaren Bereich" am nächsten kommt, weil sie sich mit
dem tatsächlichen Symbolleisten-Zustand mitbewegt (W3C-Spezifikation, s. o.; bestätigt durch
web.dev: <https://web.dev/blog/viewport-units>).

### Kosten von `dvh` bei ein-/ausfahrender Symbolleiste

Die Spezifikation selbst verlangt **keine** Animation der dynamischen Einheiten während des
Ein-/Ausfahrens: „The UA is not required to animate the dynamic viewport-percentage units while
expanding and retracting any relevant interfaces, and may instead calculate the units as if the
relevant interface was fully expanded or retracted during the UI animation" (W3C CSS Values and
Units Module Level 4, <https://www.w3.org/TR/css-values-4/>).

Der Chrome-Team-Blog auf web.dev konkretisiert das für die Praxis: „The values for the dynamic
viewport do not update at 60fps. In all browsers updating is throttled as the UA UI expands or
retracts. Some browsers even debounce updating entirely depending on the gesture (a slow scroll
versus a swipe) used." Quelle: <https://web.dev/blog/viewport-units>. Das bedeutet: `dvh`-Layouts
können während des Ein-/Ausfahrens der Symbolleiste sichtbar nachziehen bzw. springen statt
kontinuierlich mitzulaufen; ein Performance-„Ruckeln" im Sinne von Framedrops ist damit nicht
belegt, wohl aber ein wahrnehmbares Nachlaufen/Springen des Layouts.

### Verhalten je Browser

Eine browserspezifische Aufschlüsselung (iOS Safari vs. Chrome Android vs. Firefox Android) für
das Drosselungsverhalten von `dvh` ist in den geprüften Primärquellen **nicht** enthalten — der
web.dev-Artikel formuliert nur allgemein „in all browsers" bzw. „some browsers". Eine
differenzierte Aussage je Engine ist damit nicht belegbar; das ist **am Gerät zu prüfen**.

Für Safari ist immerhin die Einführung dokumentiert: Safari 15.4 hat `svh`, `lvh`, `dvh` (und die
Breiten-/Logik-Varianten) eingeführt (WebKit-Blog, „New WebKit Features in Safari 15.4",
<https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/>).

### Browser-Unterstützung

Nach MDN-Kompatibilitätsdaten (`browser-compat-data`, Datei `css/types/length.json`,
<https://github.com/mdn/browser-compat-data/blob/main/css/types/length.json>) gilt für
`dvh`/`svh`/`lvh` (und die Geschwister-Einheiten) einheitlich:

| Browser | ab Version |
|---|---|
| Chrome / Edge | 108 |
| Chrome Android | 108 |
| Firefox / Firefox Android | 101 |
| Safari (macOS) | 15.4 |
| Safari iOS | 15.4 |

caniuse (<https://caniuse.com/viewport-unit-variants>) bestätigt diese Werte für
Chrome/Edge/Firefox/Safari, nennt für Samsung Internet aber „ab Version 21" — das ließ sich mit
den MDN-Daten nicht in Übereinstimmung bringen; ein per Fetch ermittelter Wert „Chrome for
Android 152" aus derselben caniuse-Abfrage war erkennbar fehlerhaft (Chrome-Versionsnummern
dieser Größenordnung gab es zum Stichtag nicht) und wurde verworfen. Für Samsung Internet bzw.
andere Chromium-Forks ist die exakte Version **am Gerät/mit einer zweiten Quelle zu prüfen**.

## Frage 2: Bildschirmtastatur

### Layout fester Höhe mit innenliegenden Scrollbereichen

Der zentrale Befund: Browser unterscheiden zwei Viewports — den *Layout-Viewport* (bestimmt u. a.
`vh`/`dvh` und die Position von `position: fixed`) und den *visuellen Viewport* (das, was gerade
sichtbar ist). Beim Aufgehen der Bildschirmtastatur verkleinert sich unter dem **Standard**
lediglich der visuelle Viewport — der Layout-Viewport und damit `100vh`/`100dvh` bleiben
unverändert. Diese Inkonsistenz zwischen Browsern ist Gegenstand eines offenen
CSS-Working-Group-Issues:

„iOS/ChromeOS: shrink the visual viewport, but keep the fixed-position viewport the same. Result:
fixed-position elements can move out of view." / für Android wird beschrieben, dass sich dort die
Seitenhöhe nach dem Erscheinen der Tastatur ändern und dadurch andere Media-Queries greifen
können. Quelle: <https://github.com/w3c/csswg-drafts/issues/7475> (`[css-position-3] Reinterpret
viewport positioned (fixed, sticky) elements wrt virtual keyboard`). Das Issue ist eine
Diskussion, kein verabschiedeter Spec-Text — die dort beschriebenen Browserunterschiede sind
Stand der Diskussion, nicht normativ.

Praktisch heißt das für ein Layout mit `height: calc(100vh - 56px)` und inneren
`overflow`-Bereichen: Die Gesamthöhe der Hülle ändert sich beim Tastatur-Öffnen in der Regel
**nicht** von selbst (weder `vh` noch `dvh` reagieren auf die Tastatur, nur auf die
Symbolleiste) — es sei denn, die Seite fordert über `interactive-widget=resizes-content` explizit
eine echte Verkleinerung an (s. u.). Ohne das bleibt die feste Höhe bestehen und der untere Teil
des Dokuments verschwindet hinter der Tastatur, sichtbar nur über `window.visualViewport`.

### `window.visualViewport`

Die Visual Viewport API stellt u. a. `width`, `height`, `offsetLeft`, `offsetTop`, `scale` sowie
die Events `resize` und `scroll` bereit. Beim Öffnen der Tastatur verkleinert sich `height` um
(ungefähr) die Tastaturhöhe, `offsetTop`/`offsetLeft` ändern sich, wenn der visuelle Viewport
gegenüber dem Layout-Viewport verschoben ist (z. B. durch Pinch-Zoom oder je nach
Browser-Handling der Tastatur). Beide Events feuern bei diesen Änderungen. Baseline-Status laut
MDN: „Widely available" seit August 2021. Quelle:
<https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API>. Eine Spezifikation liegt
als CSSOM-View-Erweiterung vor; die MDN-Seite verlinkt die maßgebliche Definition, ein
eigenständiges W3C/WICG-Dokument mit Editor's Draft wird dort referenziert.

### Viewport-Meta `interactive-widget`

Drei Werte, dokumentiert bei Chrome for Developers
(<https://developer.chrome.com/blog/viewport-resize-behavior>) und in der MDN-Referenz zum
Viewport-Meta-Tag (<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport>):

- **`resizes-visual`** (Chrome-Standard seit Chrome 108): nur der visuelle Viewport wird von der
  Tastatur verkleinert, der Layout-Viewport bleibt gleich.
- **`resizes-content`**: sowohl visueller als auch Layout-Viewport werden verkleinert; das
  Initial Containing Block passt sich an, `dvh`/`100vh` ändern sich also tatsächlich mit der
  Tastatur.
- **`overlays-content`**: keiner der beiden Viewports wird verkleinert, die Tastatur legt sich
  über den Inhalt.

Unterstützung: Chrome ab Version 108 — ausdrücklich **ohne** Chrome auf iOS/iPadOS (dort bestimmt
WebKit das Verhalten), Quelle wie oben. Firefox hat das Feature laut dem als „RESOLVED FIXED"
markierten Bugzilla-Ticket in Firefox 131 ausgeliefert (Mozilla-Bugtracker,
<https://bugzilla.mozilla.org/show_bug.cgi?id=1831649>: „Implement the 'interactive-widget' meta
viewport key, to allow controlling viewport resize behaviour when showing a virtual keyboard" —
Umsetzung u. a. für GeckoView und Fenix, MDN-Dokumentation im Zuge des Tickets aktualisiert).
WebKit/Safari unterstützt es **nicht**: Der zugehörige WebKit-Bug „Implement the
interactive-widget property in the viewport meta tag" steht Stand 17.09.2026 auf Status **NEW**,
niemandem zugewiesen, mit dem Hinweis, dass Chromium für Android das Feature bereits unterstützt.
Quelle: <https://bugs.webkit.org/show_bug.cgi?id=259770>.

### VirtualKeyboard API

`navigator.virtualKeyboard.overlaysContent = true` schaltet das automatische
Browser-Resize-Verhalten ab; die Tastatur legt sich dann über den Inhalt, und die Seite erhält
per CSS-Umgebungsvariablen (`env(keyboard-inset-top/right/bottom/left/width/height)`) die genaue
Position/Größe der Tastatur, um selbst zu layouten. Quelle: Chrome for Developers,
<https://developer.chrome.com/docs/web-platform/virtual-keyboard>.

Unterstützung: Chrome/Edge ab Version 94 (Desktop und Mobile). Weder Firefox noch Safari
unterstützen die API — bestätigt durch MDN: <https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API>
(„Limited availability"). Es handelt sich damit um ein Chromium-exklusives Feature.

### Was ein Editor (ProseMirror/Tiptap) braucht

ProseMirror bietet dafür eingebaute, aber begrenzte Mechanik:

- `EditorProps.scrollThreshold` (Default `0`) — Abstand zwischen Cursor und Rand des sichtbaren
  Bereichs, ab dem beim Scrollen-in-Sicht überhaupt gescrollt wird.
- `EditorProps.scrollMargin` (Default `5`) — zusätzlicher Rand, der beim Scrollen frei bleibt.
- `Transaction.scrollIntoView()` — markiert eine Transaktion, nach der der View die Selektion in
  Sicht scrollen soll.
- `EditorProps.handleScrollToSelection` — erlaubt, die Scroll-Logik selbst zu übernehmen.

Quelle: ProseMirror Reference Manual, <https://prosemirror.net/docs/ref/> (Abschnitt
`prosemirror-view`).

Der entscheidende, dokumentierte Schwachpunkt: ProseMirrors eingebaute Sichtbarkeitsprüfung
bezieht sich nur auf das Fenster/den visuellen Viewport, nicht auf innenliegende
Scroll-Container. Ein konkreter, dem hier untersuchten Fall sehr ähnlicher Bericht stammt aus dem
OpenProject-Projekt (ein ProseMirror-/BlockNote-basierter Editor), das denselben Layout-Zuschnitt
verwendet wie diese App (innerer Scroll-Wrapper mit `height: calc(100dvh - Kopfzeile)`):

„ProseMirror can't see the keyboard in our scroll container. It checks the caret against the
visual viewport only for the window itself." — Weil `dvh` sich unter dem Standardverhalten nicht
mit der Tastatur ändert, hält ProseMirror den Cursor für sichtbar, obwohl die Tastatur ihn
verdeckt; ein zusätzliches, selbst geschriebenes `KeyboardAwareScrollExtension` (reagiert auf
`visualViewport`-Resize) war der Fix. Quelle: OpenProject-Pull-Request #25579,
<https://github.com/opf/openproject/pull/25579>. Hinweis: Das ist keine offizielle
ProseMirror-Dokumentation, sondern die Fehleranalyse eines Drittprojekts, das ProseMirror
(über BlockNote) einsetzt — als Quelle für das *Verhalten* aber unmittelbar einschlägig, weil sie
exakt das hier vorliegende Layout-Muster beschreibt.

Für Tiptap sind zwei einschlägige, offizielle Issues im `ueberdosis/tiptap`-Repository dokumentiert:

- „Android Chrome: typing in a bottom-positioned editor scrolls the page to the top" — Ursache
  laut Analyse im Issue: Beim Öffnen der Tastatur auf Android Chrome schrumpft der visuelle
  Viewport, der Layout-Viewport bleibt gleich; Tiptaps Scroll-Berechnung vergleicht dann
  Koordinaten aus unterschiedlichen Bezugssystemen (Layout- vs. visueller Viewport) und löst ein
  falsches `window.scrollBy` aus. Quelle: <https://github.com/ueberdosis/tiptap/issues/7757>.
- „Losing text selection / focus in mobile browsers" — Selektion geht beim Auf-/Zuklappen der
  Tastatur bzw. bei Toolbar-Interaktion auf iOS Safari verloren. Quelle:
  <https://github.com/ueberdosis/tiptap/issues/1806>.

Als allgemeine Plattform-Grundlage (kein Editor-spezifisches Verhalten, sondern Browser-Baseline)
dokumentiert ein WHATWG-HTML-Issue das Standardverhalten: „Mobile browsers such as Safari (and
soon Chrome once v108 ships) resize the visual viewport when the on screen keyboard (OSK)
appears. As part of this behavior, the browser will scroll the page content so the focused text
input is not obscured by the OSK." Quelle: <https://github.com/whatwg/html/issues/8375>. Dieses
automatische Hochscrollen bezieht sich auf das Gesamtdokument bzw. den fokussierten Eingabepunkt
im Layout-Viewport — ob und wie es mit einem inneren, selbst scrollenden Editor-Container
zusammenspielt, ist in der Quelle nicht behandelt und **am Gerät zu prüfen**.

## Frage 3: Innenliegende Scrollbereiche auf Touch

### Scroll-Chaining und `overscroll-behavior`

„Scroll-Chaining" bezeichnet das Weiterreichen einer Scroll-Geste an das nächste scrollbare
Elternelement, sobald der Rand eines inneren Scrollbereichs erreicht ist (z. B. scrollt die
gesamte Seite weiter, wenn ein Dialog-Inhalt zu Ende gescrollt ist). Die CSS-Eigenschaft
`overscroll-behavior` erlaubt, das zu unterbinden:

- `auto` (Default): normales Verhalten, Chaining und Overscroll-Effekte (z. B. Bounce) sind
  aktiv.
- `contain`: Chaining wird verhindert, Overscroll-Effekte bleiben innerhalb des Elements
  erhalten.
- `none`: weder Chaining noch Overscroll-Effekte.

Quellen: CSS Overscroll Behavior Module Level 1, <https://www.w3.org/TR/css-overscroll-1/>
(Editor's Draft: <https://drafts.csswg.org/css-overscroll-1/>), MDN
<https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior>.

Browser-Unterstützung nach MDN-Kompatibilitätstabelle: Chrome/Chrome Android ab 63, Firefox ab
59, Safari (macOS und iOS) ab **16**. Vor Safari 16 lässt sich Scroll-Chaining auf iOS also nicht
über CSS unterbinden.

### Impulsscrollen (Momentum Scrolling) in inneren Containern

Historisch war dafür auf iOS die proprietäre Eigenschaft `-webkit-overflow-scrolling: touch`
nötig. Sie ist seit iOS 13 wirkungslos (reiner No-Op, wird aber weiterhin geparst), weil Safari
seit Version 13 Impulsscrollen standardmäßig auf allen `overflow:scroll`/`overflow:auto`-Elementen
anbietet. Beleg: Pull Request im offiziellen `mdn/browser-compat-data`-Repository, der das
Kompatibilitäts-Flag entsprechend nachzieht: „`-webkit-overflow-scrolling` no longer supported in
iOS 13+", <https://github.com/mdn/browser-compat-data/pull/10542>. Für Chrome Android ist
Impulsscrollen in `overflow:auto`-Bereichen seit Langem Standardverhalten, ohne dass eine
gesonderte CSS-Eigenschaft nötig wäre — eine genaue Primärquelle mit Versionsangabe dafür wurde
nicht gefunden; das ist als allgemein bekanntes, aber nicht einzeln belegtes Verhalten zu
behandeln.

### Adressleiste und nicht scrollendes Hauptdokument

Hierzu ist die Beleglage **uneinheitlich und teils veraltet**:

- Ein Beitrag im offiziellen Apple Developer Forum aus dem Jahr 2021 beschreibt für iOS 15 das
  **Gegenteil** der in der Aufgabenstellung vermuteten Regel: „On iOS 15 scrolling within an
  element causes the window to resize / toolbar to disappear, regardless of if you have the top
  or bottom toolbar. On iOS 14 this would only happen when the body scrolled." Quelle:
  <https://developer.apple.com/forums/thread/690835>. Das heißt: Mit iOS 15 hat WebKit das
  Verhalten geändert, sodass auch Scrollen in einem inneren `overflow`-Element die Symbolleisten
  einfahren lässt — nicht mehr nur Scrollen des `body`/Dokuments.
- Ein an anderer Stelle kursierender Erklärungsansatz („Toolbar kollabiert nur beim
  Root-Scroller") ist in der gesichteten Quelle ausdrücklich **nicht empirisch belegt**, sondern
  aus der Spezifikation und WebKits Root-Scroller-Konzept hergeleitet, mit explizitem Vermerk des
  Autors, dass es an echter Hardware nicht nachvollzogen werden konnte.
- Für den Fall eines rein **JavaScript-/Transform-gesteuerten** Scrollens (kein natives
  `overflow: auto`, sondern Verschiebung per `transform`, sodass der Browser gar keinen
  Scroll-Container sieht) gibt es einen dokumentierten Bericht, dass die Adressleiste dann
  tatsächlich nicht einfährt, weil aus Sicht des Browsers gar nicht gescrollt wird: „The address
  bar in mobile browsers like chrome hides on scroll down or swipe gesture, but when using smooth
  scrollbar for whole body content the address bar doesn't hide" — Ursache laut Melder: Der
  Browser sieht nur einen Container mit `overflow: hidden`, keine echte Scroll-Bewegung des
  Dokuments. Quelle: <https://github.com/dolphin-wood/smooth-scrollbar/issues/277> (Drittprojekt,
  keine Browser-Herstellerquelle).

Insgesamt: Für **echtes** `overflow: auto`/`scroll` (wie im hier betrachteten Raster) ist die
aktuell gültige Regel nicht mit einer tagesaktuellen Primärquelle zu belegen — die einzige
konkrete Beschreibung (Apple-Forum) ist von 2021 und bezieht sich auf iOS 15; ob das Verhalten in
aktuellen iOS-/Chrome-Android-Versionen (Stand 2026) noch so gilt, ist **am Gerät zu prüfen**.

## Frage 4: Verhalten anderer Textwerkzeuge auf dem Telefon

Für die konkrete Frage, ob die genannten Werkzeuge ein durchgehend scrollendes Dokument oder
feste innere Scrollbereiche verwenden und wie sie die Bildschirmtastatur behandeln, ließ sich
**keine** offizielle, das interne Layout beschreibende Primärquelle finden. Im Einzelnen:

- **Notion (mobile web):** Das offizielle Notion Help Center
  (<https://www.notion.com/help/notion-for-mobile>) beschreibt allgemeine Funktionslücken der
  mobilen Nutzung (u. a. keine Hover-States, keine Mehrfachauswahl von Blöcken, gewisse
  Verwaltungsfunktionen nur am Desktop) sowie eine horizontal scrollbare Werkzeugleiste über der
  Tastatur, macht aber keine Aussage zum Scroll-/Höhenmodell der Seite. Keine Primärquelle zum
  internen Layout gefunden.
- **Google Docs (mobile web, Browser):** Gefunden wurde ein Google-Workspace-Updates-Blogeintrag
  vom Juli 2023, der jedoch die native **Android-App** betrifft (Start im Bearbeitungsmodus,
  sichtbare Werkzeugleiste, I-Beam-Cursor), nicht die Browser-Version. Für die mobile
  **Web**-Version von Google Docs wurde keine Primärquelle zum Scroll-/Tastatur-Verhalten
  gefunden.
- **GitHub.com Mobile-Web-Editor** (Bearbeiten einer Datei direkt im Browser auf github.com, nicht
  die native App): Keine offizielle Dokumentation oder ein einschlägiges Issue im
  `github/github`-Feedback-Tracker zu Scroll-/Tastaturverhalten gefunden.
- **Outline** (`outline/outline`, offizielles Repository und Changelog
  <https://www.getoutline.com/changelog/>): Das Changelog erwähnt wiederholt allgemeine „mobile
  styling and layout"- und Scrolling-Fixes (z. B. Sidebar-Darstellung beim Bearbeiten auf Mobil),
  aber keinen dokumentierten Eintrag speziell zu `dvh`, virtueller Tastatur oder
  Viewport-Verhalten. Keine spezifische Primärquelle gefunden.
- **Obsidian Publish:** Laut offizieller Seite (<https://obsidian.md/publish>,
  <https://obsidian.md/help/obsidian-publish>) ist Publish eine **Veröffentlichungs-/Leseplattform**
  für bereits geschriebene Notizen, kein Browser-Editor. Bearbeitung geschieht in der
  Obsidian-Anwendung selbst; laut derselben Quelle „you can also edit and publish your site from
  the Obsidian mobile app" — also über die native Mobil-App, nicht im Browser. Damit fällt
  Obsidian Publish für die Fragestellung „Schreiben im mobilen Browser" aus.
- **ProseMirror-Dokumentation** (<https://prosemirror.net/docs/ref/>): Kein eigener
  Dokumentationsabschnitt zu „Mobile" gefunden; die einschlägigen Mechanismen sind die bereits in
  Frage 2 genannten `scrollThreshold`/`scrollMargin`/`handleScrollToSelection`, die
  browserunabhängig, aber wie gezeigt für innere Scroll-Container unzureichend sind.
- **Tiptap-Dokumentation** (tiptap.dev): Keine eigene Dokumentationsseite zu „Mobile" gefunden;
  die einschlägigen Belege sind die genannten GitHub-Issues #7757 und #1806 im offiziellen
  Repository.

## Am Gerät zu prüfen

- Ob und wie stark `dvh`-Layouts beim Ein-/Ausfahren der Symbolleiste in iOS Safari, Chrome
  Android und Firefox Android sichtbar nachziehen/springen (browserspezifisches
  Drosselungsverhalten ist nicht dokumentiert).
- Exakte `dvh`/`svh`/`lvh`-Unterstützung in Samsung Internet bzw. anderen Chromium-Forks (caniuse
  und MDN widersprechen sich in den herangezogenen Abfragen).
- Ob aktuelle iOS-Versionen (Stand 2026) die Symbolleisten beim Scrollen eines **inneren**
  `overflow:auto`-Containers einfahren oder nicht — die einzige konkrete Quelle dazu ist ein
  Apple-Forenbeitrag von 2021 zu iOS 15/14 und möglicherweise nicht mehr aktuell.
- Gleiche Frage für aktuelle Chrome-Android- und Firefox-Android-Versionen — keine Primärquelle
  gefunden.
- Zusammenspiel aus mehreren gleichzeitig vorhandenen `overflow:auto`-Bereichen (Seitenbaum,
  Dokument, Randspalte) mit Scroll-Chaining/`overscroll-behavior` im konkreten Raster dieser App.
- Tatsächliches Verhalten von `window.visualViewport` (Werte für `height`/`offsetTop`, Timing der
  `resize`/`scroll`-Events) beim Fokussieren des ProseMirror-/Tiptap-Editors in einem inneren
  Scroll-Container dieser App, insbesondere ob der Editor-eigene `scrollIntoView`-Mechanismus
  greift oder — wie im OpenProject-Bericht beschrieben — leerläuft.
- Ob `interactive-widget=resizes-content` in Chrome Android das gewünschte Verhalten (echte
  Verkleinerung von `dvh`) für dieses konkrete Raster auslöst, ohne andere Nebenwirkungen.

## Quellen

- W3C, CSS Values and Units Module Level 4 — <https://www.w3.org/TR/css-values-4/>
- W3C, CSS Overscroll Behavior Module Level 1 — <https://www.w3.org/TR/css-overscroll-1/>
  (Editor's Draft: <https://drafts.csswg.org/css-overscroll-1/>)
- MDN, `<length>` (CSS-Typ) — <https://developer.mozilla.org/en-US/docs/Web/CSS/length>
- MDN, `overscroll-behavior` — <https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior>
- MDN, Visual Viewport API — <https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API>
- MDN, VirtualKeyboard API — <https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API>
- MDN, `<meta name="viewport">` — <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport>
- MDN `browser-compat-data`, `css/types/length.json` — <https://github.com/mdn/browser-compat-data/blob/main/css/types/length.json>
- MDN `browser-compat-data`, PR zu `-webkit-overflow-scrolling` (iOS 13+ No-Op) — <https://github.com/mdn/browser-compat-data/pull/10542>
- web.dev / Chrome-Team-Blog, „The large, small, and dynamic viewport units" — <https://web.dev/blog/viewport-units>
- Chrome for Developers, „Prepare for viewport resize behavior changes coming to Chrome on Android" — <https://developer.chrome.com/blog/viewport-resize-behavior>
- Chrome for Developers, „Full control with the VirtualKeyboard API" — <https://developer.chrome.com/docs/web-platform/virtual-keyboard>
- WebKit-Blog, „New WebKit Features in Safari 15.4" — <https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/>
- WebKit-Bugtracker, Issue 259770 („Implement the interactive-widget property in the viewport meta tag") — <https://bugs.webkit.org/show_bug.cgi?id=259770>
- Mozilla-Bugzilla, Issue 1831649 („Implement the 'interactive-widget' meta viewport key") — <https://bugzilla.mozilla.org/show_bug.cgi?id=1831649>
- W3C CSSWG-Drafts, Issue 7475 („Reinterpret viewport positioned (fixed, sticky) elements wrt virtual keyboard") — <https://github.com/w3c/csswg-drafts/issues/7475>
- caniuse, „Small, Large, and Dynamic viewport units" — <https://caniuse.com/viewport-unit-variants>
- ProseMirror Reference Manual — <https://prosemirror.net/docs/ref/>
- OpenProject, Pull Request #25579 — <https://github.com/opf/openproject/pull/25579>
- Tiptap (ueberdosis/tiptap), Issue #7757 — <https://github.com/ueberdosis/tiptap/issues/7757>
- Tiptap (ueberdosis/tiptap), Issue #1806 — <https://github.com/ueberdosis/tiptap/issues/1806>
- WHATWG HTML, Issue #8375 — <https://github.com/whatwg/html/issues/8375>
- Apple Developer Forums, Thread 690835 („iOS 15 safari toolbar now hides when scrolling within an element") — <https://developer.apple.com/forums/thread/690835>
- GitHub, dolphin-wood/smooth-scrollbar, Issue #277 — <https://github.com/dolphin-wood/smooth-scrollbar/issues/277>
- Obsidian, offizielle Seiten zu Publish — <https://obsidian.md/publish>, <https://obsidian.md/help/obsidian-publish>
- Notion Help Center, „Notion for mobile" — <https://www.notion.com/help/notion-for-mobile>
- Outline, offizielles Changelog — <https://www.getoutline.com/changelog/>
