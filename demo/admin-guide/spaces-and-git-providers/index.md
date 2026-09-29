---
id: spaces-and-git-providers
title: Spaces and Git providers
description: Configuring which repositories are wiki spaces, service tokens, webhooks, and how the index stays current.
tags: [admin, spaces, git]
lang: en
---

# Spaces and Git providers

A space is one repository on Forgejo or GitHub, declared to f451 as one
entry in `F451_SPACES` — a JSON array on the `api` service:

```json
[
  {
    "id": "handbook",
    "name": "Handbook",
    "provider": "forgejo",
    "owner": "docs",
    "repo": "handbook",
    "defaultLang": "en"
  }
]
```

Without `F451_SPACES` set, the API starts in a minimal mode: only
`/healthz` and `/readyz` respond, and no space is visible at all.

## Service tokens are for indexing, not for user access

Each provider used by at least one space needs a service-account token:

| Variable | Used for |
|---|---|
| `F451_FORGEJO_URL` | Base URL of the Forgejo instance (no `/api/v1`). Also the one source for the service-account registry, the write-permission check, and — if Forgejo doubles as identity provider — the OIDC issuer. |
| `F451_FORGEJO_TOKEN` | Service-account token Forgejo spaces are indexed with. |
| `F451_GITHUB_TOKEN` | Service-account token GitHub spaces are indexed with. |

> [!NOTE]
> These tokens exist purely so the indexer can *read* repository content to
> build the search index and page tree. They are never used to write on a
> user's behalf — every write is committed with the writer's own linked
> provider token (see [[sign-in-options]]). A misconfigured or missing
> service token breaks indexing for that provider's spaces, not writing.

## Webhooks keep the index current

Configure a webhook in each space's repository pointing at f451, and set a
matching secret on the `api` service so f451 can verify it:

| Variable | Effect |
|---|---|
| `F451_WEBHOOK_SECRET_FORGEJO` | HMAC secret for Forgejo webhooks. Must match the secret entered when creating the webhook in the Forgejo repository. |
| `F451_WEBHOOK_SECRET_GITHUB` | Same, for GitHub webhooks. |

Without the matching secret set, every webhook signature check fails
(`401`) and pushes never trigger an incremental reindex — see
[[operations]] for how that shows up and how it self-heals.

## The drift job is the safety net

A background job compares each space's current `main` HEAD against the
last fully indexed commit every 5 minutes, and triggers a full reindex on
a mismatch. This means a webhook that never arrives — a firewall rule, a
wrong secret, a Git provider outage — is not a lasting problem: the index
catches up on its own within 5 minutes, no manual action required. See
[[operations]] for how to observe this happening.

## Templates across spaces

`F451_GLOBAL_TEMPLATES` optionally names one more repository
(`{"provider","owner","repo"}`, same shape as an `F451_SPACES` entry) that
supplies templates available to every space, in addition to a space's own
`_templates/*.md`.
