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
[[appearance-and-settings]]).

## Breadcrumbs and the running position

Every page shows its breadcrumb trail above the title, so you always
know which space and which parent page you are under. While you scroll
a long page, a running indicator shows which section you are in.

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
