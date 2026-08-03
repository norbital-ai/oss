---
'@norbital-ai/platform-utils': patch
'@norbital-ai/pod': patch
'@norbital-ai/std': patch
'@norbital-ai/ui': patch
---

Build through turbo when packing, and fail a build that emitted `any`.

`@norbital-ai/pod@0.0.3` shipped `utcInstantSchema` and `clockTimeZodSchema` as `any`, and `dateRangeZodSchema` as `{ start: any; end: any }`. The cause was ordering, not types. Every publishable package declared `"prepack": "pnpm build"` — its own build, run directly. `changeset publish` therefore compiled each package outside turbo's `^build` ordering, and the release workflow installs with `--ignore-scripts` and never builds, so `packages/std/build` did not exist when pod compiled. The two constants infer their type through `isUtcIsoInstant`/`isClockTime`, imported from `@norbital-ai/std/date`; with nothing to resolve, the predicate became `any`, the `.refine()` overload collapsed, and `svelte-package` wrote the degraded declaration and exited 0.

The published `any` then became an index signature that flowed through `TablesForModels`, collapsing `TableName<S>` to `string`, stripping the named tables off `DbRelationalQueryRoot`, and pushing `AfterDbApi` onto its `string extends TableName<…>` branch — in every workspace, including ones with no `dateRange()` column.

Three changes, none of them a type annotation:

- `prepack` now runs `pnpm exec turbo run build --filter=<package>`, so packing goes through the dependency graph rather than around it. `prepack` is the only hook common to every path that produces a tarball — `changeset publish`, a developer's `pnpm pack`, and `publication:check` — which is why the ordering is fixed there rather than in the release workflow.
- `scripts/build-package.mjs` refuses to start the compiler when a `workspace:` dependency has a build script but no `build/`, and reads its own emitted declarations back before swapping them in, discarding any output that contains `any` in type position. Both cost milliseconds, so they run on every build, publishing included.
- `publication:check` unpacks each archive and re-runs that assertion against the bytes that would reach the registry. A GitHub Packages version can never be reused, so a poisoned publish is permanent.

The two constants stay unannotated: with the ordering fixed, inference emits `z.ZodString` on its own.
