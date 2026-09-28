---
id: faq
title: FAQ
description: Short answers to questions that come up often.
tags: [guide, faq]
lang: en
---

# FAQ

**Why can't I just edit the page and save it?**
Because nothing in f451 writes directly to the published version — not
for you, not for anyone else, not for an AI agent. Every change goes
through a draft and a review first. See [[writing-a-page]].

**I signed in, but I don't see a space I expect to see.**
Visibility follows your permissions in the underlying Forgejo or GitHub
repository, not a separate f451 role. Check that you have access to the
repository itself, and that your Forgejo or GitHub account is connected
under **Settings → Connections** — see [[getting-started]].

**I can read a space but can't edit anything in it.**
Your Git account can read the repository but not push to it. Writing
needs write access to the space's repository, because every change is
committed under your own name. Ask whoever manages the repository to
grant it.

**What happens if two of us edit the same page at once?**
f451 never discards a change silently. If someone else is already
editing the same draft, you see who and can choose to proceed anyway; if
a conflicting save happens, you are shown both versions and choose which
to keep. See [[writing-a-page]].

**Is the page history preserved?**
Yes — a page's history is its Git history. Released pages additionally
get a version number and a change note if the space keeps page versions
(see [[templates-and-metadata]]).

**Can I write raw Markdown instead of using the formatted editor?**
Yes. Switch the editor to **Markdown** mode at any time; both modes edit
the same underlying file. See [[editor-reference]].

**What happens to my changes if my connection drops mid-edit?**
The editor keeps your changes locally in the browser until the
connection comes back, so nothing you typed is lost.

**Can an AI agent publish changes on its own?**
An agent writes through the same review workflow as a person — it can
create and edit drafts and request a review, but whether it may also
approve and merge is a separate decision made for that agent. See
[[ai-agents]].
