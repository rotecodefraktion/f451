---
id: my-settings
title: My settings
description: Your personal theme — scope, origin marks, previews, download and upload, reset.
tags: [guide, settings, theming]
lang: en
---

# My settings

**Appearance** in settings (`/einstellungen/erscheinungsbild`) shows every
design value of the interface, grouped by role, for **Light** and **Dark**
mode separately. **Reset group** reverts one group to what it inherits.

## Scope

The **Scope** list decides whose theme you are editing. **My settings**
is always available: it applies only to you, in every space, on every
device you sign in on, and wins over everything else. The other entries
are described in [[instance-and-space]].

## Origin marks

Each row carries an **origin mark**: *default*, *inherited*, *set here*,
or *template · name* when the value comes from the selected template.
**Reset to default** on a row drops your value for that token. Colour
rows also show a contrast note; see [[contrast]].

## Previews

Changes show up in the page immediately, before you save; nothing leaves
your browser until you press **Save**.

## Download and upload

**Download** gives you your theme as a YAML file — the same format as
`_meta/theme.yaml`, so a space can check it in unchanged. **Read file**
loads such a file and saves it as your theme. If this browser still holds
adjustments from before personal themes existed, the page offers once to
take them over.

You can adopt a built-in template into your own settings with **Adopt
template** and download the result as a complete YAML file.

## Reset

**Reset my settings** deletes your personal theme; you then see the
space's or the instance's look again.
