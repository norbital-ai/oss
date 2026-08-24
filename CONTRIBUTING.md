# Contributing

Install Node.js 26+ and pnpm 11 (the workspace pins `pnpm@11.22.0`), then run:

```sh
pnpm install
pnpm check
```

`pnpm check` builds the package graph, runs lint, tests, script tests, and
`publication:check` — the archive inspection every package change must pass. All seven public
package manifests stay pinned to the one workspace release version (`0.0.1` during beta); package
changes merge only after `pnpm publication:check` and the release workflow republishes the
fixed-version set together.

Keep package-specific architecture and usage documentation inside the owning package. Put the
entry point in that package's README and deeper material in a package-local `docs/` directory.
Cross-package release contracts belong under [`release/`](./release/README.md).

## Changing a template

Templates are **not** authored here. They live in their own repositories —
[`norbital-ai/templates`](https://github.com/norbital-ai/templates) for the public ones, which the
website advertises automatically, and `norbital-ai/templates-private` for the ones it should not.
Each repository carries its own `templates:check`, `templates:lock`, and projection tooling, and is
the only place `refs/heads/templates/*` is published from.
