---
id: editor-reference
title: Editor reference
description: Formatting, wikilinks, callouts, images and diagrams in the editor.
tags: [guide, editor, reference]
lang: en
---

# Editor reference

The editor has two modes, switchable at any time: **WYSIWYG** for
formatted editing, and **Markdown** for the raw text. Under the hood,
both edit the same Markdown file — the WYSIWYG editor writes it in a
canonical form, so switching to Markdown and back never surprises you.

## Formatting toolbar

Selecting text shows a toolbar with **Bold (⌘B)**, **Italic (⌘I)**,
**Inline code (⌘E)**, and **Insert link (⌘K)**. Block-level buttons cover
**Bullet list**, **Numbered list**, **Task list**, **Insert table**, and
**Insert image or file**.

## The slash menu

Type **/** on an empty line to open the command menu and insert a block:
headings (**Heading 1–3**), **Bullet list**, **Numbered list**, **Task
list**, **Table**, **Code block**, **Quote**, a **Divider**, an
**Image/File**, a **draw.io diagram**, an **Excalidraw** sketch, a
**Video**, or a callout (**Note**, **Tip**, **Important**, **Warning**,
**Caution**).

## Wikilinks

Type **[[** to search for a page by name and insert a link to it —
either navigate to it directly or insert the link. A wikilink stores the
target page's id, not its title, so renaming a page's title never breaks
links to it:

```
[[getting-started]]
[[getting-started|Getting started]]
```

## Callouts

Callouts are GitHub-style alert blocks, available for **Note**, **Tip**,
**Important**, **Warning**, and **Caution**:

```
> [!NOTE]
> Neutral, additional information.

> [!TIP]
> A helpful suggestion.

> [!IMPORTANT]
> Something the reader must not miss.

> [!WARNING]
> A risk to be aware of before proceeding.
```

## Images

**Insert image or file** (or the slash menu's **Image/File** entry)
uploads a file and places it in the page; it is stored alongside the
page in the repository.

## Diagrams

Two diagram types can be edited right inside the page:

- **draw.io diagram** — a flowchart-style diagram, edited in an embedded
  draw.io canvas.
- **Excalidraw** — a hand-drawn-style sketch.

Both are saved as an SVG next to the page, with the diagram's own source
embedded in the file — so opening **Edit diagram** on an existing
diagram reopens it fully editable, not just as a flattened image.

## Video

The **Video** slash-menu entry asks for a YouTube URL and embeds it as
its own line in the page.
