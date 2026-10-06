---
id: overview
title: Developer Guide
description: How to understand, run and extend f451, the git-native documentation wiki.
tags: [overview, getting-started]
lang: en
---

# f451 Developer Guide

f451 is a wiki whose content lives entirely in Git. Every space is a
repository on Forgejo or GitHub, every page a Markdown file with YAML
frontmatter. PostgreSQL only holds a derived index — search vectors,
rendered HTML, the knowledge-graph edges — and can always be rebuilt from
Git. This demo space is for developers who want to run f451 locally,
understand how the pieces fit together, and add something to it.

> [!NOTE]
> This is a demo space, not the project's own documentation. It exists to
> show what a well-structured f451 space looks like while explaining f451
> itself.

## Where to start

- [[principles]] — the four architectural rules that shape every decision
  in the codebase, and why they exist
- [[architecture]] — the three applications and four packages, and how a
  request travels through them
- [[local-setup]] — get a working stack on your machine
- [[repository-layout]] — what lives where in the monorepo

## Going deeper

- [[api]] — route groups, authentication, the review workflow and its SHA
  contract
- [[web-frontend]] — routing, the proxy, internationalization, styling and
  design tokens
- [[markdown-and-editor]] — the Markdown pipeline and the editor that has
  to stay in sync with it
- [[theme-templates]] — layers and `use`, switches, cross-token rules, adding
  a built-in template, the theme stylesheet

## Contributing

- [[extending]] — recipes for the six most common kinds of change
- [[testing-and-contributing]] — what to run before you open a pull
  request, what CI runs, and the license terms your contribution falls
  under
