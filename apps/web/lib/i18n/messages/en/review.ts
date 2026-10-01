import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/review.ts`. */
export const review: Messages['review'] = {
  loadError: 'The review could not be loaded — the server is unreachable.',
  retry: 'Try again',
  status: {
    review: 'In review',
  },
  openPr: 'Open pull request',
  author: 'Author',
  rail: {
    ariaLabel: 'Changes in the pull request',
    changesHeading: 'Changes',
    prHeading: 'Pull request',
    fields: {
      status: 'Status',
      source: 'Source',
      target: 'Target',
      author: 'Author',
      number: 'Number',
    },
  },
  diff: {
    viewToggleAriaLabel: 'Switch view',
    visualTab: 'Visual',
    markdownTab: 'Markdown',
    legend: {
      added: 'Addition',
      changed: 'Changed',
      removed: 'Removed',
    },
    removedSummary: 'Removed',
    tag: {
      added: 'Added',
      changed: 'Changed',
    },
  },
  changesList: {
    newBlock: 'New content block',
    removedBlock: 'Removed content block',
    changedBlock: 'Changed content block',
  },
  actions: {
    heading: 'Complete review',
    commentPlaceholder: 'Add a review comment … (optional when approving, required when requesting changes)',
    commentRequiredHint: 'A comment is required for "Request changes".',
    merge: 'Approve & merge',
    requestChanges: 'Request changes',
    requestChangesDone: 'Changes requested',
    mergeDisabledTitle: 'The draft must be updated before it can be released.',
  },
  version: {
    legend: 'Bump version',
    patch: 'Fix',
    minor: 'Addition',
    major: 'Major rework',
    // First release (Finding 5, final review): without a current version,
    // `nextVersion(undefined, …)` returns the same number (1.0.0) for all
    // three bump sizes — three identical radio buttons looked like a bug.
    // A plain hint replaces the selection instead, see `review-view.tsx`.
    firstRelease: 'This is the first release of this page — the version will be {version}.',
    archive: 'Freeze as release — a copy of this version with its attachments stays readable permanently',
    noteLabel: 'Change note',
    notePlaceholder: 'Briefly describe what changed',
  },
  notices: {
    conflictTitle: 'main has changed.',
    conflictBody: 'The draft must be updated before it can be released.',
    rebase: 'Update draft',
    updatedTitle: 'Draft updated',
    updateFailedTitle: 'The draft could not be updated',
    preservedContentHint:
      'Your most recently edited draft content was NOT lost — it is backed up below. Copy it and try again once a draft exists.',
    close: 'Close',
    mergedApproveFailedTitle: 'Merged — automatic approval failed',
    backToReading: 'Go to reading view →',
    mergedSuccess: 'Approved and merged — you will be redirected to the reading view …',
  },
  errors: {
    conflictOnMerge: 'main has changed since this review started — please update the draft first.',
    reviewNoChanges: 'This review contains no changes — there is nothing to approve. Discard the draft to close it.',
    mergeFailedRetry: 'Approving failed — please try again.',
    mergeFailedOffline: 'Approving failed — the server is currently unreachable.',
    requestChangesFailed: 'Requesting changes failed — please try again.',
    updateFailedRetry: 'The draft could not be updated — please try again.',
  },
  updateDialog: {
    ariaLabel: 'Update draft',
    heading: 'Update draft',
    description: 'main has changed since this review started. Choose how the draft should be updated.',
    takeMain: {
      heading: 'Take main',
      body: 'Completely discards your changes and restarts the draft from the current main state.',
      button: 'Take main',
    },
    keepMine: {
      heading: 'Keep my version',
      body: 'Keeps your text, but rebases it onto the current main state. Not-yet-merged uploaded images are lost.',
      button: 'Keep my version',
    },
  },
}
