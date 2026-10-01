---
id: classifications
title: Classifications
description: Mark pages as public, internal, confidential or strictly confidential, and limit what AI agents can read.
tags: [admin, security]
lang: en
---

# Classifications

A page can carry one of four classes:

| Class | What it changes |
|---|---|
| Public | Chip on the page |
| Internal | Chip on the page |
| Confidential | Chip; search shows the hit without a text snippet |
| Strictly confidential | Chip and a "do not distribute" banner; search never shows it; it is not listed as a related page of other pages |

A class **does not grant or deny access**. Who can read a page is still
decided by the repository of its space (see [[spaces-and-git-providers]]). A
class tells readers how to handle the content and keeps it out of places where
it would travel further: search snippets, related-page lists, AI agents.

## Turn classes on for a space

Add a `classification:` block to the space's `_meta/schema.yaml`:

```yaml
classification:
  default: internal      # class of pages that set none
  max: confidential      # strictest class allowed in this space
```

Both keys are optional (`default: internal`, `max: strictly-confidential`);
an empty block turns classes on with these values. Without the block the space
behaves exactly as before.

`max` is the important one. Give a space everyone in the company can read
`max: internal`, and a confidential page can never be saved or released there:
the editor offers nothing above the maximum and the API refuses it. Pages that
already exceed the maximum show a warning until someone lowers their class.

## Set the class of a page

In the editor, the select next to *Archive* sets the class. "Space default"
leaves the field out of the file, so a later change of `default` applies to
the page too. The value lives in the page's frontmatter:

```yaml
classification: confidential
```

## AI agents

Every API token has an upper limit, chosen when it is created (*Settings →
Connections → API tokens*). The default is **Internal**. Above its limit a
token sees only the title and class of a page; the content, the source and
every write action are refused. An agent then tells its user that the token is
too narrow, and the person decides.

Browser sessions have no limit: a person who can read the repository can read
every page in it.
