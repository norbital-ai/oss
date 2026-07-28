# Norbital OSS

This pnpm and Turborepo monorepo owns all `@norbital-ai/*` packages and the public reference tenant
workspaces.

- Package implementation and package-specific documentation stay together under `packages/<name>/`.
- Template source is authored under `template_workspaces/<slug>/src`; generated `.norbital` output
  is not hand-edited.
- Run `pnpm lint`, `pnpm test`, and `pnpm build` after changes.
- Add a changeset for publishable package changes.
