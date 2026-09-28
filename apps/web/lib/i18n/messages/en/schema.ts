/** Englisches Gegenstück zu `messages/de/schema.ts` (gleiche Struktur, siehe
 *  dortiger Kommentar). */
import type { Messages } from '../../types.js'

export const schema: Messages['schema'] = {
  pageTitle: 'Metadata schema',
  pageIntro:
    'Defines the structured extra fields (e.g. Process ID, Status, Released by) that pages in this space show in the capture form. Changes are saved directly and take effect immediately for all pages.',
  typeLabels: {
    text: 'Text',
    pattern: 'Pattern (regex)',
    enum: 'Choice (fixed, single)',
    date: 'Date',
    multi: 'Multi-select / tags',
    user: 'Person',
    auto: 'Automatic (from Git)',
  },
  sourceLabels: {
    last_author: 'Last author',
    last_updated: 'Last change',
  },
  fieldNumber: 'Field {n}',
  moveUp: 'Move up',
  moveDown: 'Move down',
  remove: 'Remove',
  key: 'Key',
  displayName: 'Display name',
  type: 'Type',
  required: 'Required',
  pattern: 'Regex pattern',
  patternHint: 'Hint text for invalid format',
  optionsEnum: 'Options (one per line)',
  optionsMulti: 'Options (one per line — empty = free tag entry)',
  fillOnReleaseUser: 'On release, prefill with the releasing user (if still empty)',
  fillOnReleaseDate: 'On release, prefill with the release date (if still empty)',
  source: 'Source',
  sourcePlaceholder: '— please choose —',
  empty:
    'This space does not have a metadata schema yet. Add a field to define structured extra information (e.g. Process ID, Status, Released by) for pages in this space.',
  addField: '+ Add field',
  saving: 'Saving …',
  save: 'Save',
  saved: 'Schema saved.',
  invalid: 'The metadata schema is invalid — see details below.',
  saveFailed: 'The schema could not be saved — please try again.',
  notSavableYet: 'Not savable yet:',
}
