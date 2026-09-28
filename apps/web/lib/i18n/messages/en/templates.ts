/** Englisches Gegenstück zu `messages/de/templates.ts` (gleiche Struktur,
 *  siehe dortiger Kommentar). */
import type { Messages } from '../../types.js'

export const templates: Messages['templates'] = {
  pageTitle: 'Templates',
  intro1: 'Templates for new pages in this space (',
  intro2:
    '). Space templates can be renamed, edited and deleted here — changes go straight to ',
  intro3: '. Global templates are read-only and listed for reference only.',
  empty: 'No templates have been added to this space yet.',
  global: 'global',
  readOnly: 'read-only',
  rename: 'Rename',
  editContent: 'Edit content',
  delete: 'Delete',
  deleting: 'Deleting …',
  deleteConfirm: 'Really delete template "{name}"? This cannot be undone.',
  name: 'Name',
  description: 'Description',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving …',
  contentLabel: 'Content (Markdown)',
  contentLoading: 'Loading content …',
  close: 'Close',
  errors: {
    renameFailed: 'The template could not be renamed',
    contentLoadFailed: 'The content could not be loaded',
    contentSaveFailed: 'The content could not be saved',
    deleteFailed: 'The template could not be deleted',
    retry: '{action} — please try again.',
    reloadFailed: 'The template list could not be reloaded — please reload the page.',
  },
}
