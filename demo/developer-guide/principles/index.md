---
id: principles
title: Principles
description: The four rules that shape f451's design, and why they exist.
tags: [architecture, principles]
lang: en
---

# Principles

Four rules recur throughout the codebase. They are not style preferences —
each one closes off a class of bugs or design mistakes that the project has
already made once.

## Git is the source of truth, Postgres is only an index

Every space is a Git repository; every page is a Markdown file with
frontmatter. Postgres holds the rendered content, the search vector, the
knowledge-graph edges, sessions and encrypted provider tokens — nothing
that can be derived from Git is allowed to live *only* in the database.

> [!IMPORTANT]
> Losing `pg-data` is recoverable: `POST /admin/reindex` or the drift job
> rebuilds the index from Git. Losing `forgejo-data` is not — that is the
> one thing backups exist for. If you find yourself adding a column that
> holds information not derivable from the Git content, stop and ask
> whether it belongs in Git instead.

## Permissions come from the Git provider

f451 has no role system of its own. Whether someone can see a space or
write to it is decided by their permissions on the underlying repository.
Writers always write with **their own** provider token — the API never
commits under a service account. Without a linked provider account, every
write attempt fails with 403; that is a precondition, not a bug.

This also shapes how "not found" behaves: a `404` deliberately means
*"doesn't exist, or you don't have access"* — never distinguish the two.
Doing so would let an unauthorized caller learn that a page exists, which
is exactly the kind of existence oracle this design avoids.

## Writing always goes through the review workflow

There is no route that writes directly to the published version — not for
people, not for agents. The path is always: create a draft (a branch) →
write → open a review (a pull request) → approve (merge) → reindex.

Draft routes carry a SHA contract: whoever writes names the `baseSha` of
the version they started from. If the content has changed underneath them,
they get a `409` back with the current state instead of a silent
overwrite. See [[api]] for the routes that implement this.

## Diagrams carry their own source

`.drawio.svg` and `.excalidraw.svg` files under `<page folder>/_media/` are
plain SVGs that also carry the diagram's source XML in a `content`
attribute. One file is both the picture people see and the thing the
diagram editor reopens. The SVG sanitizer keeps that attribute and the
wrapping text elements deliberately — stripping either would make the
diagram unreadable or unopenable.

> [!TIP]
> These four rules are the first thing to check when a design choice looks
> surprising: it is very likely a direct consequence of one of them, not an
> arbitrary decision.
