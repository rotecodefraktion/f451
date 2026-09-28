# Agenten am MCP: was in den Prompt gehört

Der MCP-Dienst beschreibt sich selbst — jedes Werkzeug trägt eine deutsche
Beschreibung, und der Server gibt beim Verbinden `instructions` mit. Ein Agent
kommt damit weit, aber vier Dinge weiß er **nicht** aus den Beschreibungen, weil
sie Konventionen dieses Hauses sind und keine Eigenschaften der Schnittstelle:
wie weit er gehen darf, in welcher Sprache er schreibt, wann ein Diagramm
angebracht ist, und dass er beim Anhängen selbst zur Kommandozeile greifen muss.

Genau das gehört in den Prompt. Alles Übrige steht schon im Werkzeug.

## Vorlage

```
Du arbeitest am f451-Wiki über den MCP-Dienst. Beachte:

ABLAUF. Es gibt keinen Weg, direkt auf die veröffentlichte Fassung zu
schreiben. Der Weg ist immer: edit_page (bestehende Seite) oder create_page
(neue Seite) → update_page_draft → request_review. Die Freigabe (release_page)
machst du NICHT von dir aus — die entscheidet ein Mensch, außer ich sage
ausdrücklich etwas anderes.

ORIENTIEREN VOR SCHREIBEN. Bevor du eine Seite anlegst, sieh mit search_wiki
und get_tree nach, ob es sie schon gibt und wo sie hingehört. Eine Dublette
kostet mehr Arbeit als die Suche.

SHA-VERTRAG. Den `baseSha` aus der letzten Antwort unverändert in den nächsten
update_page_draft übernehmen. Kommt ein 409, ist dir jemand zuvorgekommen:
Nimm den mitgelieferten currentContent als neue Basis und arbeite deine
Änderung dort ein — überschreibe sie nicht.

GANZER TEXT. update_page_draft ersetzt den Seiteninhalt vollständig. Sende
immer den GESAMTEN Markdown-Text inklusive Frontmatter, nie ein Teilstück.

SPRACHE. Oberfläche, Inhalte und Commit-Nachrichten sind deutsch. Fachbegriffe
und Bezeichner bleiben im Original.

DIAGRAMME. Für Prozessabläufe und Entscheidungswege nimm save_diagram, statt
einen Ablauf in Aufzählungen zu beschreiben. Du sendest eine BESCHREIBUNG
(Bahnen und Schritte bzw. Knoten und Verbindungen), kein SVG und kein Mermaid.
Beim Bahnendiagramm gibst du die Schritte in der Reihenfolge der Prozesskette
an und nennst je Schritt seine Bahn — die Anordnung rechnet der Dienst. Den
zurückgegebenen Markdown-Schnipsel fügst du im selben Arbeitsgang mit
update_page_draft in den Seitentext ein; sonst liegt das Diagramm im Entwurf,
ohne dass es jemand sieht.

DATEIEN. attach_file überträgt nichts — es gibt dir den Upload-Befehl für deine
eigene Kommandozeile. Führe ihn dort aus. Hast du keine Kommandozeile, sag mir
das, statt es zu versuchen.

BEI FEHLERN. Die Meldungen sind Klartext und handlungsleitend. 403 mit Hinweis
auf ein Konto heißt: Ein Mensch muss sein Forgejo-Konto verknüpfen, das kannst
du nicht beheben — melde es mir. 404 heißt „existiert nicht ODER kein Zugriff",
diese Unschärfe ist Absicht; rate nicht herum.
```

## Was man weglassen kann

**Die Werkzeugnamen aufzählen.** Der Client bekommt sie mitsamt Parametern und
Beschreibungen; eine zweite Liste im Prompt veraltet, sobald ein Werkzeug
dazukommt.

**Erklären, was ein Draft ist.** Steht in den Beschreibungen.

**Das SVG-Format erklären.** Der Agent sieht es nie — er beschreibt, der Dienst
zeichnet.

## Die drei Fallen in der Praxis

1. **Der Agent veröffentlicht selbstständig.** `release_page` ist erreichbar,
   und ein eifriger Agent hält den Vorgang für unvollständig, solange die Seite
   nicht live ist. Der Satz „die Freigabe entscheidet ein Mensch" gehört
   deshalb in jeden Prompt, in dem der Agent Schreibrechte hat.
2. **Das Diagramm liegt im Entwurf, aber nicht auf der Seite.** `save_diagram`
   legt die Datei ab; in den Text kommt sie erst durch `update_page_draft`. Wer
   das nicht sagt, findet später ein verwaistes `_media/`-Verzeichnis.
3. **Der Agent baut sich das Diagramm selbst.** Modelle neigen dazu, Mermaid
   oder rohes SVG zu erzeugen, weil sie es aus anderen Zusammenhängen kennen.
   Mermaid kann diese Pipeline nicht, und ein selbst gebautes SVG hat kein
   eingebettetes mxGraph-XML — es wäre im Editor nicht mehr bearbeitbar.

## Werkzeuge im Überblick

| Zweck | Werkzeuge |
|---|---|
| Orientieren und lesen | `list_spaces`, `get_tree`, `search_wiki`, `read_page`, `get_page_source`, `get_graph`, `list_broken_links` |
| Schreiben im Review-Weg | `create_page`, `edit_page`, `update_page_draft`, `discard_page_draft`, `request_review`, `request_changes`, `release_page` |
| Anhänge | `save_diagram`, `attach_file` |

Voraussetzung fürs Schreiben ist ein Token mit Scope `write` **und** ein
verknüpftes Forgejo-/GitHub-Konto: Der Commit läuft unter dem Provider-Token des
Nutzers, nicht unter einem Dienstkonto. Ohne verknüpftes Konto scheitert jeder
Schreibversuch mit 403 — das ist eine Voraussetzung, kein Fehler, und nur ein
Mensch im Browser kann sie herstellen.
