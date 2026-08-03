# @norbital-ai/ui

## 1.0.0

### Patch Changes

- c386ba2: Build through turbo when packing, and fail a build that emitted `any`.

  `@norbital-ai/pod@0.0.3` shipped `utcInstantSchema` and `clockTimeZodSchema` as `any`, and `dateRangeZodSchema` as `{ start: any; end: any }`. The cause was ordering, not types. Every publishable package declared `"prepack": "pnpm build"` — its own build, run directly. `changeset publish` therefore compiled each package outside turbo's `^build` ordering, and the release workflow installs with `--ignore-scripts` and never builds, so `packages/std/build` did not exist when pod compiled. The two constants infer their type through `isUtcIsoInstant`/`isClockTime`, imported from `@norbital-ai/std/date`; with nothing to resolve, the predicate became `any`, the `.refine()` overload collapsed, and `svelte-package` wrote the degraded declaration and exited 0.

  The published `any` then became an index signature that flowed through `TablesForModels`, collapsing `TableName<S>` to `string`, stripping the named tables off `DbRelationalQueryRoot`, and pushing `AfterDbApi` onto its `string extends TableName<…>` branch — in every workspace, including ones with no `dateRange()` column.

  Three changes, none of them a type annotation:

  - `prepack` now runs `pnpm exec turbo run build --filter=<package>`, so packing goes through the dependency graph rather than around it. `prepack` is the only hook common to every path that produces a tarball — `changeset publish`, a developer's `pnpm pack`, and `publication:check` — which is why the ordering is fixed there rather than in the release workflow.
  - `scripts/build-package.mjs` refuses to start the compiler when a `workspace:` dependency has a build script but no `build/`, and reads its own emitted declarations back before swapping them in, discarding any output that contains `any` in type position. Both cost milliseconds, so they run on every build, publishing included.
  - `publication:check` unpacks each archive and re-runs that assertion against the bytes that would reach the registry. A GitHub Packages version can never be reused, so a poisoned publish is permanent.

  The two constants stay unannotated: with the ordering fixed, inference emits `z.ZodString` on its own.

- Updated dependencies [ab72b9c]
- Updated dependencies [ab72b9c]
- Updated dependencies [675400c]
- Updated dependencies [2cd75e3]
- Updated dependencies [c386ba2]
- Updated dependencies [99da5a7]
- Updated dependencies [ab72b9c]
  - @norbital-ai/platform-utils@0.1.0
  - @norbital-ai/std@0.0.2

## 0.0.3

### Patch Changes

- 6178bff: Stop `SidebarMenuButton` and `SidebarMenuSubButton` styling every direct child span.

  Both carried `[&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate` in their base class, which reached
  every direct child span rather than the label it was written for. `Badge` renders a span when it has
  no `href`, so a trailing badge was stretched across the row and had to be beaten back with
  `!w-fit !min-w-fit !flex-none`, and a chevron column had to be a `div` to escape the same rule. Every
  label span in this repository already sets `min-w-0 flex-1 truncate` locally, so the blanket rule was
  load-bearing for nothing here.

  **Behavioural change for external consumers.** A caller whose sidebar label span relied on the
  inherited rule now needs `min-w-0 flex-1 truncate` on that span itself, or the label stops flexing
  and truncating. Conversely, any `!w-fit !min-w-fit !flex-none` workaround written to escape the rule
  can be dropped. Nothing else about the buttons changes.

## 0.0.2

### Patch Changes

- e0dd1a9: Group tenant and host-owned settings under one shell with Core provenance badges, preserve plugin
  placement across the server/browser boundary, standardize workspace page tabs, fully unmount the
  outgoing tenant document while an organization switch is in progress, and restore bounded Kanban
  lane scrolling after the layout-primitive migration.
- 3b63018: Pass the current form row into field renderers, let matrix columns declare immutable or specialized
  cells, and allow form compositions to fill the available body height. Repayment schedules use these
  contracts to render payroll consumption provenance without per-row queries or nested scroll traps.

## 0.0.1

- Initial public release of the Pod and Core interface primitives.
