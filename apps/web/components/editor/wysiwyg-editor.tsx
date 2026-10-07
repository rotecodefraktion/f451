'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { EditorContent, useEditor } from '@tiptap/react'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { docToMarkdown, markdownToDoc } from '@f451/editor'
import { searchPages, UploadError, uploadMedia } from '../../lib/editor/client-api'
import { diagramPath, diagramSlug, type DiagramKind } from '../../lib/editor/diagram'
import { caretScrollDelta } from '../../lib/editor/caret-scroll'
import { bumpDiagramVersion } from '../../lib/editor/diagram-versions'
import { findDefinition, findFirstReference } from '../../lib/editor/footnotes'
import { trackKeyboardInset } from '../../lib/editor/keyboard-inset'
import { uiExtensions } from '../../lib/editor/ui-extensions'
import { initialUploadQueueState, skippedFilesNotice, uploadQueueReducer } from '../../lib/editor/upload-queue'
import { attachWritingMode } from '../../lib/editor/writing-mode'
import { isPhoneLayout } from '../../lib/phone'
import { DrawioDialog } from './drawio-dialog'
import { EditorToolbar } from './editor-toolbar'
import { ExcalidrawDialog } from './excalidraw-dialog'
import { PhoneToolbar } from './phone-toolbar'
import { useT } from '../../lib/i18n/provider'

/** Ergebnis von `getMarkdownBody()` — diskriminiert, damit ein Konvertierungsfehler
 *  am Rückgabewert selbst erkennbar ist statt in einem separaten Flag, das ein
 *  Aufrufer vergessen könnte abzufragen.
 *
 *  VERTRAG: Bei `ok:false` darf NICHT gespeichert werden — der Body im Editor
 *  konnte nicht in Markdown umgewandelt werden, ein Speichern würde den
 *  zuletzt bekannten (STALE) Ausgangsstand persistieren und die
 *  Nutzeränderungen der Sitzung stillschweigend verwerfen. */
export type MarkdownBodyResult = { ok: true; body: string } | { ok: false }

export interface WysiwygEditorHandle {
  /** Aktueller Editor-Inhalt als Markdown-Body (OHNE Frontmatter — editor-root fügt
   *  das über `joinFrontmatter` beim Speichern wieder an, s. Task 4). `docToMarkdown`
   *  wirft laut Vertrag (`packages/editor/src/to-markdown.ts`) nur bei einem
   *  UI-Bug (z. B. eine Zelle, die table-guard hätte verhindern müssen) — dieser Throw
   *  wird hier abgefangen und als Fehlerbanner gemeldet statt die Seite abstürzen zu
   *  lassen. Der Fehlerfall ist über `ok:false` am Rückgabewert selbst erkennbar —
   *  s. `MarkdownBodyResult`-Vertrag: bei `ok:false` NICHT speichern. */
  getMarkdownBody(): MarkdownBodyResult
}

/** Zustand des Diagramm-Dialogs (draw.io/Excalidraw). Öffnen läuft über
 *  `onEditDiagram`/`onCreateDiagram` (s. `uiExtensions`-Optionen unten),
 *  Rendering über `kind` (Task 4: `DrawioDialog`; Task 5: `ExcalidrawDialog`
 *  — beide unten in der JSX-Rückgabe). */
export interface DiagramDialogState {
  kind: DiagramKind
  path: string
  /** `true` = Neuanlage per Slash-Item (ifAbsent-Save + Image-Node-Insert nach
   *  Erfolg statt Überschreiben eines bestehenden Diagramms). */
  isNew: boolean
  alt: string
}

export interface WysiwygEditorProps {
  pageId: string
  /** Space-Slug der Seite — grenzt die `[[`-Autocomplete-Suche ein (Task 5,
   *  s. lib/editor/wiki-suggest.ts). */
  space: string
  /** Markdown-Body OHNE Frontmatter (editor-root hat bereits `splitFrontmatter`
   *  angewendet — der Editor selbst kennt kein Frontmatter). */
  body: string
  /** Wird bei jeder inhaltlichen Änderung aufgerufen (Task 4: Autosave-`onChange`
   *  in editor-root). */
  onDirty?: () => void
  /** `false` während eines fremden, noch nicht bewusst übernommenen Soft-Locks
   *  (Task 4: „Editor startet READONLY" bis „Trotzdem bearbeiten"). Default `true`.
   *  Reagiert dynamisch über `editor.setEditable` (kein Remount nötig — anders als
   *  ein Body-Wechsel, s. `initialContent` unten, betrifft das nur die
   *  Editierbarkeit, nicht den Dokumentinhalt). */
  editable?: boolean
}

const CELL_OVERFLOW_NOTICE_MS = 4000

/** Nearest ancestor that scrolls vertically (in this app `.main`), or `null`
 *  when the window scrolls. */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/** Phone layout (f451#2): keeps the caret between the writing header and the
 *  formatting bar above the keyboard. Returns false outside the phone layout
 *  so ProseMirror scrolls as usual.
 *
 *  Coordinate system: client coordinates of the LAYOUT viewport throughout.
 *  `coordsAtPos` and `getBoundingClientRect` report those; the visual viewport
 *  (what is not covered by the keyboard) is the band
 *  [vv.offsetTop, vv.offsetTop + vv.height] of the same system. */
function scrollCaretIntoPhoneView(view: EditorView): boolean {
  if (!isPhoneLayout()) return false
  const caret = view.coordsAtPos(view.state.selection.head)
  const vv = window.visualViewport
  const vvTop = vv ? vv.offsetTop : 0
  const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
  // The sticky writing header covers the top of the scroll area; when the
  // visual viewport is scrolled below it, the viewport edge is the limit.
  const headerBottom = document.querySelector('.writing-header')?.getBoundingClientRect().bottom ?? 0
  const toolbarHeight = document.querySelector('.phone-toolbar')?.getBoundingClientRect().height ?? 0
  const delta = caretScrollDelta(caret, { top: Math.max(vvTop, headerBottom), visibleBottom }, toolbarHeight)
  if (delta !== 0) {
    const container = scrollContainerOf(view.dom)
    if (container) container.scrollBy({ top: delta })
    else window.scrollBy({ top: delta })
  }
  return true
}

/**
 * Tiptap-WYSIWYG-Fläche (Phase 2c Task 3). Baut die Editor-Instanz aus
 * `uiExtensions(pageId)` + dem initialen Markdown-Body (`markdownToDoc`), rendert
 * Toolbar + Editierfläche (`.body > .doc`, Klassen aus dem Mockup) und exponiert den
 * aktuellen Markdown-Stand über ein Ref-Handle (Task 4 braucht `getMarkdownBody()`
 * zum Speichern).
 *
 * ⌘K im Editor-Fokus öffnet das Link-Popover der Toolbar UND verhindert, dass der
 * globale ⌘K-Suchdialog (`components/search-dialog.tsx`, lauscht auf `document`)
 * gleichzeitig öffnet: `editorProps.handleKeyDown` läuft auf dem
 * ProseMirror-Content-Element (einem Vorfahren-Element von `document` im
 * DOM-Baum) und ruft `stopPropagation` VOR dem globalen Listener auf.
 */
export const WysiwygEditor = forwardRef<WysiwygEditorHandle, WysiwygEditorProps>(function WysiwygEditor(
  { pageId, space, body, onDirty, editable = true },
  ref,
) {
  const { t } = useT()
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [cellOverflowNotice, setCellOverflowNotice] = useState(false)
  const [conversionError, setConversionError] = useState(false)
  // Andockpunkt für den draw.io-/Excalidraw-Dialog (Tasks 4/5) — dieser Task
  // setzt nur den Zustand (Bearbeiten-Button/Slash-Item), das Dialog-Rendering
  // selbst folgt später (s. `DiagramDialogState`-Kommentar oben).
  const [diagramDialog, setDiagramDialog] = useState<DiagramDialogState | null>(null)
  // Self-Review (Task 4): referenzstabil statt einer Inline-Closure im JSX
  // unten — `onClose` fließt in `DrawioDialog`s postMessage-Listener-Effect
  // ein (Dependency-Array). Eine bei jedem Render NEUE Funktion hätte diesen
  // Effect bei JEDEM Re-Render von `WysiwygEditor` (z. B. Lock-Heartbeat alle
  // 45s im übergeordneten `EditorSession`) neu aufgesetzt und damit den
  // internen `pendingExit`-Zwischenstand von `createDrawioProtocol` verloren,
  // falls das genau zwischen einem `save`- und dem folgenden `export`-Event
  // passiert — ein „Save and Exit" hätte dann zwar gespeichert, aber den
  // Dialog fälschlich offen gelassen (`exit` wäre auf `false` zurückgefallen).
  const closeDiagramDialog = useCallback(() => setDiagramDialog(null), [])
  // Erfolgs-Handler des Diagramm-Dialogs (Tasks 4/5) — feuert NACH dem
  // persistierten PUT (s. `DrawioDialog#onSaved`/`ExcalidrawDialog#onSaved`).
  // Bei Neuanlage entsteht hier ERSTMALS ein `image`-Node im Dokument (bei
  // einem Bestandsdiagramm ändert sich nur die Datei, nicht das Markdown —
  // deshalb dort auch `onDirty` NICHT nötig). Ab dem ersten Save ist die
  // Datei kein Fall mehr für `ifAbsent` — `isNew` wird deshalb sofort auf
  // `false` gesetzt, sonst würde ein zweiter Save im selben Dialog (erneut
  // „Speichern" ohne Schließen) am 409 aus `saveDiagram` scheitern.
  const handleDiagramSaved = useCallback(
    (state: DiagramDialogState) => {
      if (state.isNew) {
        editorRef.current
          ?.chain()
          .focus()
          .insertContent({ type: 'image', attrs: { src: state.path, alt: state.alt } })
          .run()
        setDiagramDialog((current) => (current ? { ...current, isNew: false } : current))
        onDirty?.()
      }
      bumpDiagramVersion(pageId, state.path)
    },
    [onDirty, pageId],
  )
  // Finding 2 (Review Task 5): zwei gleichzeitige Uploads (z. B. Datei-Dialog +
  // Drop) dürfen sich nicht gegenseitig überschreiben. Ersetzt die vormaligen
  // Einzel-States `uploading`/`uploadError` durch die Zähler-/Fehlersammel-
  // Zustandsmaschine aus upload-queue.ts — `uploading` unten ist abgeleitet
  // (`active > 0`), Fehler werden im `errors`-Array GESAMMELT statt ersetzt.
  const [uploadQueue, dispatchUploadQueue] = useReducer(uploadQueueReducer, initialUploadQueueState)
  const uploading = uploadQueue.active > 0
  const uploadErrors = uploadQueue.errors
  const [skippedFilesNoticeText, setSkippedFilesNoticeText] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const skippedNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const phoneImageInputRef = useRef<HTMLInputElement>(null)
  // uiExtensions() (s. useMemo unten) baut die Extensions VOR `useEditor()` — zu
  // diesem Zeitpunkt existiert die Editor-Instanz noch nicht. `handleUploadFiles`
  // braucht sie aber erst beim tatsächlichen Upload (weit nach dem Mount), deshalb
  // hier über einen Ref entkoppelt statt einer direkten Closure auf `editor`.
  const editorRef = useRef<Editor | null>(null)

  const notifyCellOverflow = useCallback(() => {
    setCellOverflowNotice(true)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setCellOverflowNotice(false), CELL_OVERFLOW_NOTICE_MS)
  }, [])

  useEffect(() => () => {
    clearTimeout(noticeTimer.current)
    clearTimeout(skippedNoticeTimer.current)
  }, [])

  // Ein Drop/Paste-Event, das (auch) Nicht-Bild-Dateien enthielt (Finding 1: „nie
  // stilles Verwerfen" statt einer Meldung pro Datei oder gar keiner) — eine
  // Sammel-Notice, die wie `notifyCellOverflow` nach einer Weile wieder verschwindet.
  const notifySkippedFiles = useCallback(
    (count: number) => {
      setSkippedFilesNoticeText(skippedFilesNotice(count, t))
      clearTimeout(skippedNoticeTimer.current)
      skippedNoticeTimer.current = setTimeout(() => setSkippedFilesNoticeText(null), CELL_OVERFLOW_NOTICE_MS)
    },
    [t],
  )

  // Media-Upload-Flow (Task 5, um Datei-Anhänge erweitert): Datei-Dialog (Toolbar/
  // Slash-Item „Bild/Datei", immer genau eine Datei) ODER Drop/Paste (s.
  // ui-extensions.ts#mediaPasteAndDropExtension, 0..n Dateien EINES Events) landen
  // HIER. Spec §9: Fehler PRÄZISE anzeigen (Server-`reason` durchreichen), nie
  // stilles Verwerfen — UND kein Platzhalter-Node im Doc während des Uploads (ein
  // Node entsteht erst nach Erfolg der jeweiligen Datei).
  //
  // Ob eine hochgeladene Datei als Bild (`setImage`) oder als Datei-Link eingefügt
  // wird, entscheidet das `kind`-Feld der SERVER-Antwort (`drafts/upload.ts`,
  // Magic-Bytes-geprüft) — NICHT die client-seitige Vorklassifizierung
  // (`isUploadableFile`, nur ein Vorfilter). Der Link-Text ist der ORIGINAL-
  // Dateiname (`file.name`, nicht der server-seitig slugifizierte); Einfügen über
  // `insertContent` mit einem `link`-Mark (Muster: die 'link-selection'/'autolink'-
  // Einfügungen in ui-extensions.ts#mediaPasteAndDropExtension) statt eines eigenen
  // Attachment-Nodes — ein regulärer `[text](url)`-Markdown-Link roundtrippt bereits
  // byte-identisch über die bestehende Link-Mark-Serialisierung (to-markdown.ts/
  // from-markdown.ts), ein Custom-Node wäre hier nur zusätzliche, unnötige Fläche.
  //
  // Finding 1: mehrere Dateien werden SEQUENZIELL (nicht `Promise.all`) hochgeladen —
  // sowohl `setImage` als auch `insertContent` fügen am aktuellen Selektions-Cursor
  // ein und rücken ihn danach hinter den neuen Inhalt vor, nur so landen mehrere
  // Dateien eines Events in der richtigen Reihenfolge. Finding 2: `dispatchUploadQueue`
  // zählt aktive Uploads statt eines Einzel-Booleans und SAMMELT Fehler statt sie zu
  // überschreiben — dadurch verträgt dieselbe Funktion auch zwei gleichzeitig
  // laufende Aufrufe (Datei-Dialog + Drop).
  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current
      if (!currentEditor || files.length === 0) return
      dispatchUploadQueue({ type: 'start', count: files.length })
      for (const file of files) {
        try {
          const result = await uploadMedia(pageId, file, t)
          if (result.kind === 'image') {
            currentEditor.chain().focus().setImage({ src: result.path }).run()
          } else {
            currentEditor
              .chain()
              .focus()
              .insertContent({
                type: 'text',
                text: file.name,
                marks: [{ type: 'link', attrs: { href: result.path, literal: false } }],
              })
              .run()
          }
          dispatchUploadQueue({ type: 'success' })
        } catch (err) {
          const message = err instanceof UploadError ? err.message : t('editor.wysiwyg.uploadFailed')
          dispatchUploadQueue({ type: 'error', message: files.length > 1 ? `${file.name}: ${message}` : message })
        }
      }
    },
    [pageId, t],
  )

  const openImagePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // uiExtensions/das initiale Doc werden bewusst nur EINMAL pro (pageId, body)
  // gebaut — `body` ist der beim Mount geladene Draft-Inhalt, nicht reaktiv (ein
  // späteres erneutes Laden ersetzt die ganze Komponente über den `key` in
  // editor-root, s. dort).
  const extensions = useMemo(
    () =>
      uiExtensions(pageId, {
        onCellOverflow: notifyCellOverflow,
        space,
        searchPages,
        onUploadFiles: handleUploadFiles,
        onFilesSkipped: notifySkippedFiles,
        onRequestImagePicker: openImagePicker,
        t,
        // Bearbeiten-Button einer bestehenden Diagramm-NodeView (s.
        // ui-extensions.ts#imageWithMediaSrc) — öffnet den Dialog im
        // Überschreiben-Modus (`isNew: false`, kein `ifAbsent`-Save).
        onEditDiagram: ({ path, kind }) => setDiagramDialog({ kind, path, isNew: false, alt: '' }),
        // Slash-Item „Diagramm"/„Skizze" (Tasks 4/5) — fragt den Zielnamen ab
        // BEVOR der Dialog öffnet (der Dateiname steht bei der Neuanlage noch
        // nicht fest, anders als beim Bearbeiten eines bestehenden Diagramms).
        onCreateDiagram: (kind) => {
          const input = window.prompt(
            kind === 'drawio' ? t('editor.wysiwyg.drawioNamePrompt') : t('editor.wysiwyg.excalidrawNamePrompt'),
          )
          if (!input) return
          const slug = diagramSlug(input.trim())
          if (!slug) {
            window.alert(t('editor.wysiwyg.invalidDiagramName'))
            return
          }
          setDiagramDialog({ kind, path: diagramPath(slug, kind), isNew: true, alt: input.trim() })
        },
      }),
    [pageId, notifyCellOverflow, space, handleUploadFiles, notifySkippedFiles, openImagePicker, t],
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialContent = useMemo(() => markdownToDoc(body).toJSON(), [])

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable,
    immediatelyRender: false,
    onUpdate: () => onDirty?.(),
    editorProps: {
      // `page-body` bringt die komplette Leseansicht-Typografie mit (h1–h6, p,
      // strong, code, blockquote, Listen, Bilder, Alerts — s. globals.css-
      // Kopfkommentar zum Editor-Abschnitt), `doc` ergänzt die wenigen Stellen,
      // an denen Tiptaps DOM vom gerenderten Lese-HTML abweicht (Tabellen ohne
      // thead/tbody, Task-Listen über data-type/data-checked).
      attributes: { class: 'doc page-body' },
      handleScrollToSelection: scrollCaretIntoPhoneView,
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          event.stopPropagation()
          setLinkPopoverOpen(true)
          return true
        }
        return false
      },
      // Footnotes (f451#82): a click on a reference jumps to the start of its
      // definition; a click on a definition's own box (padding/label area, not
      // its content) jumps back to the first reference.
      handleClick: (view, pos, event) => {
        const target = event.target instanceof Element ? event.target : null
        if (!target) return false
        const { doc } = view.state

        const ref = target.closest('sup.fn-ref')
        if (ref && view.dom.contains(ref)) {
          const label = ref.getAttribute('data-footnote-ref') ?? ''
          const node = doc.nodeAt(pos)
          const identifier = node?.type.name === 'footnoteReference' ? (node.attrs.identifier as string | null) : null
          const defPos = findDefinition(doc, label, identifier)
          if (defPos === null) return false
          // `near` from inside the definition lands at the start of its first textblock.
          const selection = TextSelection.near(doc.resolve(defPos + 1))
          view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
          return true
        }

        if (target.matches('div.fn-def')) {
          const label = target.getAttribute('data-footnote-def') ?? ''
          const refPos = findFirstReference(doc, label)
          if (refPos === null) return false
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, refPos)).scrollIntoView())
          return true
        }
        return false
      },
    },
  })

  // `editable` ist bei useEditor nur der INITIALE Wert (Extensions/Content sind laut
  // Kommentar oben bewusst nicht reaktiv) — spätere Wechsel (Soft-Lock-Übernahme via
  // „Trotzdem bearbeiten") laufen über die von Tiptap dafür vorgesehene Methode.
  //
  // Fix-Runde (Save-Button Mangel 1): `Editor#setEditable(editable, emitUpdate = true)`
  // emittiert per Default IMMER ein `"update"`-Event (s. installiertes
  // `@tiptap/core/dist/index.js#setEditable`) — unabhängig davon, ob sich der Dokument-
  // inhalt tatsächlich geändert hat. Dieses Effect läuft aber unweigerlich EINMAL direkt
  // nach dem allerersten Mount (Übergang `editor` von `null` auf die frische Instanz,
  // `useEditor` liefert sie asynchron wegen `immediatelyRender: false`), und ruft dabei
  // `setEditable(editable)` mit dem bereits beim Erstellen gesetzten Anfangswert auf —
  // rein redundant für den Editierbarkeits-Zustand, aber NICHT redundant für `onUpdate`:
  // `onUpdate: () => onDirty?.()` (s. `useEditor`-Optionen unten) reagiert auf jedes
  // `"update"`-Event und markiert den Autosave dadurch fälschlich als `dirty`, BEVOR der
  // Nutzer auch nur ein Zeichen getippt hat — der „Speichern"-Button wäre direkt beim
  // Öffnen des Editors aktiv statt disabled. Derselbe Effekt träte bei jedem weiteren
  // `setEditable`-Aufruf auf (z. B. Soft-Lock-Override „Trotzdem bearbeiten"), obwohl sich
  // dort ebenfalls nur die Editierbarkeit ändert, kein Dokumentinhalt. `emitUpdate:false`
  // unterdrückt GENAU dieses synthetische Update — echte Inhaltsänderungen laufen weiterhin
  // über ProseMirror-Transaktionen mit `docChanged`, die `dispatchTransaction` unabhängig
  // davon selbst emittiert (s. dortiger `emit("update", …)`-Aufruf), bleiben also unberührt.
  useEffect(() => {
    editor?.setEditable(editable, false)
  }, [editor, editable])

  // s. Kommentar bei `editorRef` oben: hält die Editor-Instanz für `handleUploadFiles`
  // nach, die außerhalb dieser Komponente (ui-extensions.ts) NICHT direkt auf
  // `editor` zugreifen kann.
  useEffect(() => {
    editorRef.current = editor ?? null
  }, [editor])

  // Phone layout (f451#2): keyboard height for the formatting bar and writing
  // mode while the editor has focus. Depends on `editor` because the wrapper
  // only exists once the editor has been created (loading state above).
  const writingRootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = writingRootRef.current
    if (!editor || !root || !isPhoneLayout()) return
    const stopInset = trackKeyboardInset()
    const detachWriting = attachWritingMode(root)
    return () => {
      detachWriting()
      stopInset()
    }
  }, [editor])

  useImperativeHandle(
    ref,
    () => ({
      getMarkdownBody(): MarkdownBodyResult {
        if (!editor) return { ok: false }
        try {
          const markdown = docToMarkdown(editor.state.doc)
          setConversionError(false)
          return { ok: true, body: markdown }
        } catch (err) {
          // Ein Throw hier ist ein Bug (table-guard/Schema hätten das verhindern
          // müssen), kein erwarteter Nutzerfehler — deshalb loggen UND eine
          // Fehlerkarte zeigen, statt die Seite abstürzen zu lassen. `ok:false`
          // signalisiert dem Aufrufer zusätzlich am Rückgabewert selbst, dass NICHT
          // gespeichert werden darf (s. `MarkdownBodyResult`-Vertrag oben).
          console.error('docToMarkdown ist unerwartet fehlgeschlagen:', err)
          setConversionError(true)
          return { ok: false }
        }
      },
    }),
    [editor],
  )

  if (!editor) {
    return (
      <div className="body">
        <p>{t('editor.wysiwyg.loading')}</p>
      </div>
    )
  }

  // `.wysiwyg-editor` is `display: contents` (`62-editor.css`): it exists only
  // as the writing-mode focus root and leaves the layout (sticky `.etoolbar`)
  // as it was with the former fragment.
  return (
    <div className="wysiwyg-editor" ref={writingRootRef}>
      {editable ? (
        <EditorToolbar
          editor={editor}
          linkPopoverOpen={linkPopoverOpen}
          onOpenLinkPopover={() => setLinkPopoverOpen(true)}
          onCloseLinkPopover={() => setLinkPopoverOpen(false)}
        />
      ) : null}
      {editable ? (
        <PhoneToolbar
          editor={editor}
          onPickImage={() => phoneImageInputRef.current?.click()}
        />
      ) : null}
      {/* Image picker of the phone bar (f451#2): images only and no `capture`
          attribute, so iOS/Android offer both camera and photo library. */}
      <input
        ref={phoneImageInputRef}
        type="file"
        accept="image/*"
        className="upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void handleUploadFiles([file])
        }}
      />
      {/* Verstecktes Datei-Feld für den Upload-Flow (Toolbar-Button/Slash-Item
          „Bild/Datei", s. `openImagePicker`/`ui-extensions.ts#triggerImageUpload`) —
          akzeptiert Bilder UND die erlaubten Dokument-Anhänge (deckungsgleich mit
          der Server-Whitelist, `apps/api/src/drafts/upload.ts#DOCUMENT_EXTENSION_WHITELIST`;
          nur eine Browser-Dialog-Vorfilterung, die verbindliche Prüfung läuft
          serverseitig per Magic-Bytes). Der Wert wird nach jeder Auswahl
          zurückgesetzt, damit dieselbe Datei erneut ausgewählt werden kann und
          `onChange` dabei zuverlässig feuert. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv,.md"
        className="upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void handleUploadFiles([file])
        }}
      />
      {conversionError ? (
        <div className="notices">
          <div className="notice broken">
            <span className="txt">
              <b>{t('editor.wysiwyg.conversionErrorTitle')}</b>
              {t('editor.wysiwyg.conversionErrorBody')}
            </span>
          </div>
        </div>
      ) : null}
      {uploading ? (
        <div className="notices">
          <div className="notice info">
            <span className="txt">{t('editor.wysiwyg.uploading')}</span>
          </div>
        </div>
      ) : null}
      {uploadErrors.length > 0 ? (
        <div className="notices">
          <div className="notice broken">
            <span className="txt">
              <b>{t('editor.wysiwyg.uploadErrors', { count: uploadErrors.length })}</b>
              {/* Finding 2: mehrere gleichzeitig fehlgeschlagene Uploads werden GESAMMELT
                  angezeigt (kein Überschreiben) — analog `.notice-list` in page-view.tsx. */}
              <ul className="notice-list">
                {uploadErrors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            </span>
          </div>
        </div>
      ) : null}
      {skippedFilesNoticeText ? (
        <div className="notices">
          <div className="notice warn">
            <span className="txt">
              <b>{t('editor.wysiwyg.skippedFilesTitle')}</b>
              {skippedFilesNoticeText}
            </span>
          </div>
        </div>
      ) : null}
      {cellOverflowNotice ? (
        <div className="notices">
          <div className="notice warn">
            <span className="txt">
              <b>{t('editor.wysiwyg.cellOverflowTitle')}</b>
              {t('editor.wysiwyg.cellOverflowBody')}
            </span>
          </div>
        </div>
      ) : null}
      <div className="body">
        <EditorContent editor={editor} />
      </div>
      {diagramDialog?.kind === 'drawio' ? (
        <DrawioDialog pageId={pageId} state={diagramDialog} onSaved={handleDiagramSaved} onClose={closeDiagramDialog} />
      ) : null}
      {diagramDialog?.kind === 'excalidraw' ? (
        <ExcalidrawDialog pageId={pageId} state={diagramDialog} onSaved={handleDiagramSaved} onClose={closeDiagramDialog} />
      ) : null}
    </div>
  )
})
