---
id: sign-in-options
title: Sign-in options
description: The identity providers f451 supports, how they compare, and why there are no local accounts.
tags: [admin, auth]
lang: en
---

# Sign-in options

f451 never stores a password. Every sign-in goes through an external
identity provider, and every permission check after that goes through the
Git provider behind the space a person is looking at — see *Principles* in the Developer Guide
in the developer guide for why that split exists. This page is about the
first half: who is allowed to sign in at all.

## Why no local accounts

A local account system would need its own password reset, its own
lockout policy, its own audit trail — none of which f451 could do better
than the identity provider your organisation already runs and already
trusts for offboarding. Instead, f451 delegates entirely: one configured
OIDC issuer, optionally GitHub as a second method, and permissions that
come from the linked Forgejo or GitHub account rather than from anything
f451 tracks itself.

## Comparison

| Provider | Use case | What f451 needs | Notes |
|---|---|---|---|
| **Microsoft Entra ID** | Production, organisation-managed identities | `F451_OIDC_ISSUER`/`_CLIENT_ID`/`_CLIENT_SECRET`/`_REDIRECT_URL`, `F451_TOKEN_KEY` | See [[entra-id]]. Sign-in only — reading/writing still needs a separately connected Forgejo or GitHub account, unless Forgejo itself also authenticates against Entra (see next row). |
| **Forgejo (bundled)** | Local development, or production where Forgejo is the single identity source | Same OIDC variables, pointed at Forgejo's built-in OIDC provider | See [[forgejo-identity-provider]]. Can also make the *first* sign-in link the Forgejo account automatically. |
| **Other OIDC provider** (Keycloak, Authentik, Zitadel, Okta, Google, …) | Any organisation already standardised on a different IdP | Same OIDC variables, pointed at that provider's issuer | Configuration only — f451 speaks standard OpenID Connect, nothing provider-specific. |
| **GitHub** | Teams whose spaces already live on GitHub | `F451_GITHUB_LOGIN=1`, `F451_GITHUB_OAUTH_CLIENT_ID`/`_SECRET` | See [[github-sign-in]]. Works with or without an OIDC provider configured; signing in with GitHub also links the GitHub account in the same step. |

Only one OIDC issuer can be configured at a time — f451 does not offer a
picker between several OIDC providers. GitHub sign-in is independent of
that and can be enabled alongside it, or on its own.

## What sign-in does and does not unlock

Signing in only authenticates *who someone is*. It does not, by itself,
grant access to any space's content:

> [!IMPORTANT]
> **Reading and writing follow the linked Git account, not the sign-in
> method.** A person who signs in but never connects a Forgejo or GitHub
> account sees no spaces at all — not because f451 hides them, but because
> there is no permission to check against.

See [[spaces-and-git-providers]] for how a space is tied to a repository,
and the User Guide's *Getting started* page for what connecting an account
looks like for the person doing it.

## One person, several identities

Because each sign-in method produces its own identity, a person who signs
in once through Entra and once through GitHub becomes **two** separate
f451 users, each with its own set of connected Git accounts — see
[[github-sign-in]] for the practical consequence of that.
