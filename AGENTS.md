# Norbital OSS

This pnpm and Turborepo monorepo owns all `@norbital-ai/*` packages.

> **Templates have moved.** Template source now lives in its own repositories —
> [`norbital-ai/templates`](https://github.com/norbital-ai/templates) (public, advertised on the
> website) and `norbital-ai/templates-private` (not advertised). Those are the source of truth and
> the only place `refs/heads/templates/*` is published from; this repository no longer publishes
> them. **Do not author template changes here.**
>
> Template marketing image (website gallery / `og:image`): `<key>/assets/thumbnail.svg`. That is
> not `pod:banner` / `pod:thumbnail`. See
> `skills/authoring-tenant-workspace/references/template-repository.md`.

- Package implementation and package-specific documentation stay together under `packages/<name>/`.
- Run `pnpm lint`, `pnpm test`, and `pnpm build` after changes.
- Keep the five public package manifests on one explicit release version. Package changes merge only
  after `pnpm publication:check`; the release workflow publishes that immutable version together.
- `skills/` holds the canonical Agent Skills Pod ships (`norbital-platform`,
  `authoring-tenant-workspace`, and any future host skills). `.agents/skills/` symlinks them for
  local agent discovery in Cursor and similar tools. Run `pnpm skills:generate` after editing anything
  under `skills/`; `pnpm skills:check` verifies the generated bundle has not drifted.
