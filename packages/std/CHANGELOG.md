# @norbital-ai/std

## 0.0.4

### Patch Changes

- Release the five packages as one set, so no template pins a mix.

  `config`, `std` and `ui` carry no source change here. They are versioned anyway because a template
  pins every first-party dependency exactly and exempts each pinned version from the release-age delay
  by name — a partial bump would leave a template straddling two release sets.

## 0.0.3

### Patch Changes

- a1f5eae: Release the five packages as one set, so no template pins a mix.

  `config`, `std` and `ui` carry no source change in this release. They are versioned anyway because a
  template pins every first-party dependency exactly and exempts each pinned version from the
  release-age delay by name — a partial bump would leave a template straddling two release sets, which
  is the state those two mechanisms exist to make impossible to enter by accident.

## 0.0.2

### Patch Changes

- ab72b9c: Drop `bca` from the label initialism map.

  `humanize` uses the map so a generated label reads the way the domain says it, not the way a column
  name is spelled — `api_key` as "API Key" rather than "Api Key". `bca` was in there for one reference
  template that named itself after a specific regulator, which is exactly the kind of tenant-specific
  vocabulary a shared package should not carry: every workspace using the platform inherited a casing
  rule for an acronym that means nothing in their domain, and the only way to find out was to name a
  column `bca` and watch it render.

  The template it served is now `field-operations`, so the entry has no caller left. A workspace that
  genuinely needs a domain acronym cased should get it from its own label overrides rather than by
  having the term added here.

  `humanize('bca')` now returns `Bca`. Nothing in the monorepo depends on the old result.

- c386ba2: Build through turbo when packing, and fail a build that emitted `any`.

  `@norbital-ai/pod@0.0.3` shipped `utcInstantSchema` and `clockTimeZodSchema` as `any`, and `dateRangeZodSchema` as `{ start: any; end: any }`. The cause was ordering, not types. Every publishable package declared `"prepack": "pnpm build"` — its own build, run directly. `changeset publish` therefore compiled each package outside turbo's `^build` ordering, and the release workflow installs with `--ignore-scripts` and never builds, so `packages/std/build` did not exist when pod compiled. The two constants infer their type through `isUtcIsoInstant`/`isClockTime`, imported from `@norbital-ai/std/date`; with nothing to resolve, the predicate became `any`, the `.refine()` overload collapsed, and `svelte-package` wrote the degraded declaration and exited 0.

  The published `any` then became an index signature that flowed through `TablesForModels`, collapsing `TableName<S>` to `string`, stripping the named tables off `DbRelationalQueryRoot`, and pushing `AfterDbApi` onto its `string extends TableName<…>` branch — in every workspace, including ones with no `dateRange()` column.

  Three changes, none of them a type annotation:

  - `prepack` now runs `pnpm exec turbo run build --filter=<package>`, so packing goes through the dependency graph rather than around it. `prepack` is the only hook common to every path that produces a tarball — `changeset publish`, a developer's `pnpm pack`, and `publication:check` — which is why the ordering is fixed there rather than in the release workflow.
  - `scripts/build-package.mjs` refuses to start the compiler when a `workspace:` dependency has a build script but no `build/`, and reads its own emitted declarations back before swapping them in, discarding any output that contains `any` in type position. Both cost milliseconds, so they run on every build, publishing included.
  - `publication:check` unpacks each archive and re-runs that assertion against the bytes that would reach the registry. A GitHub Packages version can never be reused, so a poisoned publish is permanent.

  The two constants stay unannotated: with the ordering fixed, inference emits `z.ZodString` on its own.

## 0.0.1

- Initial public release of shared runtime helpers.
