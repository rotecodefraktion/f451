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
role, for **Light** and **Dark** mode separately. **Reset group**
reverts one group to what it inherits.

The theme toggle in the top bar switches between light and dark mode at
any time without going into settings.

### Scopes

The **Scope** list decides whose theme you are editing:

- **My settings** — always available. Applies only to you, in every
  space, on every device you sign in on, and wins over everything else.
- **Instance** — the look of the whole installation.
- **Space: …** — one entry for each space your linked account may write
  to. A space you can only read is listed as read only.

The instance and space themes are files in their repositories
(`_meta/theme.yaml`), so saving there writes with your linked account
and needs push right; the Admin Guide, page *Theming*, describes the
files. A value you do not set is inherited: space from instance, instance
from the default.

Each row carries an **origin mark**: *default*, *inherited*, *set here*,
or *template · name* when the value comes from the selected template.
**Reset to default** on a row drops your value for that token.

### Templates

The **Template** list above the table starts you from a ready-made set:
the five built-in ones (fokus, klar-warm, system-raster, werkbank,
rotecodefraktion), those of the instance, and in a space those of the
space. Your own values lie on top of the template. **Save as template …**
stores the current values under a name for reuse (not in My settings).

### Contrast feedback

Every colour row shows the contrast of its pair, measured on the
resolved result for light and dark separately. There are three states:

- **✓** — meets the threshold.
- **Warning** — above the configured threshold but below the WCAG AA
  reference. The value is saved, and the note stays on the row.
- **Error** — below the threshold. In the instance and in a space, saving
  is blocked until you fix it. In My settings it is only a warning:
  nobody else is affected.

### Previews

Changes show up in the page immediately, before you save; nothing
leaves your browser until you press **Save**. **Remove theme** deletes the
theme file of the instance or space, and **Reset my settings** deletes
your personal theme.

### Your personal theme

Under **My settings**, **Download** gives you your theme as a YAML file —
the same format as `_meta/theme.yaml`, so a space can check it in
unchanged. **Read file** loads such a file and saves it as your theme.
If this browser still holds adjustments from before personal themes
existed, the page offers once to take them over.

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
