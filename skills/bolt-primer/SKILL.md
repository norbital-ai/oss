---
name: bolt-primer
description: How a Bolt workspace works, what the platform already renders, and which native mechanism owns each job, so a change reuses it instead of rebuilding it.
---

## Start with the compiler

`workspace_lang` is the source of truth for the installed version: `diagnostics` (one file, or the whole program
without `path`), `hover`, `type`, `completions` on an import, `definition`, `references` and `signature`. A type
expression names a type with `import('@norbital-ai/bolt').X` and a value with `typeof import('@norbital-ai/bolt').x`;
completions enumerate exports you cannot name yet; hover and type show the compiler's JSDoc, examples and deprecation
guidance. Bolt's contracts are written in those comments, and its source is not in the workspace, so read them through
the tools: `workspace_api` answers a type's comment and every member's type and comment at once, `X['field']` narrows to
one, and `Parameters<typeof import('@norbital-ai/bolt').automation>[1]` reads what a function takes. After every edit
run `diagnostics`; `workspace_validate` is the build and preview; `workspace_test` runs the
test kit; `workspace_diagnose` is the full check. There is no separate docs tool.

Before writing, read the authoring skill's reference for the thing you are about to author; its routing table names
each. A clean build is not a test, and a compatible type is not proof of runtime authority.

## The workspace

Everything is source under src/; a `+` file is a compiler role and its path is its name. Names match `^[a-z][a-z0-9_]*$`.
`+workspace.ts` (zone, locale, connections); `data/model/<name>/+model.ts` with an optional `+representation.svelte` (a
child model nests as `data/model/<owner>/<child>/+model.ts`; the leaf folder names the model); `data/custom_field/<name>/`
(`+definition.ts`, optional `+renderer.svelte`); `access_control/policy/+<name>.policy.ts` and `team/+team.ts`;
`integration/<name>/+integration.ts` (+ optional `.svelte`); `agent/+agent.md`, `envoy/+<id>.envoy.ts`,
`skill/<name>/+skill.md`; `automation/+<name>.automation.ts`; `app/<app>/+app.ts` with `+<page>.page.svelte`
(`import { bolt } from '$bolt'`); `kiosk/<k>/+kiosk.ts`; `i18n/+messages.ts` and `+<locale>.messages.ts`. Anything
without `+` is an ordinary module (`src/lib`). `.norbital/` is generated. The preview build writes the next migration
into the change: never hand-write one.

## The model is the contract

A model is the entity and its exposed contract, not a screen. Declare what it stores (`fields`, `ref` fields with
`inverse`, keys, checks, computed fields, `search`) and what callers may do (`read` outputs and layers, `create`,
`update`, `delete`, state/enum `transitions`, write callbacks, `notify`, `effect`, `syncs`). A `read` is the `default`
output; `outputs` are narrower named audiences. A policy decides which outputs and rows a caller reads and which
columns and state moves they write; a model declaration alone never grants access.

Prefer fewer, richer entities. Use a built-in field kind first; a `customField` for a reusable stored structure with
its own validation/renderer; typed `json` with a `shape` for a value that belongs to its parent; a separate model only
when the thing needs independent identity, lifecycle, permissions, history or relational queries. Store configuration
in authorized runtime records, not in source constants. Never put a credential, token or secret value in a model field.

## Access, approvals and state

A `policy` grants per model: read outputs and row filters, write columns, state moves, capabilities (apps, host tools,
MCP), automations it may start and limits. Teams hold policies; the policy graph scopes data without inheriting
authority. Direct permission executes; without it, a policy's `check` may return `ctx.approve(flow)` and the write is
held as a native approval request. The flow's named steps and approvers are snapshotted; decisions are `approve`,
`reject` and `requestChanges`; rejection restores the checkpoint, and the requester's next Save resubmits requested
changes. Use the record sheet's native approval panel; never add a second approval control or re-check grants in a page.
State locks, enum transitions, `check`, `noOverlap` and required fields are enforced by the engine and shown by the
native form. A `requestor` variable is the acting member; an automation's `requestor` is not the person who started it.

## Automations

An `automation` is a job the reserved system identity runs with its declared `policies` (required), typed `input` and
`output`, an optional `on` (cron or webhook), retries and concurrency. `ctx.run.trigger` records `system` and its cause
(cron, webhook, effect, schedule) or the `person`, plus the agent conversation when Norbius started it; check it
explicitly when business rules depend on the starter. A person who may start a job does not lend it their authority.
Every startable automation appears in the native Command Center Automations with its typed form; a page form is
optional. Use an automation for external I/O, a scheduled or webhook job, and a business operation that needs its own
authority and run history. A model `effect` is the work that follows a committed write, runs as the writer and holds no
policy of its own. `ctx.schedule` queues a follow-up; `bolt.start` starts one from a page.

## Infer and decide

`ctx.ai.sys_1.decide` answers typed choice/score questions from text and images; `ctx.ai.sys_2.infer` returns a typed
structure (or calls declared host tools); `ctx.ai.embed` fills a vector field. These are proposals: a write still runs
through the model's grants, checks and approvals, and a person confirms anything that changes money or access. Hosts do
not run an LLM themselves; an integration names the hosted provider and its sealed credential. Use scripted provider
output in tests, never a live model.

## Sync engine

A model's `syncs` declares exchange. A file sync uses `with: 'file'`, `parser` (built-in or typed `parse`), optional
`context`, and inline `read`/`write` bodies; the native toolbar then owns Import, Download template and Export. A
remote sync names an integration `with`, an optional `every`, and typed `read`/`write`; it runs as a job, and only
returned source fields change. Workbook importers, CSV feeds and repeated exports belong here, not in a page script or
an ad-hoc automation. `ctx.sync` starts a named sync.

## The UI is already there

`Table` of a model renders the toolbar (title, description, search, filter/sort, column menu, CSV export, ⚡ actions,
New), selection, paging, empty states, approvals and the record sheet. `CustomView` draws any other body over rows with
the same toolbar; `Board`, `Map`, `Pivot`, `Matrix`, `EventCalendar` and `Chart` take the same toolbar. `AppShell`
renders the page hero and the page scope in `actions`; pages come from `+app.ts`. `RecordShell` renders a model's
representation (or generated fields) with the state pill, lock banner, approval panel, history and runs. A
`+representation.svelte` receives `{ view }` or reads `useRecordView()`; it edits the record's own facts and uses
`ChildGrid` for related rows. `Form` renders authorized fields, defaults, required checks, state moves and approval
routing. Every built-in kind renders and edits itself in cells, forms and history: text formats, money, numbers, dates,
periods, enum/state words, files, points, links and typed JSON. Never hand-build search, filters, paging, import/export,
history, approvals or a label map. Use a chart only when it answers a question a table cannot; read `ui-standard.md`.

## Implicit mechanisms: never rebuild

The shell owns the approval inbox, notifications (`notify`), history/restore, audit, runs, the finder (models with
`search.text`), Settings (people, organisation, audit, automation runs, integrations, secrets) and Studio. A declared
file sync adds Import/Export/Template. A model's `notify` receives every write and approval event. A page opens a
record through `RecordShell`; it never imports a role module or writes its own sheet. Permissions, locks, transitions
and required fields are enforced, not advisory.

## A rebuild or a new capability? Do the pass

For a repository rebuild read the `authoring-tenant-workspace` skill's `references/repository-rebuild.md`.
Before authoring, list every source capability and choose its Bolt mechanism: model/relationship; read output/layer;
guarded write/check/approval; page and task flow; representation/record sheet; automation; file or remote sync;
custom field vs built-in kind vs typed JSON vs child model; chart/summary; team/policy; test. A skipped category is a
recorded decision with a reason, never a silent omission. A rebuild with no automations, syncs, charts or
representations should say why for each.

## References

The `authoring-tenant-workspace` skill's routing table is the index. Read only the reference the task needs: model boundaries,
models-and-modeling, data-access, apps-and-server-roles, built-ins, app-structure, ui-standard,
controller-surfaces, layout-and-scrolling, padding-and-spacing, typography, generated-and-build,
hosts-and-facilities, internationalization, template-repository, studio, repository-rebuild. Policy and approval
behaviour is in `norbital-platform`; tests are in `authoring-test-suites`.
