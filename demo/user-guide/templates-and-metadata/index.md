---
id: templates-and-metadata
title: Templates and metadata
description: Starting points for new pages, structured fields, and page versions.
tags: [guide, templates, metadata]
lang: en
---

# Templates and metadata

## Templates

**Templates** in the sidebar lists the starting points offered when you
create a new page in this space, plus any **global** templates that
apply across all spaces. Space templates can be renamed, have their
content edited, and be deleted here — global templates are read-only,
shown for reference only.

The easiest way to add a template is from a finished draft: use **Save
as template …** in the editor's status bar to turn its current content
into a reusable starting point (see [[writing-a-page]]).

This space ships one template, **Process runbook**. The page
[[example-kernel-update|Example: Kernel update]] was created from it and
then filled in. Templates may use three placeholders that are filled when
the page is created: `{{titel}}` (the new page's title), `{{autor}}` (you)
and `{{datum}}` (today's date).

## Metadata schema

**Metadata schema** in the sidebar defines which structured extra fields
pages in this space carry — for example a process ID, a status, or who
released a page. Each field has a type:

| Type | Meaning |
|---|---|
| Text | free text |
| Pattern (regex) | text that must match a pattern |
| Choice (fixed, single) | one value from a fixed list |
| Date | a date |
| Multi-select / tags | several values, or free tags |
| Person | a person |
| Automatic (from Git) | filled in from Git — last author or last change |

Changes to the schema take effect immediately for every page in the
space. When a schema is in place, the editor shows a **Metadata** panel
on the draft with a field per schema entry, and flags required fields
that are still open.

## Page versions

If a space keeps page versions, every release gets a version number and
the change note entered at approval time. On a released page, the
sidebar shows the current **Version** and a link to **All versions of
this page**, where you can compare any past version with today's content.
