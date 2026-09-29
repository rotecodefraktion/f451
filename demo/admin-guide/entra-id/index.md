---
id: entra-id
title: Microsoft Entra ID
description: Registering an app in Entra and pointing f451's OIDC configuration at it, step by step.
tags: [admin, auth, entra]
lang: en
---

# Microsoft Entra ID

Entra ID is a standard OpenID Connect provider from f451's point of view —
nothing here is Entra-specific in the code, only in the app registration
steps below.

## 1. Register an application

In the Entra admin center, create a new **app registration**:

- **Single tenant** (unless you specifically need multi-tenant sign-in).
- **Redirect URI**, platform *Web*: `https://<host>/auth/callback` — this
  must match `F451_OIDC_REDIRECT_URL` exactly, including scheme and any
  trailing slash.
- Under **Certificates & secrets**, create a **client secret**.

> [!WARNING]
> Client secrets expire. Note the expiry date somewhere your team actually
> looks (a calendar reminder, not just the Entra portal) — an expired
> secret takes sign-in down for everyone until it is rotated. Rotating it
> means generating a new secret in Entra and updating
> `F451_OIDC_CLIENT_SECRET`, then restarting the `api` service.

## 2. Configure the ID token claims

Recommended: add the optional claim **`email`** to the ID token (**Token
configuration** → **Add optional claim** → ID). f451 reads the user's
email from the `email` claim, falling back to `preferred_username` or
`upn` if either of those looks like an email address (contains `@`).
Without a usable email claim, sign-in still works, but the identity f451
records for that person is less predictable.

## 3. Restrict who may sign in

By default, anyone in the tenant with access to the app can sign in. To
restrict that, open the **enterprise application** for this app
registration and turn on **Assignment required** under **Properties**,
then assign the users or groups who should have access under **Users and
groups**. This is the only access control at the sign-in layer — it does
not grant access to any space; that still comes from the person's Forgejo
or GitHub permissions (see [[sign-in-options]]).

## 4. Configure f451

Set on the `api` service:

| Variable | Value |
|---|---|
| `F451_OIDC_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `F451_OIDC_CLIENT_ID` | the app registration's Application (client) ID |
| `F451_OIDC_CLIENT_SECRET` | the client secret from step 1 |
| `F451_OIDC_REDIRECT_URL` | `https://<host>/auth/callback` |
| `F451_TOKEN_KEY` | 32 random bytes, base64-encoded (`openssl rand -base64 32`) — encrypts stored provider tokens, independent of Entra |
| `F451_OIDC_PROVIDER_NAME` | optional, e.g. `Microsoft Entra` — labels the sign-in button "Sign in with Microsoft Entra"; unset shows a plain "Sign in" |

f451 requests the scopes `openid email profile` — no Entra-side API
permissions need to be granted beyond what a standard app registration
gets by default.

## Forgejo can use Entra too

If your Forgejo instance should show the same people as f451 without a
separate identity system, configure Entra as an **authentication source**
in Forgejo itself (Forgejo admin panel → Authentication Sources → add an
OAuth2/OIDC source pointed at the same Entra app, or a dedicated one).
Users then still take the one extra step of linking their Forgejo account
under **Settings → Connections** in f451 — Entra authenticating both
systems does not by itself connect them. See
[[forgejo-identity-provider]] for the setup that removes even that step.
