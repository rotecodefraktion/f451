---
id: web-frontend
title: The web frontend
description: Routing, the proxy, internationalization, and styling with design tokens.
tags: [frontend, architecture]
lang: en
---

# The web frontend

`apps/web` is a Next.js App Router application. Server Components are the
default; client islands are kept as small as the interaction requires
(theme toggle, search dialog, tree expansion are the reference examples).

## The proxy

`apps/web` is not a client of the API in the usual sense — it *proxies*
several path prefixes straight through, configured in `next.config.ts`:

| Prefix | Destination |
|---|---|
| `/api/:path*` | `apps/api` |
| `/auth/:path*` | `apps/api` |
| `/admin/:path*` | `apps/api` |
| `/media/:path*` | `apps/api` |
| `/drawio/:path*` | the draw.io container |
| `/mcp` | the MCP service |

Because these are rewrites, not client-side fetches, requests to them carry
the API's own response headers (its `onSend` security hook, or the media
route's sandboxed CSP) rather than anything `apps/web` adds — `headers()`
in `next.config.ts` only applies to responses Next.js generates itself.

## Internationalization

The interface is bilingual (German/English). UI strings live under
`apps/web/lib/i18n/messages/{de,en}/`. This is separate from page content
language: a page's own `lang` frontmatter field (as in this space, `en`)
describes the content, not the chrome around it.

## Styling and design tokens

`apps/web/app/globals.css` contains no rules of its own — only the list of
imports from `app/styles/*.css`. **That import order is the cascade**; the
numeric prefixes in the filenames are not what determines it.

The token values themselves are generated, not hand-maintained: `sync-tokens`
runs automatically as `predev`/`prebuild` and produces the CSS variables
from `packages/design-tokens`. See [[markdown-and-editor]] for the
package's counterpart on the content side, and [[extending]] for the steps
to add a token.

### Switches, frame and theme stylesheets

Building-block and frame switches reach the page as `data-<name>` attributes
on `<html>` (only values that differ from Editorial); the stylesheets branch on
them. The frame switches change markup: `frameShape(switches, { hasTree })` in
`apps/web/lib/frame-shape.ts` decides from the resolved `switches` whether the
layout renders the top bar, the title row (leading `#` heading or frontmatter
title), the status bar and the page tree's filter and search field. Pages
without a tree always get the top bar. The root layout also links the theme
stylesheets (`stylesheets` from the resolved theme) after
`F451_CUSTOM_STYLESHEET`. Details in [[theme-templates]].

> [!NOTE]
> `packages/design-tokens/src/catalog.ts` separates *values* (`tokens.ts`)
> from *description* (`catalog.ts`: which settings-page group a token
> belongs to, its role in plain language, and whether a user theme is
> allowed to override it). Tests pin the count of tokens per level and
> group, so adding one means updating those counts deliberately, not
> incidentally.
