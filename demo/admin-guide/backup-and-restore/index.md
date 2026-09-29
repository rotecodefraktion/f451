---
id: backup-and-restore
title: Backup and restore
description: What actually needs a backup — Git holds the content, the database only holds a derived index.
tags: [admin, backup, restore]
lang: en
---

# Backup and restore

f451's split between "Git is the source of truth" and "Postgres is only an
index" (see *Principles* in the Developer Guide) turns backup planning
into a short list, not a long one.

## The one thing that matters

> [!IMPORTANT]
> **The Forgejo data volume is the only backup-critical piece of a whole
> f451 deployment.** It holds every space's repository content plus
> Forgejo's own configuration and account database. Losing it without a
> backup means the wiki content is gone — there is nothing else it can be
> rebuilt from.

If a space lives on GitHub instead of the bundled Forgejo, that content is
already backed up by GitHub itself; only Forgejo-hosted spaces are this
deployment's own responsibility.

## The database is a rebuildable cache

The Postgres volume holds the search index, rendered page content, the
knowledge-graph edges, sessions, and encrypted provider tokens. All of the
content-derived pieces are rebuilt automatically:

- `POST /admin/reindex` (bearer-token-protected, see
  [[operations]]) rebuilds the full index for one or all spaces from Git,
  on demand.
- The drift job (see [[spaces-and-git-providers]]) rebuilds it
  automatically within about five minutes of a missed webhook, without any
  manual step.

Losing the database without a backup costs two things, neither of them
content:

- **Sessions** — everyone has to sign in again.
- **Encrypted provider tokens** — everyone has to reconnect their Forgejo
  or GitHub account once (see [[sign-in-options]]).

A database backup is still worth having in practice, purely to skip the
reindex time and avoid the mass reconnect — but it is never the *only*
copy of anything.

## Restore, in outline

1. Stop both stacks (the Git stack and the application stack).
2. Restore the Forgejo data volume from backup.
3. Start the Git stack and wait for it to report healthy.
4. Start the application stack. The database starts empty — apply pending
   migrations before traffic reaches the new containers (the production
   image ships a compiled migration runner for exactly this).
5. Trigger a full reindex of all spaces (`POST /admin/reindex`) rather than
   waiting for the drift job — after a restore there is no reason to wait
   up to five minutes for content to reappear.
6. Verify: the space list responds, a known page is readable, and
   `GET /admin/status` reports no indexing errors for the reindex that just
   ran.

Sessions and account connections are deliberately not part of this
procedure — people sign in again and, if needed, reconnect their Git
account once, exactly as described above.
