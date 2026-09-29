---
id: forgejo-identity-provider
title: Forgejo as the identity provider
description: Using the bundled Forgejo's built-in OIDC provider for sign-in, and linking accounts in one step.
tags: [admin, auth, forgejo]
lang: en
---

# Forgejo as the identity provider

Forgejo ships a built-in OpenID Connect provider
(`/.well-known/openid-configuration`). f451 can point its one configured
OIDC issuer at it instead of an external identity provider — useful for
local development, and viable for production if Forgejo is already your
single source of identity (see [[entra-id]] for federating Forgejo's own
accounts to Entra, so user management still lives in one place).

## Create the OAuth2 application in Forgejo

In Forgejo, as an administrator (or as the account that should own the
app): **Settings → Applications → OAuth2 Applications**, create a new
application with redirect URI `https://<host>/auth/callback`. Forgejo
gives you a **Client ID** and **Client Secret** — set these as
`F451_OIDC_CLIENT_ID` / `F451_OIDC_CLIENT_SECRET`, and set
`F451_OIDC_ISSUER` to the Forgejo instance's base URL.

## The one-app trick: sign-in and account linking together

Normally, signing in and connecting a Forgejo account (for reading and
writing spaces, see [[sign-in-options]]) are two separate steps: sign in
via whatever OIDC provider is configured, then separately connect Forgejo
under **Settings → Connections**.

> [!TIP]
> If f451's OIDC client (`F451_OIDC_CLIENT_ID`/`_SECRET`) and the Forgejo
> account-linking connection (`F451_FORGEJO_OAUTH_CLIENT_ID`/`_SECRET`)
> point at the **same** Forgejo OAuth2 application, the first sign-in
> already links the Forgejo account — there is no second step. This is
> exactly the setup `scripts/dev-local-setup.sh` creates for local
> development.

Using two different Forgejo OAuth2 applications for the two purposes also
works — it just means a person signs in, then still has to connect Forgejo
separately before they see any space.

## User management lives in Forgejo

Once Forgejo is the identity source, account lifecycle — creating
accounts, password resets, two-factor authentication, or federating a
further upstream source like LDAP — happens entirely in Forgejo's own
admin panel. f451 does not duplicate any of it; it only consumes the
resulting OIDC identity.

## Local-only settings

Running Forgejo as the identity provider over plain HTTP (typical for
local development) needs two additional variables on the `api` service:

| Variable | Effect |
|---|---|
| `F451_INSECURE_COOKIES=1` | Drops the `secure` flag on session cookies so they survive over HTTP. |
| `F451_OIDC_ALLOW_INSECURE=1` | Allows an `http://` issuer during OIDC discovery. |

> [!WARNING]
> Both are for local HTTP development only. Never set either in
> production — a production Entra issuer only ever speaks HTTPS anyway, so
> there is nothing to gain and a cookie without `secure` to lose.
