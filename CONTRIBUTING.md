# Contributing

Install Node.js 26+ and pnpm 11.15.1, then run:

```sh
pnpm install
pnpm check
```

Package changes require a changeset:

```sh
pnpm changeset
```

Keep package-specific architecture and usage documentation inside the owning package. Put the
entry point in that package's README and deeper material in a package-local `docs/` directory.
Cross-package release contracts belong under [`release/`](./release/README.md). Documentation-only
changes do not need a changeset.

## Changing a template

Templates are **not** authored here. They live in their own repositories —
[`norbital-ai/templates`](https://github.com/norbital-ai/templates) for the public ones, which the
website advertises automatically, and `norbital-ai/templates-private` for the ones it should not.
Each repository carries its own `templates:check`, `templates:lock`, and projection tooling, and is
the only place `refs/heads/templates/*` is published from.
