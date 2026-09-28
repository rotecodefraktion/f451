# Contributing to f451

Thanks for your interest in f451. Bug reports, ideas and pull requests are welcome.

## Before you start

- **License and contributor agreement.** f451 is licensed for noncommercial use
  under the [f451 License](LICENSE.md) and offered under separate commercial
  licenses. So that contributions can be part of both, pull requests require a
  short contributor agreement. *The agreement is being finalized; until it is
  published, please open an issue before investing in a larger change.*
- **Language.** Please write code, comments, commit messages and documentation
  in English. Much of the existing code is commented in German — feel free to
  translate the parts you touch.
- **Bigger changes** start with an issue, so we can agree on the approach before
  you write code.

## Ground rules of the architecture

These hold for every change.

- **Git is the source of truth.** Nothing that can be derived from Git may live
  only in the database.
- **Permissions come from the Git provider.** No role system of its own; writes
  happen under the user's own provider token.
- **All writes go through the review workflow** — draft, review, release — for
  people and agents alike.
- **A "not found" stays ambiguous** (does not exist *or* no access), on purpose.

## Development setup

See the quick start in the [README](README.md). Useful commands:

```
pnpm install
pnpm -w typecheck
pnpm --filter <package> test -- <file>   # run the tests of what you changed
```

Please add or adjust tests for the logic you change, and keep pull requests
focused on one concern.

## Reporting security issues

Please do not open a public issue for security problems. Contact the maintainer
directly instead: david@rotecodefraktion.de.
