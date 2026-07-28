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

Template workspaces are authored only under `template_workspaces/<slug>/src`. Generated `.norbital`
output is ignored except for committed migrations.
