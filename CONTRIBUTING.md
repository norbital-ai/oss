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

Template workspaces are authored only under `template_workspaces/<slug>/src`. Generated `.norbital`
output is ignored except for committed migrations.
