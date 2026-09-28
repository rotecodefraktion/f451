/**
 * Englisches Wörterbuch — siehe `messages/de/index.ts` für die
 * Namespace-Konvention (hier 1:1 gespiegelt: gleiche Reihenfolge, gleiche
 * additive Erweiterungsregel für Folgephasen).
 *
 * `export const en: Messages` (statt `as const`) ist bewusst: die
 * Typannotation gegen `Messages` (abgeleitet aus DE, siehe `types.ts`) lässt
 * TypeScript fehlschlagen, sobald hier ein Namespace/Key fehlt oder vom
 * DE-Shape abweicht — DE bleibt die alleinige Quelle der Wahrheit.
 */
import type { Messages } from '../../types.js'
import { read } from './read.js'
import { review } from './review.js'
import { shell } from './shell.js'
import { sidebar } from './sidebar.js'
import { editor } from './editor.js'
import { search } from './search.js'
import { actions } from './actions.js'
import { errors } from './errors.js'
import { graph } from './graph.js'
import { schema } from './schema.js'
import { templates } from './templates.js'
import { settings } from './settings.js'
import { shortcuts } from './shortcuts.js'

export const en: Messages = { shell, sidebar, editor, read, review, search, actions, errors, graph, schema, templates, settings, shortcuts }
