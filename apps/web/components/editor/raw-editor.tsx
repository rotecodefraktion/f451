'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { checkEditorSupport } from '@f451/editor'
import type { SupportFinding } from '@f451/editor'
import { frontmatterLineOffset, offsetFindingLines } from '../../lib/editor/frontmatter-offset'

export interface RawEditorHandle {
  /** Aktueller Inhalt — das VOLLE Dokument inkl. Frontmatter (Task 6: der
   *  Roh-Modus ist in 2c der einzige Frontmatter-Editor). */
  getContent(): string
  /** Scrollt zur gegebenen 1-basierten Zeile und setzt den Cursor dorthin —
   *  Ziel des Klicks auf eine Zeile im `findings-panel`. `line` ist die VOLLE
   *  Dokumentzeile (Final-Review Phase 2c Task 6, Critical-Fix): `findings`
   *  aus `onFindingsChange` unten tragen bereits den Frontmatter-Offset
   *  (`frontmatterLineOffset`), kein erneutes Verschieben hier nötig — sonst
   *  landete der Scroll ein zweites Mal versetzt. */
  scrollToLine(line: number): void
}

export interface RawEditorProps {
  /** Initialer Inhalt (VOLLES Dokument) — wie `WysiwygEditor`s `body` bewusst
   *  NICHT reaktiv: ein Wechsel des Ausgangsstands (z. B. nach Konfliktlösung)
   *  läuft über einen Remount (`key` in `editor-root.tsx`), kein Re-Sync
   *  während des Tippens. */
  content: string
  /** Task 4: Autosave-`onChange` bei jeder inhaltlichen Änderung. */
  onDirty?: () => void
  /** Letzter `checkEditorSupport`-Report aus dem (debounced) Lint-Lauf — die
   *  Quelle des `findings-panel` im Roh-Modus (s. dortiger Kommentar). */
  onFindingsChange?: (findings: SupportFinding[]) => void
  /** `false` während eines fremden, noch nicht übernommenen Soft-Locks. */
  editable?: boolean
}

const LINT_DEBOUNCE_MS = 1000

function severityOf(kind: SupportFinding['kind']): 'error' | 'warning' {
  return kind === 'unsupported' ? 'error' : 'warning'
}

/**
 * Roh-Text-Editor (Phase 2c Task 6, CodeMirror 6) — die einzige Fläche, auf
 * der auch der Frontmatter-Block direkt bearbeitet wird (`content` ist stets
 * das VOLLE Dokument, kein `splitFrontmatter` hier). Bewusst ohne
 * `basicSetup` (YAGNI, Brief: „vermeiden, wenn Einzelmodule reichen") — nur
 * Zeilennummern, Verlauf (Undo/Redo), die Standard-Tastenbelegung und die
 * Markdown-Sprache sind hier tatsächlich nötig.
 *
 * Lint-Diagnostics: `checkEditorSupport` läuft über `linter()` mit dessen
 * eingebautem `delay` (1 s, Brief-Vorgabe) — kein eigener Debounce-Timer
 * nötig, das deckt @codemirror/lint bereits ab. Nur Befunde MIT `line`
 * (ausschließlich `kind: 'unsupported'`, s. `@f451/editor`-README) werden als
 * Gutter-Diagnostic verortet; jeder Befund (mit oder ohne Zeile) geht
 * zusätzlich unverändert an `onFindingsChange` — die vollständige Liste fürs
 * `findings-panel`.
 */
export const RawEditor = forwardRef<RawEditorHandle, RawEditorProps>(function RawEditor(
  { content, onDirty, onFindingsChange, editable = true },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editableCompartment = useRef(new Compartment())
  // Aktuellste Callback-Referenzen ohne Neubau der Extensions bei jedem
  // Render (die Extensions selbst werden nur EINMAL pro Mount gebaut, s.
  // `content` in der useEffect-Dependency-Liste unten).
  const onDirtyRef = useRef(onDirty)
  const onFindingsChangeRef = useRef(onFindingsChange)
  onDirtyRef.current = onDirty
  onFindingsChangeRef.current = onFindingsChange

  useEffect(() => {
    const parent = containerRef.current
    if (!parent) return

    const lintSource = linter(
      (view) => {
        const fullDoc = view.state.doc.toString()
        const report = checkEditorSupport(fullDoc)
        // Critical-Fix (Final-Review Phase 2c Task 6): `report.findings[].line`
        // ist BODY-relativ (s. `@f451/editor#checkEditorSupport`) — `fullDoc`
        // hier ist aber das VOLLE Dokument inkl. Frontmatter. Der Versatz wird
        // GENAU HIER, EINMAL, angewendet — die daraus resultierenden vollen
        // Dokumentzeilen fließen unverändert sowohl in die Gutter-Diagnostics
        // unten als auch (über `onFindingsChange`) ins `findings-panel` und
        // dessen Klick-Ziel `scrollToLine`.
        const findings = offsetFindingLines(report.findings, frontmatterLineOffset(fullDoc))
        onFindingsChangeRef.current?.(findings)
        const diagnostics: Diagnostic[] = []
        for (const finding of findings) {
          if (finding.line === undefined) continue
          const lineNumber = Math.min(Math.max(finding.line, 1), view.state.doc.lines)
          const line = view.state.doc.line(lineNumber)
          diagnostics.push({ from: line.from, to: line.to, severity: severityOf(finding.kind), message: finding.message })
        }
        return diagnostics
      },
      { delay: LINT_DEBOUNCE_MS },
    )

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        lintSource,
        lintGutter(),
        editableCompartment.current.of([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onDirtyRef.current?.()
        }),
      ],
    })

    const view = new EditorView({ state, parent })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  // `editable` reagiert dynamisch (Soft-Lock-Übernahme über „Trotzdem
  // bearbeiten") — analog `WysiwygEditor#setEditable`, hier über das
  // Compartment statt eines Neuaufbaus der gesamten Extension-Liste.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
    })
  }, [editable])

  useImperativeHandle(
    ref,
    () => ({
      getContent: () => viewRef.current?.state.doc.toString() ?? content,
      scrollToLine: (targetLine: number) => {
        const view = viewRef.current
        if (!view) return
        const clamped = Math.min(Math.max(targetLine, 1), view.state.doc.lines)
        const pos = view.state.doc.line(clamped).from
        view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
        view.focus()
      },
    }),
    [content],
  )

  return <div className="raw-editor" ref={containerRef} />
})
