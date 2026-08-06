---
"@norbital-ai/std": minor
"@norbital-ai/ui": minor
"@norbital-ai/pod": minor
---

Add type-safe internationalization for English and Simplified Chinese.

- `@norbital-ai/std/i18n`: locale parsing and persistence (`parseLocale`, `pickLocale`, `storedLocale`, `storeLocale`, `setHtmlLang`), typed catalogs with compile-time en/zh key parity (`defineMessages`, `translate`, `hasKey`), and the non-reactive `createI18n` runtime for server code.
- `@norbital-ai/ui/i18n`: reactive Svelte context (`provideI18n`, `useI18n`) with `t`/`has`/`setLocale` and an `intlLocale` derived from the active locale; a `setGlobalLocale` fallback for consumers without a provider; a full en/zh catalog for the component library (`common.*`, `table.*`, `kanban.*`, `form.*`, `dataRenderer.*`, `misc.*`); `locale` props now default to the active locale for date/number/phone formatting.
- `@norbital-ai/pod/i18n`: the pod chrome and server catalog (`pod.*`, `server.*`, `email.*`, `identity.*`) plus `serverI18n` for server-rendered surfaces (identity pages, transactional email) resolving `?lang=` then `Accept-Language`.
- Pod compiler: discovers tenant `src/i18n/messages.{en,zh}.json` with structural validation (key parity, JSON shape), generates the typed `TenantI18nKeys` union (`$pod/i18n-keys`), and merges tenant overrides over the platform catalogs at build time (`virtual:pod/i18n`).
- Pod shell: per-locale sidebar labels via `app.<appId>.title` / `app.<groupId>.title` catalog keys; all platform chrome strings migrated to the catalog.
- The `authoring-tenant-workspace` skill documents tenant i18n authoring.
