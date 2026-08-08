# @norbital-ai/std

## 1.0.0

## 4.0.1

### Patch Changes

- 9594db9: Republish the packages with complete build output.

  Several published tarballs are missing whole directories their own `package.json` declares exports
  for. `@norbital-ai/std@4.0.0` ships no `build/json`, `cache`, `error`, `finance`, `result`, `string`,
  `text`, `tree` or `truncate`; `@norbital-ai/platform-utils@3.0.0` ships no `build/system/collections.js`.
  Nothing failed at publish time, because a tarball that disagrees with its manifest is only wrong one
  layer down — it surfaced in tenant builds as `Cannot find module '@norbital-ai/std/build/json/index.js'`
  and `.../platform-utils/build/system/collections.js`.

  The cause was the concurrent `prepack` race now fixed in the release workflow. `changeset publish`
  packs the packages in parallel; several of those packs rebuild the same dependency, and
  `scripts/build-package.mjs` opens by removing the staging directory it is about to compile into. A
  package was therefore packed from a directory another process was part-way through rebuilding. The
  workflow now builds every publishable package once up front, so each prepack is a turbo cache hit and
  no two packs ever compile the same package concurrently.

  Registry versions are immutable, so the affected versions stay as they are and this republishes the
  same source under a new one.

## 4.0.0

### Minor Changes

- fd8435e: Add type-safe internationalization for English and Simplified Chinese.

  - `@norbital-ai/std/i18n`: locale parsing and persistence (`parseLocale`, `pickLocale`, `storedLocale`, `storeLocale`, `setHtmlLang`), typed catalogs with compile-time en/zh key parity (`defineMessages`, `translate`, `hasKey`), and the non-reactive `createI18n` runtime for server code.
  - `@norbital-ai/ui/i18n`: reactive Svelte context (`provideI18n`, `useI18n`) with `t`/`has`/`setLocale` and an `intlLocale` derived from the active locale; a `setGlobalLocale` fallback for consumers without a provider; a full en/zh catalog for the component library (`common.*`, `table.*`, `kanban.*`, `form.*`, `dataRenderer.*`, `misc.*`); `locale` props now default to the active locale for date/number/phone formatting.
  - `@norbital-ai/pod/i18n`: the pod chrome and server catalog (`pod.*`, `server.*`, `email.*`, `identity.*`) plus `serverI18n` for server-rendered surfaces (identity pages, transactional email) resolving `?lang=` then `Accept-Language`.
  - Pod compiler: discovers tenant `src/i18n/messages.{en,zh}.json` with structural validation (key parity, JSON shape), generates the typed `TenantI18nKeys` union (`$pod/i18n-keys`), and merges tenant overrides over the platform catalogs at build time (`virtual:pod/i18n`).
  - Pod shell: per-locale sidebar labels via `app.<appId>.title` / `app.<groupId>.title` catalog keys; all platform chrome strings migrated to the catalog.
  - The `authoring-tenant-workspace` skill documents tenant i18n authoring.

### Patch Changes

- fd8435e: Rename the agent/sandbox seat display to Pro and raise the monthly seat price to SGD 50.00. Sandbox and production Stripe Prices updated; old SGD 45 Prices archived.

## 3.0.0

### Minor Changes

- d864ec2: Add the `@norbital-ai/std/i18n` entry point: a typed message catalog, interpolation, and locale
  detection/persistence shared by the pod shell and the UI package. Both now import it, so it has to
  be published as part of the same release rather than resolved from the workspace.

## 2.0.0

## 1.0.2

## 1.0.1

## 1.0.0

## 0.0.1

### Patch Changes

- Shared schema, date, CEL, finance, and utility modules for Norbital.
