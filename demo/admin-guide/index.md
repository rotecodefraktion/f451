---
id: admin-home
title: Admin Guide
description: Deploying and running f451 — sign-in setup, spaces, configuration, backup, and day-to-day operations.
tags: [admin, guide]
lang: en
---

# Admin Guide

f451 is git-native: every space is a repository on Forgejo or GitHub, every
page a Markdown file in it. Postgres holds only a derived index (rendered
content, search vectors, graph edges) plus sessions and encrypted provider
tokens — nothing that lives exclusively in the database is irreplaceable.
That single fact shapes most of the operational decisions in this guide,
especially backup and restore.

This guide is for the people who deploy and run an instance, not for people
writing pages in it — for that, see the User Guide space.

## How this guide is organised

- [[sign-in-options]] — the identity providers f451 supports, and why there
  are no local accounts
- [[entra-id]] — step-by-step setup with Microsoft Entra ID
- [[forgejo-identity-provider]] — using the bundled Forgejo as the identity
  source, and linking accounts in one step
- [[github-sign-in]] — enabling GitHub as a sign-in method
- [[spaces-and-git-providers]] — configuring spaces, service tokens,
  webhooks, and the drift job
- [[configuration-reference]] — every environment variable, grouped by
  concern
- [[production-setup]] — what a production server looks like: TLS, sign-in,
  released images, backups, updates, monitoring
- [[backup-and-restore]] — what actually needs a backup, and what a reindex
  rebuilds for you
- [[operations]] — health checks, troubleshooting, and running two
  instances on one host

> [!NOTE]
> **f451 has no role system of its own.** Who may sign in is decided by
> your identity provider; what a signed-in person can see and write is
> decided entirely by their linked Git account's permissions on the
> repository behind each space. See [[sign-in-options]].

If you are setting up sign-in for the first time, start with
[[sign-in-options]] to decide which provider fits your setup, then follow
the matching page.
