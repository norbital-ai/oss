# Contributing

Install Node.js 26+ and pnpm 11 (the workspace pins `pnpm@11.22.0`), then run:

```sh
pnpm install
pnpm check
```

`pnpm check` builds the package graph, runs lint, tests, script tests, and
`publication:check` — the archive inspection every package change must pass, which also installs
the packed archives in a clean graph and imports every export. All eight public package manifests
stay pinned to the one workspace release version; package changes merge only after
`pnpm publication:check` and the release workflow republishes the fixed-version set together.

`pnpm --dir packages/bolt bench:resources` runs the live resource benchmark (`packages/bolt/bench`)
and judges it against `bench/budget.json`: database statements, live bytes and frames exactly, CPU
and p95 in reference units. The `Resources` workflow runs it on a runner of its own. A change that
moves a count moves the budget in the same commit, with the reason; `tests/resources.integration.test.ts`
asserts the counts without timing.

Bolt lint uses the installed native compiler for its TypeScript test corpus. `pnpm types:compat`
checks that same corpus with TypeScript 6. `pnpm check` and
`pnpm check:packages:ci` include this gate, cached through the existing Turbo dependency graph.
Svelte checks and declaration builds continue using TypeScript 6.

Keep package-specific architecture and usage documentation inside the owning package. Put the
entry point in that package's README and deeper material in a package-local `docs/` directory.
Cross-package release contracts belong under [`release/`](./release/README.md).

## Changing a template

Templates are **not** authored here. They live in their own repositories —
[`norbital-ai/templates`](https://github.com/norbital-ai/templates) for the public ones, which the
website advertises automatically, and `norbital-ai/templates-private` for the ones it should not.
Each repository carries its own `templates:check` and `templates:lock`, and its CI is the only place
template releases are built and uploaded from.
