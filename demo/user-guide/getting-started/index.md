---
id: getting-started
title: Getting started
description: Sign in, connect your Git account, and understand what each step unlocks.
tags: [guide, getting-started]
lang: en
---

# Getting started

## Sign in

f451 does not have its own accounts. You sign in through your
organisation's identity provider (for example Microsoft Entra, or
whichever OpenID Connect provider your instance uses). There is no
separate f451 password to remember.

## Connect your Git account

Signing in gets you into f451, but it does not, by itself, connect you
to any space's content. For that you link your Forgejo or GitHub
account under **Settings → Connections**:

> Link your f451 account with Forgejo or GitHub to include spaces from
> the respective repositories.

Open the account menu and choose **Settings**, then **Connections**, and
select **Connect** for the provider your spaces live on. If a
connection has expired, the same page shows **Reconnect** — until you
reconnect, spaces from that provider stay hidden.

> [!IMPORTANT]
> **Without a linked account you see no spaces.** f451 has no role system
> of its own: what you may read and write is exactly what your Forgejo or
> GitHub account may do in the space's repository. Reading needs read
> access to the repository; writing needs write access, and every change
> is committed under your own name — f451 never writes on your behalf
> using a shared or service account.

## Where to go next

- [[reading-and-navigating]] to find your way around a space
- [[writing-a-page]] once your account is connected and you are ready to write
- [[appearance-and-settings]] for theme, language and managing connections later
