import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { editorExtensions, EditorImage } from '@f451/editor'
import { Extension, type Extensions } from '@tiptap/core'
import { Dropcursor, Gapcursor, UndoRedo } from '@tiptap/extensions'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { SlashMenu } from '../../components/editor/slash-menu.js'
import { WikiLinkPopup } from '../../components/editor/wiki-link-popup.js'
import { isPhoneLayout } from '../phone.js'
import { mediaHref } from '../urls.js'
import { diagramKind, type DiagramKind } from './diagram.js'
import { diagramVersion, subscribeDiagramVersions } from './diagram-versions.js'
import { insertFootnoteInto, supportsFootnotes } from './footnotes.js'
import { classifyPaste } from './paste-rules.js'
import { filterSlashItems, type SlashItem } from './slash-items.js'
import { TableGuard, type TableGuardOptions } from './table-guard.js'
import { splitUploadFiles } from './upload-queue.js'
import { deriveWikiLinkTarget, suggestWikiTargets, type WikiSuggestDeps, type WikiSuggestion } from './wiki-suggest.js'
import { t as translate } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import type { T } from '../i18n/types.js'

// Phase 2 (i18n): dieses Modul ist (wie jedes `lib/**`-Modul) hook-frei — `t` kommt
// als OPTIONALES Feld in `UiExtensionsOptions` von der aufrufenden Komponente
// (`wysiwyg-editor.tsx`s `useT()`). `DEFAULT_T` ist ein an das DE-Wörterbuch
// gebundener Fallback (NUR für Bestandstests, die `uiExtensions(pageId)` ohne
// `options.t` aufrufen, z. B. `ui-extensions.test.ts#getImageNodeView` — deren
// Erwartungswerte bleiben so unverändert deutsch) — jeder echte Aufrufer reicht
// das aus `useT()` gebundene `t` durch.
const DEFAULT_T: T = (key, params) => translate(de, key, params)

// --- UI-Extension-Set des WYSIWYG-Editors (Phase 2c Task 3 + Task 5) ---------------
//
// `editorExtensions()` aus @f451/editor ist bewusst OHNE History/Dropcursor/Gapcursor
// (Yjs-Pfad, s. packages/editor/src/extensions.ts:29-34) — die drei UI-Extensions
// kommen deshalb NUR hier dazu, aus `@tiptap/extensions` (exakte Export-Namen gegen die
// installierte v3.27.3 verifiziert: `UndoRedo`, `Dropcursor`, `Gapcursor` — node_modules/
// @tiptap/extensions/dist/index.d.ts). `UndoRedo` ersetzt bewusst NICHT History (die
// gibt es hier gar nicht, s. o.) und wird beim späteren Yjs-Einstieg gegen dessen
// eigenen Undo-Manager getauscht (y-prosemirror) — bis dahin ist sie die einzige
// Undo/Redo-Quelle der Editor-UI.
//
// Bild-Anzeige-Mapping: Markdown-Bildpfade sind relativ zur Seite (`_media/…`, s.
// lib/urls.ts#mediaHref) — das ProseMirror-Node-Attribut MUSS diesen relativen Pfad
// unangetastet behalten (Markdown-Wahrheit, docToMarkdown serialisiert `node.attrs.src`
// unverändert zurück, s. to-markdown.ts#convertImage), nur die ANZEIGE im Editor
// braucht eine auflösbare URL. Deshalb ausschließlich `renderHTML` überschrieben (nicht
// `addAttributes`/parseHTML) — der Node bleibt schema-seitig identisch zu
// `editorExtensions()`s Image, nur das gerenderte `<img src>` zeigt auf die
// Draft-Media-Route (`ref=draft`, s. mediaHref).
//
// Task 5 (`/`-Menü, `[[`-Autocomplete, Media-Upload, Paste) hängt hier zwei
// `@tiptap/suggestion`-Instanzen + eine Paste/Drop-Plugin-Extension ein. Die reine
// Filter-/Merge-/Klassifikationslogik lebt in eigenen, node-testbaren Modulen
// (`slash-items.ts`, `wiki-suggest.ts`, `paste-rules.ts`) — dieses Modul ist nur die
// DOM-/Tiptap-Verdrahtung (Popup-Mounting, ProseMirror-Plugin-Props), bewusst OHNE
// eigene Unit-Tests für diesen Teil (braucht eine echte Editor-/DOM-Instanz, s.
// Task-Brief: React-Popups + ihr Glue-Code sind Playwright-Terrain, Task 7).

export interface UiExtensionsOptions extends TableGuardOptions {
  /** Space-Slug der aktuellen Seite — grenzt die `[[`-Autocomplete-Suche ein
   *  (`searchPages({space, ref})`, s. wiki-suggest.ts). Optional mit Default `''`
   *  (unscoped, sucht spaceübergreifend) — schadet nur der Trefferqualität, nicht der
   *  Korrektheit, und hält `uiExtensions('demo')` (Bestandstests) unverändert lauffähig. */
  space?: string
  /** `searchPages`-Implementierung für die `[[`-Autocomplete — injizierbar (Default:
   *  `client-api.ts#searchPages`), damit Tests/Storybook-artige Nutzung sie ersetzen
   *  können, ohne `fetch` zu stubben. */
  searchPages?: WikiSuggestDeps['searchPages']
  /** Eine oder mehrere hochladbare Dateien wurden ausgewählt — Bilder UND die
   *  erlaubten Dokument-Anhänge (PDF/Office/ZIP/Text, s. `upload-queue.ts`),
   *  gemeinsam in EINEM Callback, weil die Einfüge-Entscheidung (`setImage` vs.
   *  Datei-Link) erst nach dem Upload anhand des `kind`-Felds der Server-Antwort
   *  fällt (s. wysiwyg-editor.tsx). Ausgelöst per Datei-Dialog
   *  (`triggerImageUpload`-Command, Toolbar-Button/Slash-Item „Bild/Datei", IMMER
   *  genau eine Datei) ODER per Drop/Paste (0..n Dateien EINES Events, in
   *  Drop-/Cursor-Reihenfolge, s. `splitUploadFiles`). Der eigentliche Upload
   *  (`uploadMedia`) UND das Einfügen der Nodes laufen bewusst NICHT hier
   *  (React-State für Ladehinweis/Fehlersammlung gehört in die Komponente, s.
   *  wysiwyg-editor.tsx#uploadQueueReducer) — dieses Modul meldet die Dateien nur
   *  weiter. Bei Drop/Paste steht die ProseMirror-Selektion zum Zeitpunkt des
   *  Aufrufs bereits an der Zielposition (s. `MediaPasteAndDrop` unten), der
   *  Aufrufer fügt also immer „an der aktuellen Selektion" ein — sequenziell, damit
   *  mehrere Dateien in der richtigen Reihenfolge landen. */
  onUploadFiles?: (files: File[]) => void
  /** Ein Drop/Paste-Event enthielt `count` wirklich NICHT unterstützte Dateien —
   *  nur gezählt, NICHT hochgeladen (Finding 1, Review Task 5: „nie stilles
   *  Verwerfen", Spec §9). Der Aufrufer zeigt dafür eine Sammel-Notice (s.
   *  `upload-queue.ts#skippedFilesNotice`). */
  onFilesSkipped?: (count: number) => void
  /** Öffnet den Datei-Auswahldialog — Ziel von `editor.commands.triggerImageUpload()`
   *  (Toolbar-Button „Bild/Datei einfügen"/Slash-Item „Bild/Datei"). Das eigentliche
   *  `<input type="file">` lebt in React (wysiwyg-editor.tsx); dessen `onChange` ruft
   *  danach {@link UiExtensionsOptions.onUploadFiles} mit der gewählten Datei (als
   *  Einzel-Array) auf. */
  onRequestImagePicker?: () => void
  /** Der „Diagramm bearbeiten"-Button einer Diagramm-NodeView wurde geklickt
   *  (Tasks 4/5: öffnet den draw.io-/Excalidraw-Dialog in React, s.
   *  wysiwyg-editor.tsx#DiagramDialogState). Nur editierbar (`editor.isEditable`)
   *  aufrufbar — s. `imageWithMediaSrc` unten. */
  onEditDiagram?: (info: { path: string; kind: DiagramKind }) => void
  /** `editor.commands.createDiagram(kind)` wurde ausgelöst (Slash-Item
   *  „Diagramm"/„Skizze", Tasks 4/5) — öffnet den Namens-Prompt +
   *  Erstellungs-Dialog in React. Ziel von {@link DiagramCreateTrigger}. */
  onCreateDiagram?: (kind: DiagramKind) => void
  /** Gebundener Übersetzer (`useT()#t` aus `wysiwyg-editor.tsx`) — steuert
   *  Labels/Hints des `/`-Menüs (`slash-items.ts`), den „Diagramm bearbeiten"-
   *  Button-Text der Diagramm-NodeView UND die Popup-Komponenten
   *  (`SlashMenu`/`WikiLinkPopup`, s. `createReactSuggestionRender` unten).
   *  Fehlt es (Bestandstests ohne Options), greift {@link DEFAULT_T}. */
  t?: T
}

export function uiExtensions(pageId: string, options: UiExtensionsOptions = {}): Extensions {
  const space = options.space ?? ''
  const searchPages = options.searchPages
  const t = options.t ?? DEFAULT_T
  return [
    ...editorExtensions().filter((extension) => extension.name !== 'image'),
    imageWithMediaSrc(pageId, options, t),
    UndoRedo,
    Dropcursor,
    Gapcursor,
    TableGuard.configure({ onCellOverflow: options.onCellOverflow }),
    ImageUploadTrigger.configure({ onTrigger: options.onRequestImagePicker }),
    DiagramCreateTrigger.configure({ onTrigger: options.onCreateDiagram }),
    FootnoteCommands,
    slashCommandExtension(t),
    wikiLinkAutocompleteExtension(space, searchPages, t),
    mediaPasteAndDropExtension(options.onUploadFiles, options.onFilesSkipped),
  ]
}

// Absolute URLs (http(s):, protokollrelativ //) und data:-URIs bleiben unverändert —
// nur seiten-relative Pfade (`_media/…`) werden über mediaHref aufgelöst.
const ABSOLUTE_SRC = /^([a-z][a-z0-9+.-]*:)?\/\//i

function resolveMediaSrc(pageId: string, src: string): string {
  if (ABSOLUTE_SRC.test(src) || src.startsWith('data:')) return src
  return mediaHref(pageId, src, 'draft')
}

// `renderHTML` bleibt unverändert (dient weiterhin z. B. der HTML-Serialisierung
// außerhalb einer laufenden Editor-Instanz) — `addNodeView` ist die ZUSÄTZLICHE,
// im DOM tatsächlich gerenderte Darstellung. Ein Diagramm-Bild (s. `diagramKind`)
// bekommt einen Wrapper mit schwebendem „Diagramm bearbeiten"-Button (Phase 3e
// Task 3, Dialoge folgen in Tasks 4/5); ein normales Bild bleibt ein einfaches
// `<img>` — unverändertes Verhalten ggü. vor dieser NodeView.
function imageWithMediaSrc(pageId: string, options: UiExtensionsOptions = {}, t: T = DEFAULT_T) {
  return EditorImage.extend({
    renderHTML({ node, HTMLAttributes }) {
      const relSrc = node.attrs.src as string | null
      const attrs = { ...HTMLAttributes, ...(relSrc ? { src: resolveMediaSrc(pageId, relSrc) } : {}) }
      return ['img', attrs]
    },
    addNodeView() {
      return ({ node, editor }) => {
        const relSrc = (node.attrs.src as string | null) ?? ''
        const kind = diagramKind(relSrc)
        const img = document.createElement('img')
        if (node.attrs.alt) img.alt = node.attrs.alt as string
        if (node.attrs.title) img.title = node.attrs.title as string
        // Breite/Höhe aus dem `|400`-Suffix (EditorImage-Attribute): der NodeView
        // rendert das <img> selbst, deshalb hier explizit setzen (das renderHTML
        // oben greift nur außerhalb einer laufenden Editor-Instanz). Gilt auch für
        // Diagramm-Bilder (.drawio.svg), die hier zum Wrapper mit Edit-Button werden.
        if (node.attrs.width) img.width = node.attrs.width as number
        if (node.attrs.height) img.height = node.attrs.height as number
        // `&v=<n>` bustet den Browser-/<img>-Cache nach dem Speichern (Task 4/5:
        // `bumpDiagramVersion`) — der Server sendet für `ref=draft` zwar bereits
        // `Cache-Control: no-store`, das ändert aber nichts daran, dass ein <img>
        // mit UNVERÄNDERTEM `src` nach einem Speichern nicht neu lädt.
        const setSrc = () => {
          const version = diagramVersion(pageId, relSrc)
          const base = relSrc ? resolveMediaSrc(pageId, relSrc) : ''
          img.src = version > 0 ? `${base}&v=${version}` : base
        }
        setSrc()
        if (!kind) return { dom: img } // normale Bilder: unverändertes Verhalten

        const dom = document.createElement('div')
        dom.className = 'diagram-node'
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'diagram-edit'
        button.textContent = t('editor.diagramNode.editButton')
        button.addEventListener('click', () => {
          if (!editor.isEditable) return
          options.onEditDiagram?.({ path: relSrc, kind })
        })
        const unsubscribe = subscribeDiagramVersions((p, path) => {
          if (p === pageId && path === relSrc) setSrc()
        })
        // Phone layout (f451#1): CSS hides the button and shows this hint instead.
        const phoneHint = document.createElement('div')
        phoneHint.className = 'diagram-phone-hint'
        phoneHint.textContent = t('editor.diagramNode.phoneHint')
        dom.append(img, button, phoneHint)
        return {
          dom,
          destroy: () => unsubscribe(),
          // Bugfix (Phase 3e Task 6, per E2E gefunden — Auflage A/Task-3-Review):
          // `dom` ist der Leaf-Node-View eines atomaren Nodes OHNE `contentDOM` —
          // ProseMirror behandelt jeden Mousedown/Klick INNERHALB von `dom`
          // standardmäßig als Klick auf den ganzen Node und setzt zusätzlich zum
          // eigentlichen Button-Klick eine `NodeSelection` (sichtbar als
          // `ProseMirror-selectednode`-Klasse auf `dom`). Der Button öffnet den
          // Dialog dabei zwar trotzdem (der native `click` feuert unabhängig
          // davon), aber das Bild blinkt dabei sichtbar als "ausgewählt" auf —
          // genau das von Auflage A benannte Risiko. `stopEvent` markiert Events,
          // deren `target` der Button selbst ist, als von ProseMirror UNBEHANDELT
          // (kein Selektions-/Drag-Handling) — der Button behält sein eigenes
          // `click`-Listener unverändert.
          stopEvent: (event) => event.target === button,
        }
      }
    },
  })
}

// --- `editor.commands.triggerImageUpload()` — der EINE Aufruf, den Toolbar-Button
// UND Slash-Item „Bild" brauchen, um den Datei-Dialog zu öffnen (der eigentliche
// Datei-Dialog lebt in React, s. `onTrigger`-Option/wysiwyg-editor.tsx) ---------------

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageUploadTrigger: {
      triggerImageUpload: () => ReturnType
    }
  }
}

interface ImageUploadTriggerOptions {
  onTrigger?: () => void
}

const ImageUploadTrigger = Extension.create<ImageUploadTriggerOptions>({
  name: 'imageUploadTrigger',

  addOptions() {
    return { onTrigger: undefined }
  },

  addCommands() {
    return {
      triggerImageUpload:
        () =>
        () => {
          this.options.onTrigger?.()
          return true
        },
    }
  },
})

// --- `editor.commands.insertFootnote()` (f451#82) — shared by toolbar button, slash
// item and `Mod-Shift-f`. The transaction logic lives in `footnotes.ts` so it can be
// tested on a plain EditorState ----------------------------------------------------

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnoteCommands: {
      /** Inserts a footnote reference at the selection, appends its definition
       *  at the document end and moves the cursor into it. */
      insertFootnote: () => ReturnType
    }
  }
}

const FootnoteCommands = Extension.create({
  name: 'footnoteCommands',

  addCommands() {
    return {
      insertFootnote:
        () =>
        ({ tr, dispatch }) => {
          // Dry run (`editor.can()`): only answer, never touch the shared `tr`.
          if (!dispatch) return supportsFootnotes(tr.doc)
          return insertFootnoteInto(tr)
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-f': () => this.editor.commands.insertFootnote(),
    }
  },
})

// --- `editor.commands.createDiagram(kind)` — der Andockpunkt, den Slash-Items
// „Diagramm"/„Skizze" (Tasks 4/5) brauchen, um den Namens-Prompt + den
// draw.io-/Excalidraw-Dialog in React zu öffnen (Muster `ImageUploadTrigger`
// oben: der eigentliche Dialog lebt in React, s. `onCreateDiagram`-Option/
// wysiwyg-editor.tsx) ---------------------------------------------------------

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    diagramCreateTrigger: {
      /** Öffnet den Neues-Diagramm-Flow (Namens-Prompt + Dialog) in React —
       *  s. onCreateDiagram in wysiwyg-editor.tsx. */
      createDiagram: (kind: DiagramKind) => ReturnType
    }
  }
}

interface DiagramCreateTriggerOptions {
  onTrigger?: (kind: DiagramKind) => void
}

const DiagramCreateTrigger = Extension.create<DiagramCreateTriggerOptions>({
  name: 'diagramCreateTrigger',

  addOptions() {
    return { onTrigger: undefined }
  },

  addCommands() {
    return {
      createDiagram:
        (kind: DiagramKind) =>
        () => {
          this.options.onTrigger?.(kind)
          return true
        },
    }
  },
})

// --- Generischer Popup-Renderer für beide Suggestion-Instanzen ---------------------
//
// `@tiptap/suggestion@3.27` bringt Floating-UI-basiertes Positionieren/Mounten schon
// mit (`SuggestionProps.mount`, node_modules/@tiptap/suggestion/dist/index.d.ts) — wir
// müssen nur noch EIN Element bauen, es per `mount()` an document.body hängen lassen
// (Positionierung/Scroll-Tracking übernimmt die Utility) und mit einem React-Root
// befüllen. `selectedIndex` lebt als reine Closure-Variable hier (kein React-State
// nötig — es gibt keine umschließende React-Komponente, die das Popup rendert, s.
// Kopfkommentar), Pfeiltasten/Enter kommen über `onKeyDown` der Suggestion-Utility
// (Escape schließt die Utility bereits selbst, dispatcht IMMER einen Exit — s.
// installiertes dist/index.js#handleKeyDown — deshalb hier kein Escape-Fall nötig).
function createReactSuggestionRender<I>(
  renderPopup: (params: {
    items: I[]
    selectedIndex: number
    query: string
    loading: boolean
    onSelect: (item: I) => void
  }) => ReactElement,
) {
  return () => {
    let root: Root | null = null
    let container: HTMLElement | null = null
    let unmount: (() => void) | null = null
    let selectedIndex = 0
    let latest: SuggestionProps<I, I> | null = null

    function paint() {
      if (!root || !latest) return
      const current = latest
      root.render(
        renderPopup({
          items: current.items,
          selectedIndex,
          query: current.query,
          loading: current.loading,
          onSelect: (item) => current.command(item),
        }),
      )
    }

    return {
      onStart(props: SuggestionProps<I, I>) {
        selectedIndex = 0
        latest = props
        container = document.createElement('div')
        root = createRoot(container)
        unmount = props.mount(container)
        paint()
      },
      onUpdate(props: SuggestionProps<I, I>) {
        latest = props
        if (props.items.length === 0) selectedIndex = 0
        else if (selectedIndex >= props.items.length) selectedIndex = props.items.length - 1
        paint()
      },
      onKeyDown({ event }: SuggestionKeyDownProps): boolean {
        if (!latest || latest.items.length === 0) return false
        if (event.key === 'ArrowDown') {
          selectedIndex = (selectedIndex + 1) % latest.items.length
          paint()
          return true
        }
        if (event.key === 'ArrowUp') {
          selectedIndex = (selectedIndex - 1 + latest.items.length) % latest.items.length
          paint()
          return true
        }
        if (event.key === 'Enter') {
          const item = latest.items[selectedIndex]
          if (item) latest.command(item)
          return true
        }
        return false
      },
      onExit() {
        unmount?.()
        root?.unmount()
        root = null
        container = null
        latest = null
      },
    }
  }
}

// --- `/`-Befehlsmenü ----------------------------------------------------------------
//
// `shouldShow` deaktiviert das Menü innerhalb von Tabellenzellen konsequent (statt es
// zu zeigen und jeden Block-Insert per table-guard-`filterTransaction` verwerfen zu
// lassen, s. Brief: „das Menü soll gar nicht erst erscheinen") — Zellen erlauben nur
// Inline-Inhalt, jedes Slash-Item hier fügt einen Block ein.
function slashCommandExtension(t: T) {
  return Extension.create({
    name: 'slashCommandMenu',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          pluginKey: new PluginKey('slashCommandMenu'),
          char: '/',
          decorationClass: 'trigger',
          shouldShow: ({ editor }) => !editor.isActive('tableCell') && !editor.isActive('tableHeader'),
          items: ({ query }) => filterSlashItems(query, t, { phone: isPhoneLayout() }),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run()
            props.run(editor)
          },
          render: createReactSuggestionRender<SlashItem>(({ items, selectedIndex, onSelect }) =>
            createElement(SlashMenu, { items, selectedIndex, onSelect, t }),
          ),
        }),
      ]
    },
  })
}

// --- `[[`-Wikilink-Autocomplete -------------------------------------------------------
//
// `debounce: 250` + der von der Utility selbst verwaltete `AbortSignal` in
// `items({query, signal})` sind die „AbortController pro Tastenschlag + 250ms-Debounce"
// aus dem Brief (s. wiki-suggest.ts-Kopfkommentar — die Utility übernimmt das, kein
// eigener Controller hier nötig).
function wikiLinkAutocompleteExtension(space: string, searchPagesImpl?: WikiSuggestDeps['searchPages'], t: T = DEFAULT_T) {
  return Extension.create({
    name: 'wikiLinkAutocomplete',
    addProseMirrorPlugins() {
      return [
        Suggestion<WikiSuggestion, WikiSuggestion>({
          editor: this.editor,
          pluginKey: new PluginKey('wikiLinkAutocomplete'),
          char: '[[',
          decorationClass: 'trigger',
          debounce: 250,
          items: async ({ query, signal }) => {
            if (!searchPagesImpl) return []
            return suggestWikiTargets(query, space, { searchPages: searchPagesImpl }, signal)
          },
          command: ({ editor, range, props }) => {
            const { target, alias } = deriveWikiLinkTarget(props)
            editor.chain().focus().deleteRange(range).insertContent({ type: 'wikiLink', attrs: { target, alias } }).run()
          },
          render: createReactSuggestionRender<WikiSuggestion>(({ items, selectedIndex, query, loading, onSelect }) =>
            createElement(WikiLinkPopup, { suggestions: items, selectedIndex, query, loading, onSelect, t }),
          ),
        }),
      ]
    },
  })
}

// --- Media-Upload-Flow (Drop/Paste von Dateien) + Paste-Regeln (URL-Erkennung) -----
//
// Kein Platzhalter-Node im Doc während des Uploads (Spec §9): diese Extension fügt
// NICHTS ein, sie meldet die Dateien nur über `onUploadFiles`/`onFilesSkipped`
// weiter — die eigentlichen Nodes (Bild ODER Datei-Link, je nach `kind` der
// Server-Antwort) entstehen erst NACH erfolgreichem `uploadMedia` je Datei (s.
// wysiwyg-editor.tsx). Bei einem Drop wird die Selektion synchron an die
// Drop-Position verschoben, damit die späteren Inserts (nach dem Await) „an der
// aktuellen Selektion" korrekt landen.
//
// Finding 1 (Review Task 5): ein Event mit MEHREREN Dateien darf nicht mehr nur die
// erste hochladbare Datei verarbeiten und den Rest still verwerfen — `splitUploadFiles`
// (upload-queue.ts) trennt alle hochladbaren Dateien — Bilder UND erlaubte
// Dokument-Anhänge — (→ `onUploadFiles`, sequenziell vom Aufrufer hochgeladen) von
// wirklich nicht unterstützten Dateien (→ `onFilesSkipped`-Zähler für eine
// Sammel-Notice statt einer Meldung pro Datei oder gar keiner).
function mediaPasteAndDropExtension(onUploadFiles?: (files: File[]) => void, onFilesSkipped?: (count: number) => void) {
  return Extension.create({
    name: 'mediaPasteAndDrop',
    addProseMirrorPlugins() {
      const editor = this.editor
      // Kein `onUploadFiles`/`onFilesSkipped` verdrahtet (z. B. `uiExtensions('demo')`
      // in Bestandstests ohne Optionen) ⇒ diese Extension greift nirgends ein,
      // identisch zum bisherigen Verhalten ohne wired-up Callbacks.
      const filesEnabled = Boolean(onUploadFiles || onFilesSkipped)
      function reportFiles(files: File[]) {
        const { uploadable, skippedCount } = splitUploadFiles(files)
        if (uploadable.length > 0) onUploadFiles?.(uploadable)
        if (skippedCount > 0) onFilesSkipped?.(skippedCount)
      }
      return [
        new Plugin({
          key: new PluginKey('mediaPasteAndDrop'),
          props: {
            handleDrop(view, event, _slice, moved) {
              // Interne Drag-Operationen (Text/Node innerhalb des Dokuments verschieben)
              // sind kein Datei-Drop — unverändert dem Standardverhalten überlassen.
              if (moved) return false
              const files = Array.from(event.dataTransfer?.files ?? [])
              if (files.length === 0 || !filesEnabled) return false

              event.preventDefault()
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
              const pos = coords?.pos ?? view.state.selection.from
              const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size))
              view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
              reportFiles(files)
              return true
            },
            handlePaste(view, event) {
              const files = Array.from(event.clipboardData?.files ?? [])
              if (files.length > 0 && filesEnabled) {
                event.preventDefault()
                reportFiles(files)
                return true
              }

              const text = event.clipboardData?.getData('text/plain') ?? ''
              if (!text) return false
              const hasSelection = !view.state.selection.empty
              const classification = classifyPaste(text, hasSelection)
              if (classification.kind === 'default') return false

              event.preventDefault()
              const trimmed = text.trim()
              if (classification.kind === 'autolink') {
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    type: 'text',
                    text: trimmed,
                    marks: [{ type: 'link', attrs: { href: trimmed, literal: true } }],
                  })
                  .run()
              } else {
                // 'link-selection': Link-Mark AUF die vorhandene Selektion legen — NIE
                // `[text](url)` mit text===url erzeugen (2b-Regel, s. editor-toolbar.tsx
                // LinkPopover), deshalb dieselbe literal-Prüfung wie dort.
                const { from, to } = view.state.selection
                const selectedText = view.state.doc.textBetween(from, to, '')
                const literal = selectedText.trim() === trimmed
                editor.chain().focus().setLink({ href: trimmed }).updateAttributes('link', { literal }).run()
              }
              return true
            },
          },
        }),
      ]
    },
  })
}
