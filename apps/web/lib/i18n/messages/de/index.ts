/**
 * DE ist die Referenz-Sprache (Quelle der Wahrheit für `Messages`, siehe
 * `lib/i18n/types.ts`): jeder Namespace lebt in einer eigenen Datei
 * (`shell.ts`, `sidebar.ts`, …) und wird hier zu einem Objekt zusammengefügt.
 *
 * KONVENTION für Folgephasen — pro neuem Bereich (z. B. `editor`, `read`,
 * `review`, `graph`, `search`, `dialogs`, `templates`, `schema`, `settings`,
 * `errors`) NUR:
 *   1. eine neue Namespace-Datei anlegen (`messages/de/<bereich>.ts`, gefüllt)
 *   2. hier eine Import-Zeile ergänzen
 *   3. hier einen Objekt-Key im Rückgabewert ergänzen
 * — jeweils additiv, ohne bestehende Zeilen zu verändern (konfliktarm bei
 * parallelen Phasen). Das englische Gegenstück (`messages/en/index.ts`) folgt
 * exakt demselben Muster; `Messages` (aus `types.ts`) erzwingt per Typfehler,
 * dass EN keinen Namespace/Key vergisst.
 */
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

export const de = { shell, sidebar, editor, read, review, search, actions, errors, graph, schema, templates, settings, shortcuts } as const
