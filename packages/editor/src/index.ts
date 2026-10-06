import { getSchema } from '@tiptap/core'
import type { Schema } from 'prosemirror-model'
import { editorExtensions } from './extensions.js'

export { editorExtensions } from './extensions.js'
export { Alert } from './nodes/alert.js'
export type { AlertType } from './nodes/alert.js'
export { EditorImage } from './nodes/image.js'
export { FootnoteDefinition } from './nodes/footnote-definition.js'
export { FootnoteReference } from './nodes/footnote-reference.js'
export { WikiLink } from './nodes/wiki-link.js'
export { YoutubeEmbed } from './nodes/youtube-embed.js'
export { collectUnsupported, markdownToDoc, UnsupportedMarkdownError } from './from-markdown.js'
export type { UnsupportedFinding } from './from-markdown.js'
export { docToMarkdown } from './to-markdown.js'
export { checkEditorSupport } from './check-support.js'
export type { EditorSupportReport, SupportFinding } from './check-support.js'

/** Baut das headless ProseMirror-Schema unseres Markdown-Dialekts (kein DOM, keine
 *  EditorView) — Grundlage für die mdast<->ProseMirror-Konverter (Task 3/4) und die
 *  spätere Tiptap-Instanz der Editor-UI (Phase 2c), die `editorExtensions()` direkt
 *  in `useEditor`/`new Editor({ extensions: … })` einsetzt. */
export function getEditorSchema(): Schema {
  return getSchema(editorExtensions())
}
