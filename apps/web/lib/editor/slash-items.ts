import type { Editor } from '@tiptap/core'
import type { AlertType } from '@f451/editor'
import { youtubeVideoId } from '@f451/markdown'
import type { T } from '../i18n/types.js'

// --- `/`-Befehlsmenü: Item-Liste + Filter (Phase 2c Task 5) ------------------------
//
// Reines Modul (kein DOM/Editor-Instanz nötig für `filterSlashItems` selbst — nur
// `run(editor)` braucht später eine echte Tiptap-Editor-Instanz, s. `slash-menu.tsx`/
// `ui-extensions.ts`). Deshalb hier node-testbar (`lib/**/*.test.ts`, kein jsdom).
//
// Video kam in Phase 3d Task 4 dazu (nutzt den `youtubeEmbed`-Node aus Task 2).
// draw.io kam in Phase 3e Task 4 dazu (`editor.commands.createDiagram('drawio')`,
// s. `ui-extensions.ts`); Excalidraw kam in Task 5 dazu (gleicher Custom-Command,
// `kind: 'excalidraw'`). Reihenfolge exakt wie im Brief/Mockup vorgegeben.
//
// Phase 2 (i18n): Labels/Hints + die beiden `window.prompt`/`window.alert`-Texte des
// „Video"-Items sind UI-sichtbar — dieses Modul hat aber (wie jedes `lib/**`-Modul)
// keinen Hook-Zugriff auf `useT()`. `filterSlashItems(query, t)` bekommt `t` deshalb
// als PARAMETER von der aufrufenden Komponente (`ui-extensions.ts#slashCommandExtension`,
// letztlich aus `wysiwyg-editor.tsx`s `useT()`) — Konvention s. `lib/i18n/types.ts#T`.
// Die Item-Liste wird dafür aus einer Konstante (`ITEMS`) zu einer kleinen
// Baufunktion (`buildItems(t)`), damit Labels/Hints/Prompt-Texte je Aufruf im
// aktuellen `t` aufgelöst werden — die `keywords` (Suchvokabular) bleiben bewusst
// unübersetzt (reine Matching-Hilfe, kein sichtbarer Text, s. Brief).

export interface SlashItem {
  id: string
  label: string
  hint?: string
  /** `.kbd`-Badge wie im Mockup (`##`, ` ``` `) — nur bei Items mit direktem
   *  Markdown-Shortcut gesetzt. */
  kbd?: string
  run(editor: Editor): void
}

/** Interne Erweiterung um ein Suchvokabular, damit z. B. „hin" alle 5
 *  Hinweisbox-Typen matcht (nicht nur „Hinweis" selbst) — wird vor der Rückgabe
 *  aus dem öffentlichen `SlashItem`-Shape wieder entfernt. */
interface SlashItemDef extends SlashItem {
  keywords: string
}

function insertAlert(alertType: AlertType) {
  return (editor: Editor) => {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'alert', attrs: { alertType }, content: [{ type: 'paragraph' }] })
      .run()
  }
}

const ALERT_DEFS: ReadonlyArray<{ id: string; type: AlertType; labelKey: 'alertNote' | 'alertTip' | 'alertImportant' | 'alertWarning' | 'alertCaution'; keywords: string }> = [
  { id: 'alertNote', type: 'note', labelKey: 'alertNote', keywords: 'hinweis hinweisbox callout note info' },
  { id: 'alertTip', type: 'tip', labelKey: 'alertTip', keywords: 'tipp hinweisbox callout tip' },
  { id: 'alertImportant', type: 'important', labelKey: 'alertImportant', keywords: 'wichtig hinweisbox callout important' },
  { id: 'alertWarning', type: 'warning', labelKey: 'alertWarning', keywords: 'warnung hinweisbox callout warning' },
  { id: 'alertCaution', type: 'caution', labelKey: 'alertCaution', keywords: 'achtung hinweisbox callout caution' },
]

/** Baut die Item-Liste NEU aus dem aktuellen `t` (Phase 2, s. Modulkommentar
 *  oben) — Labels/Hints kommen aus `messages/*\/editor.ts#slashItems`, die
 *  `keywords` (Suchvokabular) bleiben hartcodiert deutsch. */
function buildItems(t: T): readonly SlashItemDef[] {
  return [
    {
      id: 'heading1',
      label: t('editor.slashItems.heading1.label'),
      hint: t('editor.slashItems.heading1.hint'),
      kbd: '#',
      keywords: 'überschrift 1 heading h1 titel',
      run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      id: 'heading2',
      label: t('editor.slashItems.heading2.label'),
      hint: t('editor.slashItems.heading2.hint'),
      kbd: '##',
      keywords: 'überschrift 2 heading h2 abschnittstitel',
      run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: 'heading3',
      label: t('editor.slashItems.heading3.label'),
      hint: t('editor.slashItems.heading3.hint'),
      kbd: '###',
      keywords: 'überschrift 3 heading h3',
      run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      id: 'bulletList',
      label: t('editor.slashItems.bulletList.label'),
      hint: t('editor.slashItems.bulletList.hint'),
      keywords: 'aufzählung liste bullet list',
      run: (editor) => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: 'orderedList',
      label: t('editor.slashItems.orderedList.label'),
      hint: t('editor.slashItems.orderedList.hint'),
      keywords: 'nummerierte liste ordered list nummeriert',
      run: (editor) => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: 'taskList',
      label: t('editor.slashItems.taskList.label'),
      hint: t('editor.slashItems.taskList.hint'),
      keywords: 'aufgabenliste task liste checkliste todo',
      run: (editor) => editor.chain().focus().toggleTaskList().run(),
    },
    {
      id: 'table',
      label: t('editor.slashItems.table.label'),
      hint: t('editor.slashItems.table.hint'),
      keywords: 'tabelle table raster kopfzeile',
      run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      id: 'codeBlock',
      label: t('editor.slashItems.codeBlock.label'),
      hint: t('editor.slashItems.codeBlock.hint'),
      kbd: '```',
      keywords: 'codeblock code syntax',
      run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      id: 'blockquote',
      label: t('editor.slashItems.blockquote.label'),
      hint: t('editor.slashItems.blockquote.hint'),
      keywords: 'zitat quote blockquote',
      run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    },
    ...ALERT_DEFS.map(
      (def): SlashItemDef => ({
        id: def.id,
        label: t(`editor.slashItems.${def.labelKey}.label`),
        hint: t(`editor.slashItems.${def.labelKey}.hint`),
        keywords: def.keywords,
        run: insertAlert(def.type),
      }),
    ),
    {
      id: 'horizontalRule',
      label: t('editor.slashItems.horizontalRule.label'),
      hint: t('editor.slashItems.horizontalRule.hint'),
      keywords: 'trennlinie horizontal rule linie',
      run: (editor) => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'image',
      label: t('editor.slashItems.image.label'),
      hint: t('editor.slashItems.image.hint'),
      // Deckt sowohl den Bild- als auch den Datei-Anhang-Upload ab (PDF/Office/
      // ZIP/Text, s. `apps/web/lib/editor/upload-queue.ts#isUploadableFile`) —
      // beide teilen sich denselben Datei-Dialog (`accept`-Attribut in
      // wysiwyg-editor.tsx), die Einfüge-Entscheidung (Bild vs. Datei-Link) fällt
      // erst nach dem Upload anhand der Server-Antwort.
      keywords: 'bild image upload foto datei file anhang attachment pdf dokument',
      // Der eigentliche Upload-Flow (Datei-Dialog → uploadMedia → Node-Insert) läuft
      // außerhalb dieses reinen Moduls (React-State für Ladehinweis/Fehlerbanner, s.
      // wysiwyg-editor.tsx) — dieser Custom-Command triggert nur den Dialog, siehe
      // `triggerImageUpload` in ui-extensions.ts.
      run: (editor) => {
        editor.commands.triggerImageUpload()
      },
    },
    {
      id: 'drawio',
      label: t('editor.slashItems.drawio.label'),
      hint: t('editor.slashItems.drawio.hint'),
      keywords: 'diagramm drawio draw.io flussdiagramm chart',
      run(editor) {
        editor.chain().focus().createDiagram('drawio').run()
      },
    },
    {
      id: 'excalidraw',
      label: t('editor.slashItems.excalidraw.label'),
      hint: t('editor.slashItems.excalidraw.hint'),
      keywords: 'excalidraw skizze zeichnung sketch handgezeichnet',
      run(editor) {
        editor.chain().focus().createDiagram('excalidraw').run()
      },
    },
    {
      id: 'video',
      label: t('editor.slashItems.video.label'),
      hint: t('editor.slashItems.video.hint'),
      keywords: 'video youtube einbetten embed',
      run(editor) {
        // Bewusst window.prompt (Plan-Entscheidung 5): Ein-Feld-Eingabe,
        // eigener Dialog wäre YAGNI. Ungültige URL → Hinweis, nichts einfügen.
        const input = window.prompt(t('editor.slashItems.videoPrompt'))
        if (!input) return
        const url = input.trim()
        if (!youtubeVideoId(url)) {
          window.alert(t('editor.slashItems.videoInvalid'))
          return
        }
        editor.chain().focus().insertContent({ type: 'youtubeEmbed', attrs: { url } }).run()
      },
    },
  ]
}

/** Filtert die Item-Liste gegen die aktuelle `/`-Query (case-insensitive,
 *  Teilstring-Match gegen ein pro Item hinterlegtes Suchvokabular — NICHT nur
 *  gegen das Label, sonst würde „hin" nur „Hinweis" selbst treffen, s. Brief:
 *  „hin" → alle 5 Hinweisbox-Typen). Leere Query liefert alle Items in fester
 *  Mockup-Reihenfolge. `t` kommt von der aufrufenden Komponente (s. Modulkommentar
 *  oben) — die Items werden pro Aufruf neu gebaut (klein, kein Performance-Thema). */
export function filterSlashItems(query: string, t: T): SlashItem[] {
  const q = query.trim().toLowerCase()
  const items = buildItems(t)
  const matched = q.length === 0 ? items : items.filter((item) => item.keywords.includes(q))
  return matched.map(({ keywords: _keywords, ...item }) => item)
}
