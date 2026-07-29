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

## Changing a template

Each `template_workspaces/<key>` carries two files that make it self-describing, and both are
checked in CI:

- `norbital.template.json` — key, display metadata, and picker counts. The counts are recomputed
  from the tree by `pnpm templates:check`, so they cannot drift.
- `pnpm-lock.yaml` — the template's own pinned dependency set, including its exact
  `@norbital-ai/pod` version.

Nothing outside the tree pins a template's dependencies, and nothing propagates a pod bump into
one. When **you** choose to move:

```bash
pnpm templates:lock          # resolve and write the lockfile
pnpm templates:lock:check    # fail on drift (runs as part of `pnpm check`)
pnpm templates:lock:verify   # prove it installs offline from a warm store, credentials removed
```
