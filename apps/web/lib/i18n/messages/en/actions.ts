import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/actions.ts`. */
export const actions: Messages['actions'] = {
  cancel: 'Cancel',
  existingPageLink: 'Go to existing page →',
  newPage: {
    triggerLabel: 'New page',
    dialogAriaLabel: 'New page',
    heading: 'New page',
    titleLabel: 'Title',
    parentLegend: 'Parent page',
    parentCurrent: 'Current page',
    parentRoot: 'Space root',
    parentFixed: 'Space root — no page open to derive from.',
    templateLegend: 'Template',
    templateEmpty: 'Empty',
    templateGlobalBadge: 'global',
    templatesLoading: 'Loading templates …',
    submit: 'Create',
    genericError: 'The page could not be created — please try again.',
  },
  rename: {
    triggerTitle: 'Rename',
    triggerAriaLabel: 'Rename "{title}"',
    dialogAriaLabel: 'Rename page',
    heading: 'Rename "{title}"',
    fieldLabel: 'New title',
    submit: 'Rename',
  },
  move: {
    triggerTitle: 'Move',
    triggerAriaLabel: 'Move "{title}"',
    dialogAriaLabel: 'Move page',
    heading: 'Move "{title}"',
    fieldLabel: 'New parent page',
    rootOption: 'Space root',
    submit: 'Move',
  },
  moveRename: {
    genericError: 'Move/rename failed — please try again.',
    unchanged: 'The page is already in this location — nothing was changed.',
    submitting: 'Moving — this can take a moment when there are many subpages.',
  },
  unarchive: {
    button: 'Restore from archive',
    genericError: 'Restoring from the archive failed — please try again.',
  },
  tree: {
    archivedBadge: 'Archived',
    archivedTitle: '{title} — archived (read-only)',
    filter: {
      placeholder: 'Filter pages',
    },
  },
  reorder: {
    genericError: 'Reordering failed — please try again.',
  },
}
