# Norbital OSS

This pnpm and Turborepo monorepo owns all `@norbital-ai/*` packages and the public reference tenant
workspaces.

- Package implementation and package-specific documentation stay together under `packages/<name>/`.
- Template source is authored under `template_workspaces/<slug>/src`; generated `.norbital` output
  is not hand-edited.
- Each template is self-describing: `norbital.template.json` holds its picker metadata and
  `pnpm-lock.yaml` pins its own dependencies, including its exact `@norbital-ai/pod` version.
  Nothing outside the tree pins them, and publishing a pod propagates into no template. Run
  `pnpm templates:lock` when you deliberately move a template's dependencies.
- Run `pnpm lint`, `pnpm test`, and `pnpm build` after changes.
- Add a changeset for publishable package changes.
- `skills/` holds the canonical Agent Skills Pod ships (`norbital-platform`,
  `authoring-tenant-workspace`, and any future host skills). `.agents/skills/` symlinks them for
  local agent discovery in Cursor and similar tools. Run `pnpm skills:generate` after editing anything
  under `skills/`; `pnpm skills:check` verifies the generated bundle has not drifted.
