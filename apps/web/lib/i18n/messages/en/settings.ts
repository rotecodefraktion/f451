/** Englisches Gegenstück zu `messages/de/settings.ts` (gleiche Struktur, siehe
 *  dortiger Kommentar). */
import type { Messages } from '../../types.js'

export const settings: Messages['settings'] = {
  serverUnreachable: 'The server is currently unreachable.',
  retry: 'Try again',
  login: {
    // Brand claim under the wordmark — kept in English in every locale.
    claim: 'Documents without handcuffs.',
    heading: 'Sign in',
    lede: 'Sign in to access the documentation platform.',
    button: 'Sign in',
    buttonWith: 'Sign in with {provider}',
    foot: 'Internal access · f451 documentation platform',
    expired: 'Sign-in was interrupted or has expired. Please sign in again.',
    failed: 'Sign-in failed. Please try again.',
  },
  connections: {
    shellSpace: 'Settings',
    navAriaLabel: 'Settings',
    navHeading: 'Settings',
    navSub: 'Account',
    navItem: 'Connections',
    heading: 'Connections',
    intro:
      'Link your f451 account with Forgejo or GitHub to include spaces from the respective repositories.',
    connected: 'Connected',
    notConnected: 'Not connected',
    connect: 'Connect',
    connectExpired: 'Connecting was interrupted or has expired. Please connect again.',
    connectFailed: 'Connecting failed. Please try again.',
    expired: 'Expired',
    reconnect: 'Reconnect',
    expiredHint: '{label} no longer accepts the connection. Until you reconnect, spaces from {label} are hidden.',
    disconnect: 'Disconnect {label}',
    disconnecting: 'Disconnecting …',
    disconnectError: 'The connection could not be removed. Please try again.',
  },
  appearance: {
    shellSpace: 'Settings',
    navAriaLabel: 'Settings',
    navHeading: 'Settings',
    navSub: 'Account',
    navItem: 'Appearance',
    heading: 'Appearance',
    intro:
      'My settings apply only to you, in every space, and are stored with your account. The theme of the instance or of a single space lives as _meta/theme.yaml in the respective repository; saving writes with your linked account.',
    loadError: 'The theme of this scope could not be loaded.',
    noScopes: 'There is no scope whose theme you may view.',
    scopeLabel: 'Scope',
    scopeInstance: 'Instance — applies to all spaces',
    scopeSpace: 'Space: {name}',
    scopeReadOnly: '{label} (read only)',
    scopeUser: 'My settings',
    readOnlyNote: 'Read only: your linked account may not change the theme of this scope. You see what applies here.',
    summaryErrors_one: '{count} error',
    summaryErrors_other: '{count} errors',
    summaryWarnings_one: '{count} warning',
    summaryWarnings_other: '{count} warnings',
    jumpError: 'Go to first error',
    jumpWarning: 'Go to first warning',
    fileProblem: 'Theme file: {message}',
    groupSetCount_one: '{count} set here',
    groupSetCount_other: '{count} set here',
    resetGroup: 'Reset group',
    modeLight: 'Light',
    modeDark: 'Dark',
    originDefault: 'default',
    originInherited: 'inherited',
    originSet: 'set here',
    originPerMode: '{mode}: {origin}',
    resetRow: 'Reset to default',
    resetRowLabel: 'Reset {token} to default',
    valueLabel: 'Value of {token}',
    valueLabelMode: 'Value of {token} ({mode})',
    colorPickerLabel: 'Colour picker for {token} ({mode})',
    unitLabel: 'Unit of {token}',
    formulaLabel: 'Derivation',
    override: 'override',
    restoreDerivation: 'Restore derivation',
    lockedReason: 'Locked: {reason}',
    fieldInvalid: 'Invalid value: {reason}',
    ruleViolation: 'Rule {rule}: {message}',
    contrastOk: '{ratio}:1 — {what} ✓',
    contrastWarning:
      '{ratio}:1 — {what}: above the configured threshold {threshold}:1, below AA ({aa}:1). Role: {role}.',
    contrastWarningLowered:
      '{ratio}:1 — {what}: above the configured threshold {threshold}:1 (default {default}:1), below AA ({aa}:1). Role: {role}.',
    contrastError: '{ratio}:1 — {what}: {role} needs {threshold}:1 here.',
    contrastWarningPersonal:
      '{ratio}:1 — {what}: below the instance threshold ({threshold}:1). In your settings this is only a note. Role: {role}.',
    contrastRole: {
      readingText: 'reading text',
      shortText: 'short text',
      nonText: 'non-text marks',
      incidental: 'incidental labels',
    },
    save: 'Save',
    saving: 'Saving …',
    saved: 'Saved.',
    saveBlocked: 'Saving is blocked while errors are open.',
    removeTheme: 'Remove theme',
    removing: 'Removing …',
    removed: 'Theme removed.',
    removeConfirm:
      'Delete the theme of this scope? The file _meta/theme.yaml is removed from the repository; the inherited values apply again.',
    serverInvalid: 'The server rejected the theme:',
    serverContrast: 'The server rejected the theme for insufficient contrast:',
    serverContrastItem: '{what} ({mode}): {ratio}:1, required {threshold}:1',
    serverForbidden: 'You may not change the theme of this scope — for the instance or a space your linked account lacks write access; My settings need a browser sign-in.',
    serverConflict: 'The theme file changed in the meantime. Reload the page and try again.',
    serverNotFound: 'There is no theme file to remove.',
    serverError: 'The action failed. Please try again.',
    user: {
      remove: 'Reset my settings',
      removeConfirm:
        'Reset your settings? Your personal theme is deleted; the theme of the instance and of each space applies again.',
      removed: 'Your settings were reset.',
      download: 'Download',
      import: 'Read file',
      importing: 'Reading …',
      imported: 'File read and saved.',
      savedWarnings_one: '{count} contrast value is below the instance thresholds — allowed, just a note.',
      savedWarnings_other: '{count} contrast values are below the instance thresholds — allowed, just a note.',
      takeover: {
        question: 'This browser still holds appearance adjustments from an earlier version. Take them over into My settings?',
        yes: 'Yes, take over',
        no: 'No, discard',
        done: 'The adjustments were taken over into My settings.',
      },
    },
    threshold: {
      heading: 'Check strictness',
      roleBelowAA: '{role} {value}:1 instead of {aa}:1',
      roleAtAA: '{role} {value}:1 (AA {aa}:1)',
      belowAACount_one: '{count} value below AA',
      belowAACount_other: '{count} values below AA',
      lowered: 'At least one threshold is below its default.',
      noteLabel: 'Reason:',
      fieldLabel: '{role} (default {default}:1, AA {aa}:1)',
      noteFieldLabel: 'Reason (at most 500 characters)',
      save: 'Save thresholds',
      saving: 'Saving …',
      saved: 'Thresholds saved.',
      reset: 'Reset to defaults',
      resetting: 'Resetting …',
      resetDone: 'Thresholds reset to the defaults.',
      resetConfirm:
        'Reset the thresholds to the defaults? The file _meta/contrast.yaml is removed from the instance repository.',
      readOnlyInstance:
        'The thresholds apply to the whole instance and live in _meta/contrast.yaml in the instance repository. Anyone with push right there can change them.',
      readOnlySpace:
        'The thresholds apply to the whole instance; they can only be set in the "Instance" scope, not per space.',
      errorOff:
        'The check cannot be switched off. The smallest permitted value is 1.5:1 — below that, two colours can no longer be reliably told apart as text and background.',
      errorRange: '{role}: permitted values are {min}:1 to {max}:1.',
      errorPrecision: '{role}: at most one decimal place.',
      errorNumber: '{role}: please enter a number.',
      errorOrder: 'The text roles stay ordered: reading text ≥ short text ≥ incidental labels.',
      errorNote: 'The reason may be at most 500 characters long.',
      errorInvalid: 'The server rejected the thresholds: {message}',
      errorConnect: 'Link your account first to change the thresholds.',
      errorForbidden: 'Your linked account may not change the instance repository.',
      errorNotConfigured:
        'This installation has no instance repository configured (F451_INSTANCE_CONFIG). The defaults apply and cannot be changed.',
      errorConflict: 'The file _meta/contrast.yaml changed in the meantime. Reload the page and try again.',
      errorGeneric: 'The action failed. Please try again.',
      infoToggle: 'Why contrast thresholds exist',
      reportToggle: 'Report "Values below AA"',
      reportEmpty: 'No value is below AA.',
      colMode: 'Mode',
      colRatio: 'Measured',
      colAA: 'AA reference',
      colThreshold: 'Threshold',
      colRole: 'Role',
      colPair: 'Pair',
      colOrigin: 'Origin',
      originInstance: 'instance',
      originPair: '{fg}: {fgOrigin} · {bg}: {bgOrigin}',
      copyTable: 'Copy as table',
      copied: 'Copied.',
      copyFailed: 'Copying is not possible — the clipboard is blocked.',
    },
    thresholdInfo: {
      why: {
        heading: 'Why contrast thresholds exist',
        body: `Contrast is the ratio of the luminance of two colours. 1:1 means: indistinguishable. 21:1 is black on white. Two success criteria of WCAG 2.2 define what is sufficient:

- **1.4.3 Contrast (Minimum)** — text needs 4.5:1. Large text (from 24 px, bold from 18.7 px) needs 3:1.
- **1.4.11 Non-text Contrast** — controls and meaningful graphics need 3:1: focus ring, state marks, the outline of an input field.

Together they make up level AA, which standards and laws refer to.

f451 recalculates these values for every saved colour value, separately for light and dark, on the fully resolved set. The thresholds on this page only decide **when the check refuses to save**. The AA reference itself cannot be adjusted: whatever misses it is still reported and listed in the report "Values below AA". A lowered threshold turns an error into a warning. It does not make it invisible.`,
      },
      who: {
        heading: 'Who a lower threshold affects',
        body: `Not a standard — readers:

- **People with low vision.** A clouded lens, cataract, diabetic retinopathy, the weeks after eye surgery: the colour is still there, but the edge between text and paper is gone.
- **Older users.** The eye's contrast sensitivity declines noticeably from about fifty. What was comfortable to read at 4.5:1 at twenty-five demands noticeably more thirty years later. Whoever maintains this wiki for ten years ends up reading it with different eyes.
- **Screens in bright rooms.** Sun in the meeting room, a terminal in the workshop, a laptop at reception. Stray light lifts the dark tones and eats the weak contrasts first.
- **Projectors.** A projector in a room that is not darkened often puts only a fraction of the screen's contrast on the wall. A line number at 2:1 is not hard to read there, it is not there at all — even for those sitting in front.
- **Everyone else under poor conditions.** A cheap panel, power-saving mode, an oblique viewing angle, late Friday afternoon.

You yourself are judging the colour under the most favourable circumstances right now: a good screen, good light, your eyes — and you already know what it says.`,
      },
      legal: {
        heading: 'Legal context',
        body: `In Germany the **Barrierefreiheitsstärkungsgesetz (BFSG)**, the German implementation of the European Accessibility Act, has applied since 28 June 2025. It obliges providers of certain consumer products and services to be accessible and relies on the European standard **EN 301 549**, which requires WCAG at level **AA** for web content. For **public bodies**, the **BITV 2.0** applies independently of it, also at level AA.

Whether any of these rules applies to this installation depends on its purpose, not on the software. An internal company wiki behind a login usually does not fall under them. Publicly accessible product documentation, a knowledge base that is part of a service for consumers, or operation within a public authority may well do so. This page cannot make that assessment for you and is not legal advice; when in doubt, that is a question for your legal department or your organisation's accessibility officer. What this page can contribute is the report "Values below AA": a complete, verifiable list of what in this installation is below level AA.`,
      },
      defaults: {
        heading: 'Why the defaults are below AA',
        body: `To be frank: the appearance shipped with f451 does not meet AA everywhere. Four places miss it — in light mode, the line numbers in dark mode as well — and all for the same reason: the coloured tints mix 10 to 12 percent against white paper, and the same colour as text on top does not get much beyond 4:1:

- comments in code blocks: 3.63:1
- line numbers in code blocks: 2.08:1 light, 2.29:1 dark
- the four signal colours as text on their tint: 3.84:1 to 4.33:1
- the four status chips: 3.85:1 to 4.32:1

The defaults — 3.5:1 for short text on a surface, 2.0:1 for line numbers — are set exactly so that these values do not block saving. A check that rejects the shipped appearance would not be strict but unusable. In practice this means: **if you change nothing here, you are working with a check that is below AA for two of four roles.** For reading text (4.5:1) and for non-text marks (3:1) the default matches the standard; a theme that misses there is still rejected.`,
      },
      meetAA: {
        heading: 'If you want to meet AA',
        body: `Raising the thresholds is not enough — then the shipped appearance can no longer be saved. The way leads through the colours. Three levers, the first two on this page:

1. **Choose darker signal and status colours.** This works twice: against the paper and against their own tint.
2. **Mix the tints lighter.** The less colour in the wash, the whiter the ground stays and the better the colour reads on it. The opposite move — mixing the tint stronger — worsens this value, because text and surface come closer to each other.
3. **Strong tint and still AA:** then the surface carries the normal text colour (13:1 and more), and the signal colour is reserved for edge and marks. That is not a theme setting but a change to the building block.

For the code block, two colour values you can set here are enough: a comment tone of \`#746e61\` instead of \`#857e70\` reaches 4.57:1. For the line numbers, AA costs the gradation — a tone that reaches 4.5:1 is as strong as the comment next to it; whoever wants to keep the distance must set the code surface lighter or deliberately leave the line numbers below AA.

Once the colours are changed, set the thresholds to 4.5:1 for reading text, short text and incidental labels, and 3.0:1 for non-text marks. The report is then empty, and every later change that breaks this can no longer be saved.`,
      },
    },
    // Component preview (components/theme-editor/component-preview.tsx). The
    // sample content is interface language: it shows the building blocks, not
    // a real page.
    preview: {
      heading: 'Component preview',
      intro: 'Real building blocks with the draft values. The interface itself keeps the saved theme.',
      modeGroup: 'Preview mode',
      stateRest: 'Rest',
      stateHover: 'Hover',
      stateFocus: 'Focus',
      stateDisabled: 'Disabled',
      stateActive: 'Active',
      sampleHeading: 'Operations and maintenance',
      sampleParagraph:
        'Every page is a Markdown file in a Git repository. Whoever writes creates a draft, opens a review and waits for approval — only then does the change appear in the published version.',
      noticeTitle: 'Note',
      noticeBody: 'This page is being revised. The published version stays valid until approval.',
      chipWorking: 'Draft',
      chipReview: 'In review',
      chipReleased: 'Released',
      chipArchived: 'Archived',
      buttonPrimary: 'Approve',
      buttonQuiet: 'Cancel',
      buttonDanger: 'Delete',
      tableField: 'Field',
      tableValue: 'Value',
      tableRow1Field: 'Owner',
      tableRow1Value: 'Operations',
      tableRow2Field: 'Valid from',
      tableRow2Value: '1 October',
      marginalNote: 'Margin note: approval is a merge in the Git provider.',
      codeComment: '# rebuild and restart',
      treeRest: 'Introduction',
      treeHover: 'Installation',
      treeActive: 'Operations',
      dialogTitle: 'Delete page?',
      dialogBody: 'The page only disappears once the review is approved.',
      dialogCancel: 'Cancel',
      dialogConfirm: 'Delete',
    },
    // Whole-program preview (components/theme-editor/program-preview.tsx,
    // preview-banner.tsx).
    programPreview: {
      start: 'Try it across the whole app',
      refresh: 'Apply current draft',
      end: 'End preview',
      hint: 'Only in this browser and without saving — nobody else sees it.',
      active: 'The preview is active.',
      banner: 'Preview active — this appearance is not saved and only visible in this browser.',
      bannerEnd: 'End',
    },
  },
  report: {
    heading: 'Reference report',
    intro:
      'Unresolvable references and relations in this space. Broken references are data, not errors — this list is the working basis for cleaning up.',
    allResolvable: 'All references in this space are resolvable.',
  },
  apiTokens: {
    heading: 'Personal access tokens',
    introPre:
      'A personal access token lets external tools (e.g. an MCP server) authenticate to the API as you. ',
    introStrong: 'A connected Forgejo or GitHub account is additionally required to write',
    introPost: ' (see Connections above) — a token alone is not enough to commit changes.',
    revealHintPre: 'This token is shown ',
    revealHintStrong: 'only now',
    revealHintPost:
      ' — copy it before you leave this page. Afterwards it can no longer be retrieved for security reasons.',
    copied: 'Copied ✓',
    copyToClipboard: 'Copy to clipboard',
    close: 'Close',
    labelFieldLabel: 'Label',
    labelPlaceholder: 'e.g. MCP on my machine',
    classificationFieldLabel: 'Up to classification',
    classificationHint:
      'Pages classified above this limit show only their title to this token, no content. Open it only as far as the agent really needs.',
    classificationPill: 'up to {value}',
    scopeFieldLabel: 'Permissions',
    scopeReadOnly: 'Read only',
    scopeWriteOption: 'Read and write',
    scopeWritePill: 'Read + write',
    creating: 'Creating …',
    createButton: 'Create token',
    labelRequired: 'Please enter a label.',
    createError: 'The token could not be created. Please try again.',
    revokeError: 'The token could not be revoked. Please try again.',
    revokedStatus: 'Revoked',
    revokeButton: 'Revoke',
    metaLine: 'Created: {createdAt} · Last used: {lastUsedAt} · Expires: {expiresAt}',
    emptyList: 'No tokens created yet.',
    neverValue: 'never',
  },
}
