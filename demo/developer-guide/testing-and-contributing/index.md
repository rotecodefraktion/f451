---
id: testing-and-contributing
title: Testing and contributing
description: Targeted tests over full runs, what CI checks, and the license your contribution falls under.
tags: [testing, contributing, license]
lang: en
---

# Testing and contributing

## Run targeted checks, not the full suite

For a given change, run type-checking across the workspace and only the
test files of the modules you touched:

```
pnpm -w typecheck
pnpm --filter @f451/web test -- lib/urls.test.ts
```

Not the full `pnpm -w test` for every change — its output is the actual
cost driver on a change of any size, and it re-proves things your change
didn't touch. Full-suite runs and browser/E2E verification are what CI and
review are for, not every local iteration.

## What CI checks

`.github/workflows/ci.yml` runs on every push to `main`/`dev` and on every
pull request:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Two further jobs exist but only run on manual dispatch, because they are
expensive: a GitHub live-contract test against `packages/git-provider`
(needs real credentials), and a Playwright end-to-end read-flow test
(needs a browser install and container startup).

## Before opening a pull request

- Type-check, and run the tests for the files you changed (above).
- Keep the change to what the task asked for; unrelated cleanup belongs in
  its own pull request.
- New code, comments, commit messages and documentation are written in
  English. f451's UI itself stays bilingual — see [[web-frontend]] — but
  written material *about* the project is English going forward.

## License

f451 is source-available, not Open Source in the OSI sense: noncommercial
use, modification and redistribution are free, with attribution to rote
code fraktion and a link to the project, both in the code and in the
running application's interface. Commercial use requires a separate
license on request. Full terms, including named exclusions, are in
`LICENSE.md` at the repository root — read it before assuming a use case
is covered.

> [!NOTE]
> Contribution guidelines beyond this page live in `CONTRIBUTING.md` at the
> repository root.
