import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { addRowAfter, goToNextCell } from '@tiptap/pm/tables'

// --- Tabellenzellen-Schutz (Phase 2c Task 3) -----------------------------------------
//
// `docToMarkdown` (packages/editor/src/to-markdown.ts:199-204) wirft HART, wenn eine
// Tabellenzelle mehr als einen Block oder einen Nicht-Absatz-Block enthält — eine
// Markdown-Tabellenzelle kann das nicht ausdrücken (`| text |` ist genau EIN Absatz).
// Dieses Doc darf im WYSIWYG-Editor also nie entstehen. Zwei unabhängige Mechanismen
// sichern dasselbe Ziel auf zwei Wegen ab (Keymap fängt die häufigste Ursache proaktiv
// ab, filterTransaction ist das Sicherheitsnetz für jeden anderen Weg dorthin):
//
// (a) Enter in tableCell/tableHeader springt zur nächsten Zelle statt den Absatz zu
//     splitten — dieselbe `goToNextCell`-Funktion aus prosemirror-tables, die
//     @tiptap/extension-table selbst für ihren eingebauten Tab-Handler verwendet
//     (node_modules/@tiptap/extension-table/dist/index.js, addKeyboardShortcuts). In
//     der letzten Zelle der Tabelle (goToNextCell liefert dort false) wird stattdessen
//     eine neue Zeile angehängt und in deren erste Zelle gesprungen — exakt das
//     Fallback-Muster des Tab-Handlers, hier für Enter nachgebaut.
// (b) `filterTransaction` (ProseMirror-Plugin-Hook, kein Tiptap-Command) verwirft JEDE
//     Transaktion, die eine Zelle mit ≠1 Block oder einem Nicht-Absatz-Block erzeugt —
//     das Sicherheitsnetz für alles, was (a) nicht abfängt (Paste mehrblockigen
//     Inhalts, Markdown-Shortcuts, Drag&Drop). `onCellOverflow` informiert die UI
//     (Statusmeldung, s. wysiwyg-editor.tsx) — dieses Modul kennt selbst keine
//     UI-Konzepte wie Toasts/Banner.

function isInsideTableCell(state: EditorState): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const typeName = $from.node(depth).type.name
    if (typeName === 'tableCell' || typeName === 'tableHeader') return true
  }
  return false
}

/** Enter-Ersatzbefehl für Tabellenzellen — Zellensprung statt Absatz-Split. Reine
 *  ProseMirror-Command-Signatur (state, dispatch?) => boolean, bewusst OHNE
 *  Tiptap-Editor-Instanz, damit table-guard.test.ts sie headless gegen eine per Hand
 *  gebaute `EditorState` prüfen kann (kein DOM, s. Brief). Außerhalb einer
 *  Tabellenzelle unverändert (liefert `false`, der normale Enter-Split greift). */
export function enterInTableCell(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!isInsideTableCell(state)) return false
  if (goToNextCell(1)(state, dispatch)) return true

  // Letzte Zelle der Tabelle: goToNextCell(1) liefert `false` (keine nächste Zelle
  // mehr). Ohne Tiptap-`chain()` (dieser Command muss auch ohne Editor-Instanz
  // funktionieren) als zwei aufeinanderfolgende Dispatches nachgebaut: addRowAfter
  // dispatcht seine Transaktion sofort, goToNextCell arbeitet danach auf dem daraus
  // resultierenden Zustand weiter — dieselbe Zwei-Schritte-Reihenfolge, die
  // `chain().addRowAfter().goToNextCell().run()` intern ausführt.
  if (!dispatch) return addRowAfter(state)
  let jumped = false
  addRowAfter(state, (tr) => {
    dispatch(tr)
    jumped = goToNextCell(1)(state.apply(tr), dispatch)
  })
  return jumped
}

/** `true`, wenn `doc` mindestens eine Tabellenzelle mit ≠1 Block oder einem
 *  Nicht-Absatz-Block enthält — exakt die Bedingung, an der `docToMarkdown` hart
 *  wirft (s. to-markdown.ts:199-204). Steigt in Zellinhalte NICHT weiter ab (deren
 *  Kind-Blöcke sind für diese Prüfung irrelevant, nur die direkte Zellstruktur
 *  zählt). */
function hasInvalidTableCell(doc: PmNode): boolean {
  let invalid = false
  doc.descendants((node) => {
    if (invalid) return false
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      if (node.childCount !== 1 || node.firstChild?.type.name !== 'paragraph') {
        invalid = true
      }
      return false
    }
    return true
  })
  return invalid
}

/** Der reine ProseMirror-Plugin-Teil von (b) — eigenständig exportiert, damit
 *  table-guard.test.ts ihn direkt in `EditorState.create({schema, doc, plugins})`
 *  einsetzen kann, ohne eine Tiptap-`Editor`-Instanz (kein DOM) zu benötigen. */
export function tableGuardPlugin(onCellOverflow?: () => void): Plugin {
  return new Plugin({
    key: new PluginKey('tableGuard'),
    filterTransaction(tr) {
      if (!tr.docChanged) return true
      if (hasInvalidTableCell(tr.doc)) {
        onCellOverflow?.()
        return false
      }
      return true
    },
  })
}

export interface TableGuardOptions {
  /** Aufgerufen, wenn `filterTransaction` eine Transaktion verwirft (z. B. Paste
   *  mehrblockigen Inhalts in eine Zelle) — die UI zeigt daraufhin eine
   *  Statusmeldung (s. wysiwyg-editor.tsx). */
  onCellOverflow?: () => void
}

/** Tiptap-Extension: bündelt (a) und (b) für den echten Editor (ui-extensions.ts). */
export const TableGuard = Extension.create<TableGuardOptions>({
  name: 'tableGuard',

  addOptions() {
    return { onCellOverflow: undefined }
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.command(({ state, dispatch }) => enterInTableCell(state, dispatch)),
    }
  },

  addProseMirrorPlugins() {
    return [tableGuardPlugin(this.options.onCellOverflow)]
  },
})
