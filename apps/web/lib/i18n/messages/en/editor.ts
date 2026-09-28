import type { Messages } from '../../types.js'

/** English mirror of `messages/de/editor.ts` — see there for the namespace/key
 *  convention (identical structure, `Messages['editor']` enforces completeness). */
export const editor: Messages['editor'] = {
  loading: 'Loading draft …',
  retry: 'Try again',

  blockReason: {
    generic: 'Switching to WYSIWYG mode is not currently possible.',
    single: 'WYSIWYG not possible: {message}',
    multiple: 'WYSIWYG not possible: {count} places cannot be displayed — see the findings panel for details.',
  },

  errors: {
    noWriteAccess: 'You do not have write access to this page.',
    serverUnreachable: 'The server is currently unreachable.',
    loadFailed: 'The draft could not be loaded.',
    discardFailed: 'The draft could not be discarded — please try again.',
    deletePageFailed: 'The page could not be deleted — please try again.',
    reviewNoDraft: 'There is currently no draft for this page — a review cannot be requested.',
    reviewFailed: 'The review could not be requested — please try again.',
    resetFailed: 'The draft could not be reset to the last released state — please try again.',
    contentUnreadable: 'The editor content could not be read.',
  },

  confirm: {
    discardResetRecovery: 'Really discard the recovered draft content? It cannot be restored afterwards.',
    discardDraft: 'Really discard the draft? All unsaved changes will be lost irrevocably.',
    deletePage: 'Really delete this page? The content will be irrevocably removed from the repository.',
    resetToLastRelease:
      'Really reset the draft to the last released state? All unpublished changes will be lost irrevocably.',
  },

  titleField: {
    placeholder: 'Page title',
    ariaLabel: 'Page title',
    archived: 'Archived',
    archive: 'Archive',
  },

  metadataPanel: {
    noSelection: '— no selection —',
    removeChip: 'Remove "{chip}"',
    addChipPlaceholder: 'Add …',
    invalidPattern: 'Invalid format — expected: {pattern}',
    autoHint: 'Determined automatically (not yet in this phase — M3b).',
    heading: 'Metadata',
    missingBadge_one: '{count} required field open',
    missingBadge_other: '{count} required fields open',
    readOnlyHint: 'In raw-text mode the frontmatter is edited directly as text — read-only here.',
    requiredHint: 'Required field — not yet filled in.',
  },

  statusBar: {
    savedSecondsAgo: '{count}s ago',
    savedMinutesAgo: '{count} min ago',
    breadcrumbAriaLabel: 'Breadcrumbs',
    backToReadingTitle: 'Return to reading view',
    draftBadge: 'Draft',
    saving: 'Saving …',
    offline: 'Changes saved locally — server unreachable',
    error: 'Changes not saved',
    savedAt: 'Last saved {relative}',
    notSavedYet: 'Not saved yet',
    saveTitle: 'Save (⌘S)',
    save: 'Save',
    requestReview: 'Request review',
    discard: 'Discard',
    resetToLastRelease: 'Reset to last release',
    backToReading: 'Back to reading view',
    saveAsTemplate: 'Save as template …',
    exportMarkdown: 'Export as Markdown',
    discardDraft: 'Discard draft',
    deletePage: 'Delete page',
  },

  toolbar: {
    ariaLabel: 'Text formatting',
    paragraph: 'Paragraph',
    heading: 'Heading {level}',
    boldTitle: 'Bold (⌘B)',
    italicTitle: 'Italic (⌘I)',
    codeTitle: 'Inline code (⌘E)',
    linkTitle: 'Insert link (⌘K)',
    bulletListTitle: 'Bullet list',
    orderedListTitle: 'Numbered list',
    taskListTitle: 'Task list',
    tableTitle: 'Insert table',
    imageTitle: 'Insert image or file',
    wordCount: '{count} words · {minutes} min',
    linkPopover: {
      ariaLabel: 'Insert link',
      heading: 'Insert link',
      urlPlaceholder: 'https://…',
      urlAriaLabel: 'Link URL',
      selectTextHint: 'Select text in the document first.',
      submit: 'Apply',
      remove: 'Remove',
      cancel: 'Cancel',
    },
  },

  slashMenu: {
    ariaLabel: 'Command menu',
    heading: 'Insert block',
    empty: 'No matches',
    filterHint: 'Type to filter',
    insertHint: 'Insert',
  },

  slashItems: {
    heading1: { label: 'Heading 1', hint: 'Title level' },
    heading2: { label: 'Heading 2', hint: 'Section title' },
    heading3: { label: 'Heading 3', hint: 'Subsection' },
    bulletList: { label: 'Bullet list', hint: 'Unordered list' },
    orderedList: { label: 'Numbered list', hint: 'Ordered list' },
    taskList: { label: 'Task list', hint: 'Checklist with checkboxes' },
    table: { label: 'Table', hint: 'Grid with header row' },
    codeBlock: { label: 'Code block', hint: 'Syntax highlighting' },
    blockquote: { label: 'Quote', hint: 'Indented block quote' },
    alertNote: { label: 'Note', hint: 'Callout — info, warning' },
    alertTip: { label: 'Tip', hint: 'Callout — info, warning' },
    alertImportant: { label: 'Important', hint: 'Callout — info, warning' },
    alertWarning: { label: 'Warning', hint: 'Callout — info, warning' },
    alertCaution: { label: 'Caution', hint: 'Callout — info, warning' },
    horizontalRule: { label: 'Divider', hint: 'Horizontal rule' },
    image: { label: 'Image/File', hint: 'Upload and insert' },
    drawio: { label: 'draw.io diagram', hint: 'Embedded flowchart' },
    excalidraw: { label: 'Excalidraw', hint: 'Hand-drawn sketch' },
    video: { label: 'Video', hint: 'Embed via URL' },
    videoPrompt: 'YouTube URL (will be embedded as its own line):',
    videoInvalid: 'That is not a valid YouTube URL (expected: youtube.com/watch?v=… or youtu.be/…).',
  },

  modeSwitch: {
    ariaLabel: 'Editor mode',
    wysiwyg: 'WYSIWYG',
    markdown: 'Markdown',
    confirmAriaLabel: 'Normalize formatting?',
    confirmHeading: 'Formatting will be normalized on switch',
    confirmDescription:
      'The WYSIWYG editor stores Markdown in a canonical form — the following spots will change when you switch:',
    cancel: 'Cancel',
    confirm: 'Normalize and switch',
  },

  wysiwyg: {
    loading: 'Loading editor …',
    uploadFailed: 'The upload failed — please try again.',
    conversionErrorTitle: 'Unexpected error',
    conversionErrorBody:
      'The editor content could not be converted to Markdown — please reload the page before continuing to write, otherwise changes will be lost.',
    uploading: 'Uploading …',
    uploadErrors_one: 'Upload failed',
    uploadErrors_other: '{count} uploads failed',
    skippedFilesTitle: 'Note',
    cellOverflowTitle: 'Not possible',
    cellOverflowBody: 'A table cell can only contain a single paragraph.',
    drawioNamePrompt: 'Name of the diagram:',
    excalidrawNamePrompt: 'Name of the sketch:',
    invalidDiagramName: 'The name must contain at least one letter or digit.',
  },

  lockBanner: {
    messageSuffix: 'is currently editing the draft.',
    override: 'Edit anyway',
  },

  findingsPanel: {
    openTitle: 'Open validation',
    ok: 'No findings',
    count_one: '{count} finding',
    count_other: '{count} findings',
    ariaLabel: 'Validation findings',
    empty: 'No findings — the document is fully canonical.',
    line: 'Line {line}',
  },

  conflictDialog: {
    ariaLabel: 'Save conflict',
    heading: 'Someone else has saved this draft in the meantime',
    description: 'Choose which version to keep — both versions can be compared below.',
    localHeading: 'Your version',
    serverHeading: 'Version on the server',
    keepServer: 'Keep server version',
    keepMine: 'Keep my version',
  },

  offlineRecoveryDialog: {
    ariaLabel: 'Locally saved changes',
    heading: 'Locally saved changes found',
    description:
      'A draft state from {date} is still stored on this device — it could not be saved (e.g. due to a connection loss). Should it be applied to the editor?',
    foreignBranchHint:
      "Note: this buffer is from an older draft of this page, not from the currently loaded state — check whether the content still fits after applying it.",
    discard: 'Discard',
    apply: 'Apply',
  },

  resetRecoveryDialog: {
    ariaLabel: 'Reset failed',
    heading: 'Reset failed — your previous draft content was preserved',
    description:
      'The draft could not be reset to the last released state. Your most recently edited content was NOT lost — it is preserved below and can be applied to the editor.',
    contentHeading: 'Preserved draft content',
    discard: 'Discard',
    apply: 'Apply content to the editor',
  },

  saveTemplateDialog: {
    heading: 'Save as template',
    savedPrefix: 'Template saved at',
    nameLabel: 'Name',
    descriptionLabel: 'Description',
    genericError: 'The template could not be saved — please try again.',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
  },

  drawioDialog: {
    iframeTitle: 'Edit draw.io diagram',
    close: 'Close',
    loadFailed: 'The diagram could not be loaded.',
    saveFailed: 'Saving failed — please try again.',
    nameExists: 'A file with this name already exists.',
    loading: 'Loading diagram …',
  },

  excalidrawDialog: {
    loadFailed: 'The sketch could not be loaded.',
    nameExists: 'A file with this name already exists.',
    saveFailed: 'Saving failed — please try again.',
    loading: 'Loading sketch …',
    cancel: 'Cancel',
    saving: 'Saving …',
    saveAndClose: 'Save and close',
  },

  wikiLinkPopup: {
    headingPrefix: 'Link page ·',
    searching: 'Searching …',
    empty: 'No matches',
    draftBadge: 'Draft',
    ariaLabel: 'Page autocomplete',
    navigate: 'Navigate',
    insert: 'Insert',
    cancel: 'Cancel',
  },

  diagramNode: {
    editButton: 'Edit diagram',
  },

  uploadQueue: {
    skipped_one: '{count} file skipped — unsupported file type.',
    skipped_other: '{count} files skipped — unsupported file type.',
  },

  clientApi: {
    uploadFailedDefault: 'Upload failed.',
    invalidTemplateName: 'Invalid name.',
    noTemplatePermission: 'No permission to create templates in this space.',
    templateNameExists: 'A template with this name already exists.',
  },
}
