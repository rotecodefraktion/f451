import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/read.ts`. */
export const read: Messages['read'] = {
  breadcrumbAriaLabel: 'Breadcrumbs',
  // Running head (2026 appearance, stage 3): breadcrumb + reading position,
  // see `components/reading-position.tsx`.
  runhead: {
    position: 'Section {current} of {total}',
  },
  status: {
    review: 'In review',
    draft: 'Draft',
    archived: 'Archived',
    released: 'Released',
  },
  edit: 'Edit',
  subbar: {
    updated: 'Updated',
    space: 'Space',
    // Page versioning stage 1 (Task 8): version + "changed since" hint when
    // the page was committed directly (bypassing the release flow) after
    // the last release — see `components/page-view.tsx`.
    version: 'Version {version}',
    changedSince: 'changed since {version}',
    changedSinceHint: 'This page was edited directly after the last release.',
    versionsLink: 'All versions of this page',
  },
  versions: {
    heading: 'Versions',
    empty: 'This page has no released version yet.',
    unversioned: 'This space does not keep versions.',
    current: 'current',
    by: 'by {author}',
    compare: 'Compare with today',
    diffHeading: 'Changes since version {from}',
    diffTo: 'up to version {to}',
    diffToday: 'up to today',
    noChanges: 'The content has not changed since version {from}.',
    gone: 'The state of version {version} is no longer available — the Git history was rewritten or the page has moved since.',
    unknownVersion: 'Version {version} is not known for this page.',
    loadError: 'The versions could not be loaded — the server is unreachable.',
    backToPage: 'Back to page',
    railHeading: 'All versions',
    railAriaLabel: 'Versions',
  },
  loadError: 'The page could not be loaded — the server is unreachable.',
  retry: 'Try again',
  notices: {
    draftInReview: 'A draft of this page exists — it is in review.',
    draftPending: 'A draft of this page exists — not yet released.',
    viewDraft: 'View draft →',
    lockedBySuffix: 'is currently editing the draft.',
    parseErrorTitle: 'This page contains processing errors',
    frontmatterTitle: 'Notes about the page header (frontmatter)',
    frontmatterFallback: 'The content is shown, but could not be fully processed.',
    brokenLinks_one: 'One link on this page cannot be resolved',
    brokenLinks_other: '{count} links on this page cannot be resolved',
  },
  rail: {
    ariaLabel: 'Page information',
    toc: 'Table of contents',
    tags: 'Tags',
    metadata: 'Metadata',
    status: 'Status',
    space: 'Space',
    updated: 'Updated',
    relatedPages: 'Related pages',
  },
  relations: {
    depends_on: 'Depends on',
    supersedes: 'Supersedes',
    superseded_by: 'Superseded by',
    related: 'Related',
    parent: 'Parent',
    child: 'Child',
    references: 'References',
  },
  youtubeTitle: 'YouTube video',
  // Labels for server-rendered page HTML (issue #9): see de/read.ts for why
  // these follow the UI language instead of the page language.
  alerts: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  },
  youtube: {
    play: 'Play video (YouTube)',
  },
  lightbox: {
    ariaLabel: 'Image in full screen',
    close: 'Close',
    original: 'Original size',
    fit: 'Fit to screen',
    hint: 'Pinch with two fingers to zoom, swipe to pan.',
  },
}
