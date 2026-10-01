---
id: releases
title: Releases
description: Freeze a released version of a page as a permanent, read-only copy next to it in Git.
tags: [admin, versioning]
lang: en
---

# Releases

In a space with versioning, every approval gives the page a new version
number, and earlier versions can be compared with today. A **release** goes
one step further: the version is **frozen** as a copy that stays readable as a
whole page, even after the page has been edited many times, the Git history
was rewritten or the database was lost.

## Freeze a release

In the review, tick **Freeze as release** before approving. Agents can do the
same with the `archive` parameter of `release_page`, but only when asked to.
Releases need versioning in the space (`versioning: true` in
`_meta/schema.yaml`), because the version number names the copy.

## Where the copy lives

```
<page folder>/
  index.md                  ← the living page
  _media/
  _releases/
    1.2.0/
      page.md               ← the frozen version
      _media/               ← copies of the attachments it references
```

The copy is written in the same commit as the new version number, so there is
never a version without its copy. Only attachments the page actually
references are copied; a frozen diagram stays as it was when the version was
released.

## Read a release

- The page header links to the newest release.
- **All versions** marks frozen versions as *Release* with a link to open them.
- A release opens read-only, with a banner naming the version and a link back
  to the current version.

## Can a release be changed?

Not through f451: no route writes into `_releases/`. Someone with write
access to the repository can still change the files directly in Git. f451
notices this at the next reindex and shows *This version was changed in the
repository after it was frozen* on the release.

Deleting a page deletes its releases with it. To keep the releases of a page
that is no longer current, archive the page instead of deleting it.
