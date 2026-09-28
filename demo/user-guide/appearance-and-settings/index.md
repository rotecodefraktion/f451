---
id: appearance-and-settings
title: Appearance and settings
description: Theme, language, and the accounts you connect to f451.
tags: [guide, settings]
lang: en
---

# Appearance and settings

Everything in this page lives under the account menu's **Settings**.

## Connections

**Connections** lists your Forgejo and GitHub accounts. Each shows
**Connected** or **Not connected**, with a **Connect** button; an
expired connection shows **Reconnect** instead, and until you reconnect
its spaces stay hidden. **Disconnect** removes a connection.

This is also where **write access comes from** — see [[getting-started]]
for why a connected account is required before you can edit anything.

## Appearance

**Appearance** shows every design value of the interface, grouped by
role, for **Light** and **Dark** mode separately. Changes take effect
immediately, but only in this browser — other people and other devices
do not see them. **Reset group** reverts one group, **Reset everything**
reverts all of it.

The theme toggle in the top bar switches between light and dark mode at
any time without going into settings.

## Language

The language switcher in the top bar lets you choose between **German**
and **English** for the interface. Page content keeps whatever language
it was written in (each page's frontmatter records its own `lang`);
switching the interface language does not translate page content.

## Personal access tokens

**Personal access tokens**, further down in settings, is where you
create tokens for external tools — most notably an AI agent connecting
over MCP. See [[ai-agents]] for what such a token is for and what it
lets an agent do.
