# Capability inventory

Everything below is native to a Bolt workspace unless stated otherwise. "Precedent" means an
existing template demonstrates it; a capability without precedent is still native when it is the
same primitive under a different name.

## Data and modelling

| Capability                                                                                                                  | Where it lives                                              | Precedent                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Typed collections: text, enums, numbers, UUID, dates, clock times, timestamps, date ranges, booleans, JSONB                 | `src/collections/<name>/+model.ts`                          | all templates                                                |
| Relationships, one-to-many and many-to-many, with derived queries                                                           | `src/collections/+relationship.ts`                          | all templates                                                |
| Structured domain values (bank account, work pattern, statutory regime, accrual keys, eligibility rules, payroll snapshots) | `src/datatypes/<name>/` (+definition.ts + +renderer.svelte) | hr-payroll (bank_account, work_pattern, statutory_regime, …) |
| Platform-injected custom datatypes (`custom('money')`, `custom('instant_range')`) — same declaration/access/runtime contract as tenant types | `@norbital-ai/bolt/authoring`                               | all templates (money columns)                                |
| Effective-dated facts (employee facts that change over time)                                                                | collections + hooks                                         | hr-payroll                                                   |
| System columns on every row: id, timestamps, sys_period, row_version, approval_id                                           | runtime                                                     | `norbital-platform` skill                                    |
| Temporal history and audit trail (read-only evidence; not a rollback)                                                       | runtime                                                     | `norbital-platform` skill                                    |
| Migrations, versioned and committed                                                                                         | `.norbital/migrations`                                      | all templates                                                |
| Search, filters, ordering, cursor pagination, `findGrouped`, `aggregate`                                                    | `$bolt/client`, `api.db`                                    | crm dashboards                                               |

## Workflow and logic

| Capability                                                                                                                                         | Where it lives                                                                              | Precedent                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `perRecord.before`/`after` hooks on create, update, delete; `create.prepare` for a batch's reads; nested writes returned from `before`; `refuse()` | `+hooks.ts`                                                                                 | all templates (status transition maps, credit checks, caps)          |
| Import/export shaping with typed attachments (XLSX, PDF, CSV, JSON, HTML, text)                                                                    | `+pipelines.ts`                                                                             | crm master sync, hr-payroll XLSX payroll export                      |
| Scheduled and event-triggered work, durable, idempotent, replayable                                                                                | `src/automations/+<name>.ts`                                                                | crm quote_expiry_watch, hr-payroll runs                              |
| Custom query and command endpoints with validated schemas                                                                                          | `src/functions/+<name>.ts`                                                                  | crm pipeline/procurement/settlement_summary dashboards               |
| Permission grants per team, write-then-lock approvals, approval routing, audit of who approved                                                     | `src/access/policies/+<name>.ts` + `src/access/+teams.ts`                                   | field-operations contractor/controller/WhatsApp policies, hr-payroll |
| Deterministic computation graphs with dependency ordering, replay, and audit (payroll math, accruals, eligibility)                                 | `@norbital-ai/std/reckon`                                                                   | hr-payroll payroll runs                                              |
| CEL expressions inside the engine (validation, derived values)                                                                                     | `@norbital-ai/std/reckon` (no separate `cel` subpath; `recordLabel` itself compiles to CEL) | hr-payroll, every generated record label                             |
| Money arithmetic: currency, rounding, minor units                                                                                                  | `@norbital-ai/std/finance` + `custom('money')` columns                                       | crm (net/tax/line_total), all templates                              |

## People, communication, and AI

| Capability                                                                                                                    | Where it lives                             | Precedent                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Envoy chat agents for external, accountless users (a declared transport, e.g. WhatsApp/Telegram), scoped to their own records | `src/envoys/+<name>.ts`                    | field-operations contractor WhatsApp, crm sales desk (Telegram) |
| Shared prompt for the reserved web agent and envoys                                                                           | `src/+agents.md`                           | all templates                                                   |
| Custom agent tools                                                                                                            | `src/capabilities/tools/+<name>.ts`        | —                                                               |
| Workspace agent skills                                                                                                        | `src/capabilities/skills/<name>/+skill.md` | —                                                               |
| Remote MCP servers, granted by policy                                                                                         | `src/capabilities/mcp/+<name>.ts`          | —                                                               |
| Structured AI inference (`api.infer`): prompt → typed output, optional images; bounded in hooks, durable in automations       | `api.infer`                                | field-operations photo identity                                 |
| Email and messaging via host communication facility                                                                           | facility                                   | —                                                               |
| Environment variables and server-only secrets, entered in the vault                                                           | `+env.ts`                                  | field-operations (geocoding key, export signing secret)         |
| File and asset storage, upload, server-side reads                                                                             | files facility, `api.readFileAsset`        | field-operations photo evidence                                 |

## External world (mediated surfaces)

| Capability                                                                                | Where it lives           | Precedent                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| Signed inbound webhooks (authenticated writes)                                            | `+integrations.ts`       | crm external sync registry                                                        |
| Outbound HTTP sends with credentials, outbox semantics                                    | `+integrations.ts`       | crm confirmed-document handoff                                                    |
| Scheduled pulls with cursor and identity (master mirroring)                               | `+integrations.ts`       | crm accounts/products/suppliers mirrors                                           |
| Generic provider connector facility                                                       | connector facility       | —                                                                                 |
| Browser SDKs and WASM inside the bundle (3D, physics, image processing, office documents) | client-side dependencies | field-operations `pdq-wasm`, `fast-png`, `jpeg-js`, `exifr`; hr-payroll `exceljs` |
| SSE/WebSocket transport                                                                   | transport facility       | —                                                                                 |

## UI

| Capability                                                                                       | Where it lives                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Apps, tabs, list/table surfaces, kanban, forms, custom create/display/edit representations       | `src/apps/`, `+representation.svelte`, `CollectionTable`, kanban |
| Charts, calendars, event calendars, resource schedulers, static maps, tree views, data renderers | `@norbital-ai/ui`                                                |
| File upload, markdown and code editors, dialogs, sheets, step forms, sorting, searching          | `@norbital-ai/ui`                                                |
| Mandatory bilingual copy (English + Chinese catalogs), statically enforced                       | `src/i18n/`                                                      |
| Layout primitives with a single scroll owner per axis                                            | `@norbital-ai/ui/layout`                                         |

## Not a capability

These look like capabilities but are not tenant-facing; do not offer them:

- **The platform's own billing and metering** (`@norbital-ai/std` billing) prices _the platform_
  for Norbital; it is not a payment facility for tenants.
- **Sandbox host tools** (`sandbox_*`) reach the tenant's source tree during authoring; they are
  not runtime features users interact with.
