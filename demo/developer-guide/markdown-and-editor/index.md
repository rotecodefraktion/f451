---
id: markdown-and-editor
title: Markdown and the editor
description: The Markdown pipeline, its constructs, and adding a construct in both packages.
tags: [markdown, editor, architecture]
lang: en
---

# Markdown and the editor

Two packages share the job of understanding a page's content:
`packages/markdown` turns Markdown into sanitized HTML for reading;
`packages/editor` provides the ProseMirror schema behind the WYSIWYG
editor. They have to agree, because a page can be opened in either mode at
any time and must come back unchanged.

## The Markdown pipeline

`packages/markdown/src/`:

- `parse.ts` / `render.ts` / `stringify.ts` — Markdown → AST → HTML, and
  back to Markdown text.
- `frontmatter.ts` / `frontmatter-split.ts` / `frontmatter-metadata.ts` —
  the YAML header every page carries.
- `alerts.ts` — the `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]`
  callouts used throughout this space.
- `image-size.ts`, `youtube.ts` — extra constructs beyond plain CommonMark.
- `slug.ts`, `diff.ts`, `version.ts` — heading slugs, and support for page
  version comparison.

## The `classification` field

The frontmatter field `classification` takes `public`, `internal`,
`confidential` or `strictly-confidential`. The values and their ordering live
in `packages/markdown/src/classification.ts`, shared by the API, the web app
and the editor. A page without the field falls back to the space's
`classification.default` from `_meta/schema.yaml`; the same block's `max`
caps what may be saved. In the editor, a select next to *Archive* sets the
field — "Space default" omits it from the file, and the select offers
nothing above the space maximum. Admin-facing description: in the Admin
Guide, page *Classifications*.

## The editor

`packages/editor/src/`:

- `extensions.ts` — assembles the ProseMirror schema.
- `nodes/alert.ts`, `nodes/image.ts`, `nodes/wiki-link.ts`,
  `nodes/youtube-embed.ts` — one node per construct that needs editor
  support beyond stock ProseMirror.
- `from-markdown.ts` / `to-markdown.ts` — the two directions of
  conversion between editor document and Markdown text.

## Constructs shared by both packages

Wikilinks (`[[page-id]]`, `[[page-id|label]]`) and callouts are the two
constructs every page in this space uses, and both need a matching node in
`packages/editor` (`wiki-link.ts`, `alert.ts`) so that opening a page in
the WYSIWYG editor round-trips it correctly.

## Adding a construct to both packages

A new Markdown construct (say, a new kind of callout, or a new inline
element) needs changes in four places, in this order:

1. **`packages/markdown`** — teach the parser to recognize the syntax and
   the renderer to produce sanitized HTML for it.
2. **`packages/markdown`** — teach `stringify.ts` to produce the same
   syntax back out, so a document that was never touched in the editor is
   byte-for-byte stable.
3. **`packages/editor`** — add a node (or mark) under `nodes/` and wire it
   into `extensions.ts`, then extend `from-markdown.ts` and
   `to-markdown.ts` for the two conversion directions.
4. **Round-trip test** — Markdown → editor document → Markdown must
   reproduce the original. This is the test that actually catches drift
   between the two packages; skipping it is how "reading shows X, editing
   shows Y" bugs get in.

> [!WARNING]
> If the sanitizer (used by `packages/markdown`'s HTML output) doesn't know
> about the new construct's tags or attributes, it will silently strip
> them. This is exactly the failure mode the diagram sanitizer test guards
> against for `.drawio.svg`/`.excalidraw.svg` — the `content` attribute and
> wrapping text elements must survive sanitization, or diagrams lose their
> source and their full labels.

See [[extending]] for the same recipe phrased as a short checklist, and
[[api]] for how the rendered result reaches the reader.
