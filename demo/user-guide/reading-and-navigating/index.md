---
id: reading-and-navigating
title: Reading and navigating
description: The page tree, breadcrumbs, the outline, the info panel, and the phone layout.
tags: [guide, reading]
lang: en
---

# Reading and navigating

## The page tree

The left panel lists the **Pages** in the current space, nested the same
way their folders are nested in the repository. Click the panel's edge
(or press **[**) to collapse or expand it — useful when you want the
reading area at full width.

Below the page list sit the space's tools, grouped as **Find**
(**Search**, **Graph view**, **Link report** — see [[search-and-graph]])
and **Configure** (**Templates**, **Metadata schema**, **Connections**,
**Appearance** — see [[templates-and-metadata]] and
[[appearance]]).

The field at the top of the list, **Filter pages**, narrows the tree as you
type: only pages whose title contains the text stay visible, together with
the folders above them. Press **Escape** to clear the field.

Without a top bar (the default Editorial look), brand, space switcher and
search sit at the top of the page tree; language, light/dark and account at
its foot. When the tree is closed, a magnifier on the left edge opens the
search; **⌘K** always does. The templates Klar & Warm, Werkbank and
Rotecodefraktion have a top bar, and so do pages without a tree, such as the
graph.

## Breadcrumbs and the running position

Every page shows its breadcrumb trail above the title, so you always
know which space and which parent page you are under. While you scroll
a long page, a running indicator shows which section you are in.

## Title row

With the frame switch **page head: title**, the page starts with a title
row. If the page's body begins with a `# heading`, that heading becomes the
title and leaves the body; otherwise the title from the frontmatter is
used.

## Pane toggles and status bar

With **pane controls: top bar**, the buttons that open and close the page
tree and the info panel sit in the top bar instead of on the panels' edges.
This needs the top bar to be on.

With **status bar: bottom**, a bar at the foot of the page shows the status
chip, **Updated** and **Section x of y**. It is hidden on a phone. (In the
editor, the bottom bar shows the save status instead; see
[[writing-a-page]].)

## The info panel

The right panel (press **]** to toggle it) carries everything about the
*current* page:

- **Table of contents** — jump between headings
- **Tags**
- **Metadata** — the space's custom fields, if it has a metadata schema (see [[templates-and-metadata]])
- **Status** — Draft, In review, Released, or Archived
- **Space** and **Updated**
- **Related pages** — pages connected to this one by hierarchy, links, or relations

## Page status

A page you are reading can be in one of four states, shown as a badge:

| Status | Meaning |
|---|---|
| Released | The published version — what everyone with read access sees |
| In review | A draft exists and a review (pull request) is open for it |
| Draft | A draft exists but no review has been requested yet |
| Archived | Removed from the live tree, kept read-only for history |

If a draft exists for a page you are reading, a notice at the top offers
a **View draft →** link so you can preview the unreleased content.

## Classification

In spaces where your administrator has turned classifications on, a page
carries one of four classes: **Public**, **Internal**, **Confidential** or
**Strictly confidential**. The class shows as a chip next to the status in
the page header. A strictly confidential page also shows a banner,
*Strictly confidential — do not distribute.*

A class does not change who can open the page; it tells you how to handle
the content. It also keeps the page out of places where it would travel
further, see [[search-and-graph]] and [[ai-agents]].

## Versions and releases

In a space with versioning, the header line shows **Version x.y.z**, a link
to the list of all versions of the page. If a version was frozen as a
release (see [[writing-a-page]]), the line also shows **Release x.y.z**,
which opens the newest frozen release.

A draft has no version; the release gives it one. A new page's first release
is **0.1.0**, a first version, or **1.0.0** if you consider the page finished.
A page that existed before the space turned versioning on shows **Version
0.1.0**; its first release can make it 0.1.1, 0.2.0 or 1.0.0, and the version
list shows its original state as *Initial version*.

The version list marks frozen versions with **Release** and an **Open frozen
version** link. A frozen version opens read-only:

- a banner names the release and its date
- it has its own classification chip, tags and metadata, as they were when
  the version was frozen
- **Current version (x.y.z) →** leads back to the living page (**To the page →**
  if the release is the current version)

> [!WARNING]
> If someone changed the frozen copy directly in the repository afterwards,
> the release shows *This version was changed in the repository after it was
> frozen.* Treat its content with care.

## On a phone

On a narrow screen the page tree and info panel move into a bottom bar
with **Pages**, **Outline** and **Info** sections, plus a **Next**
button that jumps straight to the next page in the tree — handy for
reading a space end to end without hunting through the tree each time.
