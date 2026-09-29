---
id: getting-started
title: Getting started
description: Sign in, connect your Git account, and understand what each step unlocks.
tags: [guide, getting-started]
lang: en
---

# Getting started

## Sign in

f451 does not have its own accounts. The sign-in page shows one button
per sign-in method your instance offers — for example **Sign in with
Microsoft Entra**, **Sign in with Forgejo** or **Sign in with GitHub**.
There is no separate f451 password to remember.

## Connect your Git account

What you can see depends on your Git account, so f451 needs it linked.
If you signed in with Forgejo or GitHub, that account is usually linked
right away and you can skip this step. Otherwise — for example after
signing in with Microsoft Entra — link your Forgejo or GitHub account
under **Settings → Connections**:

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
