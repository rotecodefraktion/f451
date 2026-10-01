---
id: writing-a-page
title: Writing a page
description: Draft, editor, review and approval — and what happens when two people edit at once.
tags: [guide, writing, review]
lang: en
---

# Writing a page

Writing in f451 always follows the same path: **draft → editor → review
→ approval**. There is no way to change the published version directly
— not for you, not for anyone else, not for an AI agent (see
[[ai-agents]]). That is by design: every change is reviewable before it
goes live, the same way code review works.

> [!IMPORTANT]
> Writing needs a linked Git account. If you have not connected one yet,
> see [[getting-started]].

## 1. Start a draft

Click **New page** to create a page, or **Edit** on an existing one to
open its draft. For a new page you choose a **Title**, a **Parent page**
(the current page or the space root), and optionally a **Template** to
start from (see [[templates-and-metadata]]).

Creating a draft creates a branch behind the scenes — you do not need to
know anything about Git to work with it.

## 2. Write

The editor autosaves as you go; the status bar shows **Saving …** and
then **Last saved …**, or **Not saved yet** for a brand-new draft. You
can also save explicitly with **Save (⌘S)**. If the connection drops,
your changes are kept locally in the browser until it comes back —
nothing is silently lost.

From the same status bar you can **Discard** the draft, **Reset to last
release**, go **Back to reading view**, **Save as template …**, or
**Export as Markdown**. **Delete page** removes the page from the
repository entirely.

See [[editor-reference]] for formatting, wikilinks, images and diagrams.

### Choose a classification

In a space with classifications, the editor offers a **Classification**
select next to **Archive**. Pick the class that fits the content; the list
stops at the strictest class the space allows. **Space default (…)** leaves the
choice to the space. See [[reading-and-navigating]] for how classes show
up for readers.

## 3. Request review

When the draft is ready, click **Request review**. This opens a review
(a pull request) against the space's main branch. From here on, the
change is visible to reviewers as a side-by-side comparison of what
changed, and the page shows an **In review** status to other readers.

## 4. Approval

A reviewer reads the change, optionally leaves a comment, and either
clicks **Approve & merge** or **Request changes**. Approving asks for a
version bump — **Fix**, **Addition**, or **Major rework** — and a short
**Change note** describing what changed; for a page's first release,
the version is set automatically. Once merged, the page is released and
the reader is redirected to the reading view.

In a space with versioning, the approval dialog also has a **Freeze as
release** checkbox. Ticked, it stores an unchangeable copy of this version
with its attachments, which stays readable even after the page has been
edited many times. Frozen versions are marked in the version list (see
[[reading-and-navigating]]).

## Edit conflicts

f451 never overwrites a change silently. Two situations can come up:

> [!WARNING]
> **Someone else is editing the same draft.** A banner tells you who,
> with an **Edit anyway** option if you decide to proceed regardless.

> [!WARNING]
> **Someone else saved a conflicting change while you were editing.** A
> dialog shows **your version** and the **version on the server**
> side by side; you choose **Keep server version** or **Keep my
> version** — nothing is discarded without you seeing both first.

A related case can happen during review: if the space's main branch has
changed since the review was opened, the review shows **main has
changed** and offers **Update draft**, either taking main as the new
base or keeping your version rebased onto it — the release button stays
disabled until you resolve it.
