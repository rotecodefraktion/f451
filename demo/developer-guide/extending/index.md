---
id: extending
title: Extending f451
description: Recipes for the most common kinds of change — an API route, a UI string, a design token, a Markdown construct, an MCP tool, a Git provider.
tags: [howto, architecture]
lang: en
---

# Extending f451

Six recipes for changes that come up repeatedly. Each one names where the
change starts and what it touches on the way.

## Add an API route

1. Add a `register*Routes` function under `apps/api/src/routes/`, following
   the existing pattern: it takes `{ db, spaces, providerRegistry, access,
   canWrite, getUserProvider }` as needed, not the raw request context.
2. Register it in `apps/api/src/app.ts`, in the block that only runs when
   `db && opts.spaces && opts.providerRegistry` are present — read-only
   routes need `access`; anything that writes needs `canWrite` and
   `getUserProvider` as well, since writes commit under the calling user's
   own provider token (see [[principles]]).
3. Decide read or write semantics up front: read routes are filtered by
   `access.canRead`, write routes additionally need a linked provider
   account and go through the draft/SHA-contract machinery described in
   [[api]] — don't bypass it for a "simple" new route.
4. Add a Swagger/JSON schema for the response; the OpenAPI spec at
   `/api/openapi.json` is generated from it.

## Add a UI string

Add the key to both `apps/web/lib/i18n/messages/en/` and the matching
`de/` file in the same change — f451's interface is bilingual, and a
string that exists in only one language is a regression, not a partial
feature. See [[web-frontend]].

## Add a design token

1. Add the value to `packages/design-tokens/src/tokens.ts`.
2. Describe it in `catalog.ts`: its level (`theme` / `derived` /
   `structure` / `switch`), its settings-page group, its role in plain
   language, and whether a user theme is allowed to set it (`settable`,
   with a `lockReason` if not).
3. Update the token-count tests for the affected level and group — they
   are pinned deliberately, so the update should be a conscious edit, not
   a number you copy without reading why it existed. See [[web-frontend]].

## Add a Markdown construct

Full recipe in [[markdown-and-editor]]. In short: parse and render it in
`packages/markdown`, make `stringify.ts` reproduce the same syntax, add the
matching node to `packages/editor` and its two conversion directions, then
add a round-trip test that proves Markdown → editor → Markdown is
lossless.

## Add an MCP tool

MCP tools in `apps/mcp/src/tools/` are thin wrappers: each one calls the
HTTP API (`apps/mcp/src/client.ts`) with the token passed through from the
calling agent, and does not hold state or a secret of its own. The
existing set is a useful map of scope:

- **Read** (`tools/read.ts`): `search_wiki`, `list_spaces`, `get_tree`,
  `read_page`, `get_page_source`, `get_graph`, `list_broken_links`.
- **Write** (`tools/write.ts`): `create_page`, `edit_page`,
  `update_page_draft`, `discard_page_draft`, `request_review`,
  `release_page`, `request_changes` — the review workflow from [[api]],
  exposed one step at a time.
- **Attachments** (`tools/attachments.ts`): `save_diagram`, `attach_file`.

A new tool follows the same shape: register it with `server.registerTool`,
give it a clear `title` and input schema, and implement it by calling an
existing API route — never by reaching around the API into the database or
Git directly. If no suitable API route exists yet, add one first (see
above); the MCP service is not the place to grow API-shaped logic of its
own.

## Add a Git provider

`packages/git-provider/src/types.ts` defines one interface,
`GitProvider` — file reads (`readFile`, `readFileBinary`, `listTree`),
writes (`writeFile`, `writeFileBinary`, `deleteFile`, the batched
`commitFiles`), branches, and the pull request lifecycle
(`createPullRequest`, `requestReviewers`, `submitPullRequestReview`,
`mergePullRequest`). `forgejo.ts` and `github.ts` are the two existing
implementations.

A third provider means a new file implementing every method of
`GitProvider`, throwing the same three error types
(`NotFoundError`/`ConflictError`/`ProviderError`) the existing
implementations use — callers in `apps/api` branch on those errors, not on
provider-specific ones. `commitFiles` is worth reading closely before
implementing it: it exists because writing many files one call at a time
was measured to take minutes on a large move, and its batching behavior
(splitting large change sets across multiple underlying commits, returning
the last commit's SHA, treating an empty list as a no-op) is part of the
contract, not an implementation detail.

> [!TIP]
> None of these recipes need a browser or a full test run to make progress
> on. See [[testing-and-contributing]] for what to actually check before
> opening a pull request.
