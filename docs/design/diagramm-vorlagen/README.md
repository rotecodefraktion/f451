# Diagramm-Vorlagen (Hausstil)

Zwei vom Auftraggeber im draw.io-Editor erstellte Vorlagen. Sie sind die **verbindliche Quelle**
für die Stilwerte, mit denen der Generator arbeitet (siehe
`docs/superpowers/specs/2026-07-27-mcp-anhaenge-design.md`).

Die Beschriftungen in den Dateien sind verfremdet — es geht ausschließlich um Stile, Maße und
Anordnung, nicht um den Inhalt.

| Datei | Art |
|---|---|
| `bahnendiagramm.mxgraph.xml` | Prozessablauf über Zuständigkeiten (zwei Bahnen) |
| `flussdiagramm.mxgraph.xml` | Programmablauf mit Verzweigungen und Seitenzweigen |

## Was daraus zu übernehmen ist

Die vollständigen Stil-Zeichenketten der Zellen, nicht nur die Farbwerte. Das erzeugte
mxGraph-XML muss dieselben Schlüssel tragen (`rounded`, `arcSize`, `whiteSpace`, `html`,
`align`, `verticalAlign`, `fontFamily`, `fontSize`, `fontColor`), sonst sieht ein erzeugtes
Diagramm im Editor anders aus als ein von Hand gezeichnetes.

## Zwei Beobachtungen an den Vorlagen

**Die Zwei-Modi-Schreibweise steht nur an einer Stelle.** `lane1` trägt
`fillColor=light-dark(#E9E9E9,#1A1A1A)`, `lane0` einen festen Wert. Das ist so gewollt und wird
nicht vereinheitlicht.

**`light-dark()` wirkt nur mit `color-scheme`.** Gemessen am 2026-07-27: Ein als Bild
eingebundenes SVG wertet `light-dark()` nur aus, wenn es selbst `color-scheme: light dark`
deklariert. Fehlt die Zeile, fällt der Wert stumm auf die helle Fassung zurück — ohne Fehler,
ohne Warnung. Ob die im Editor gezeichneten Bestandsdiagramme diese Deklaration tragen, ist
offen und gehört geprüft.
