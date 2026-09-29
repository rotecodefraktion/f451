---
id: github-sign-in
title: GitHub sign-in
description: Enabling GitHub as a sign-in method, independent of or alongside OIDC.
tags: [admin, auth, github]
lang: en
---

# GitHub sign-in

GitHub can be enabled as its own sign-in method, separate from the single
configured OIDC provider (see [[sign-in-options]]). It works whether or
not an OIDC provider is configured at all.

## Enable it

| Variable | Effect |
|---|---|
| `F451_GITHUB_LOGIN` | Set to `1` to turn on "Sign in with GitHub". |
| `F451_GITHUB_OAUTH_CLIENT_ID` | Client ID of a GitHub OAuth app. |
| `F451_GITHUB_OAUTH_CLIENT_SECRET` | Client secret of the same app. |

## Register the OAuth app on GitHub

Under `https://github.com/settings/developers`, create an **OAuth App**
with **Authorization callback URL** set to `https://<host>/auth/`. Use
exactly that path, not a more specific one — it must cover both
`/auth/github/callback` (sign-in) and `/auth/connect/github/callback`
(account linking, used when GitHub is only being connected rather than
signed in with).

## Sign-in also links the account

Signing in with GitHub links the GitHub account in the same step — there
is no separate "connect GitHub" action needed afterwards, unlike signing
in through OIDC and connecting a Git account separately (see
[[sign-in-options]]).

## One person, two users

> [!WARNING]
> f451 has no concept of "the same person across sign-in methods." Someone
> who signs in once via your OIDC provider and once via GitHub becomes
> **two** separate f451 users — with separate sessions and separate sets of
> connected accounts. This is rarely a problem in practice (most people use
> one method consistently), but worth knowing before you enable a second
> method for a team that already uses the first: tell people to pick one
> method and stick with it, rather than discovering the split themselves.
