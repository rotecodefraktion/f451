---
id: search-and-graph
title: Search and the graph
description: Full-text search, the knowledge graph, and the link report.
tags: [guide, search, graph]
lang: en
---

# Search and the graph

## Search

Press **⌘K** (Ctrl+K on Windows/Linux) anywhere, use the search field at
the top of the page tree (in themes with a top bar: the field in the top
bar), or pick **Search** from a space's sidebar, to open the search
dialog. When the tree is closed, the magnifier on the left edge opens it. Start typing to search
full text across the spaces you have access to; results update as you
type.

In spaces with classifications, search respects them: **strictly
confidential** pages never appear in results, and **confidential** pages
appear without a text snippet.

## Graph view

Choose **Graph view** in the sidebar to see a space's pages as a network
instead of a tree. Nodes are pages, coloured by status (Released,
Review, Working, Archived); edges show how pages relate to each other:

| Edge | Meaning |
|---|---|
| Hierarchy | one page contains the other |
| Link | one page references the other (a wikilink or Markdown link) |
| Relation | a named relation such as *depends on* |

Use the filter bar to narrow the view: filter nodes by name, restrict to
one space, or adjust **Depth** — how many hops around your current
selection are shown. **Reset** returns to the default view.

> [!TIP]
> Click a node to see its title, status, links and last update, with an
> **Open** button to jump straight to that page.

Strictly confidential pages are not shown as neighbours of other pages.

## Link report

Choose **Link report** in the sidebar to see every unresolvable
reference and relation in the current space in one list — broken
wikilinks, links to pages that no longer exist, or relations pointing
nowhere. Broken references are treated as data to clean up, not as
errors that block anything; if there is nothing to fix, the report says
so plainly.
