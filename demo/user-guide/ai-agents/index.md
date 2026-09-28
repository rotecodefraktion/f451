---
id: ai-agents
title: AI agents
description: Connecting an AI agent to a space through MCP, and what it can and cannot do.
tags: [guide, ai-agents, mcp]
lang: en
---

# AI agents

f451 has an MCP service that lets an AI agent read, search and write
wiki content — an agent works with the same spaces you do, through the
same rules.

## Connecting an agent

An agent needs two things, both tied to your own account:

1. A **personal access token** with **Read and write** permissions,
   created under **Settings → Personal access tokens**. This is what
   authenticates the agent's requests as you. The token is shown only
   once, right after creation — copy it before leaving the page.
2. Your own **connected Forgejo or GitHub account** (**Settings →
   Connections**). Without it, every write attempt the agent makes
   fails with a permission error, the same error a human would get —
   a token alone is never enough to commit a change.

Give the agent your MCP server address and the token, and it can start
working the same way it would through any other MCP client.

## What an agent can do

| Purpose | What it covers |
|---|---|
| Orient and read | list spaces, browse the page tree, search, read pages, inspect the raw source, read the graph, list broken links |
| Write, through review | create or edit a page, update a draft, discard it, request a review, request changes |
| Attachments | generate a diagram from a description (draw.io), attach a file |

## The same review path as people

An agent's writes go through exactly the path described in
[[writing-a-page]]: it edits a draft, then requests a review. It does
not publish directly — nothing does. Whether an agent is also allowed to
approve and merge its own review is a decision you make for that agent
(most setups leave that step to a human); ask whoever configured the
agent if you are unsure what it is permitted to do on your spaces.

## Diagrams

An agent builds diagrams the same way described in
[[editor-reference]]: it describes the diagram (steps, connections, or —
for a swimlane diagram — steps with their lane), and the service turns
that into an editable draw.io diagram. It does not hand over a
ready-made image or a Mermaid diagram, so the result stays fully
editable afterwards, exactly like one you built yourself in the editor.

## If something goes wrong

Error messages an agent reports back are the same ones a human sees. A
permission error naming your account usually means the linked Forgejo
or GitHub account step above is missing. A "not found" result can mean
either that the page genuinely does not exist, or that neither you nor
the agent has access to it — f451 deliberately does not distinguish the
two, for people or for agents.
