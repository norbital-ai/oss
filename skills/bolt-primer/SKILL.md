---
name: bolt-primer
description: Build a Bolt workspace with no other skill - source roles, contract queries, authoring order, pitfalls.
---

This page, its starters at the end and `workspace_lang` are enough for a normal build: read no other skill first. Read a reference only for a diagnostic this page does not resolve. Ask for several types in one `workspace_lang` call.

## Roles

A `+` file is a compiler role, default-exporting its declaration; its path is its name (`^[a-z][a-z0-9_]*$`, folders singular). Other files are plain modules. Under `src/`:

- `+workspace.ts` `workspace(spec)`: zone, locale, currency, apps, capabilities
- `+secrets.ts` `secrets(spec)`: secret names
- `data/model/<name>/+model.ts` `model('<name>', spec)`: fields, reads, writes, state, search, `effect` (work after a committed write). Folders nest; the leaf names it. `+representation.svelte` beside it: record view; `+<sync>.sync.ts` `sync('<model>', '<sync>', spec)`: a file or remote sync
- `data/custom_field/<name>/+custom_field.ts` `custom_field(spec)`, `+renderer.svelte`: value type
- `access_control/policy/+<name>.policy.ts` `policy(spec)`: what holders may do
- `access_control/team/+team.ts` `team(spec)`: team handles to policies
- `automation/+<name>.automation.ts` `automation(spec)`: job or call with its own policies; `agent` controls its use as a tool
- `integration/<name>/+integration.ts` `integration('<name>', spec)`, `+integration.svelte`: connection, setup
- `app/<app>/+app.ts` `app(spec)`: label and `pages`; `+group.ts` `group(spec)`
- `app/<app>/+<page>.page.svelte`: page with a `ctx` prop
- `app/<k>/+app.ts` with `shell: 'kiosk'`: shared-device surface with fixed policies
- `agent/+agent.md`, `agent/skill/<s>/+skill.md`: brief, skill
- `agent/mcp/+<n>.mcp.ts` `mcp(spec)`; envoys are runtime `sys_envoy` rows
- `i18n/+messages.ts` `messages(spec)`, `+<locale>.messages.ts`

Beside `src/`: `seed/+seeder.ts` `seeder(spec)`; rows `seed/public/**/<model>.json`, `seed/test/**/<model>.json`; `tests/*.test.ts`; `assets/`.

## Contracts

Write each role from its starter below. A role's card in `bolt-contract` lists its symbols' fields and types, generated from them: read it once, only for a field the starter does not show. A role without a card is answered by `workspace_lang` on the exported type; never guess a filename.

A body that takes `ctx` is a generator, `function* (…)`: a policy `verdict`, a transform, an effect or a `run`. It goes through `yield*`.

`workspace_lang` answers only what a card leaves out:

- A type: `{ op:'type', type:["import('@norbital-ai/ui').TableProps"] }`, several at once. `import('pkg').X` works only for exported types; a value is `typeof import('pkg').x`. Packages: bolt, ui, bolt-cli; shared numeric and date utilities come from Effect.
- A declaration's spec: `Parameters<typeof import('pkg').fn>[0]` for single-argument declarations; model and integration take name then spec (`[1]`), sync takes model, name then spec (`[2]`). The declared name must match the source role. Narrow with `X['field']`. Models and integrations use their generated per-file binding, not a root declaration imported back from their source.
- `type` answers any shape with no file. `completions`, `hover`, `signature` need path, line, column of a file you are writing: a file written only to ask is a wasted edit.
- Live names: `describe_workspace`, `workspace_list_dir`.
- **No `node_modules/` or `.norbital/` in the workspace:** packages live in a centralized host store shared across tenants and cannot be read with file tools. Never glob, grep, or read `node_modules/` or `.norbital/` — inspect package/component types with `workspace_lang` (or `bolt-contract` docs) and install packages with `workspace_install`.

## Protocol

1. Author in order: model, access, automation or sync, page, tests. Add a page only for a task the model's table and record sheet do not cover.
2. Edit with `workspace_write`, `workspace_edit` and `workspace_move`, one file a call, or `workspace_patch`, any number of files in one call. Edits stay in your working tree and check nothing: finish the source, then diagnose. After a schema change `workspace_generate` writes the generated migrations into the working tree; a diagnosis fails until they exist. `workspace_migrate` runs them on your own workspace's database, with SQL reads before and after, so you see what they do to real rows. Only a merge migrates live.
3. `workspace_diagnose` runs the diagnosis on the working tree. `workspace_test` runs the tests; a long run goes on in the background and reports by itself. Both run by hand. Fix what they name. Tests `empty` proves nothing: every automation and refused state carries a test.
4. `workspace_commit` with a message, in any state; new commits join your line on top of live. `workspace_rebase` replays them on top of live, migrations too, when you want to test against live as it is now; a merge never needs it. Reverting to redo work never helps.
5. `workspace_preview` builds the last commit, serves it and opens every page. `workspace_try` runs each automation once on the preview and reads what it changed. A preview binds no integration links: a sync's decoding is proved in a test. After the merge, create its connection on live with `sys_integration.create { integration, name }`, start it, and read the rows.
6. `workspace_merge` with the last commit, a summary and a ledger saying for each capability what implements it, or `skip: reason`. It needs no uncommitted edits and a preview of that commit, and is refused over a known failed diagnosis or failed tests. Merges land one at a time: the queue replays your commits on live as it stands, runs any diagnosis or tests that head lacks, and checks again if the replay changed anything.

## Core principles

- **Never duplicate built-in Bolt capabilities:**
  - **Access control & approvals:** use `+team.ts`, `+<name>.policy.ts`, `ctx.approve` and `sys_approval` — never custom role, permission or approval models or hand-rolled authorization checks.
  - **Statuses & lifecycles:** use `kind: 'state'` with declared transitions, locks and policy `update.moves` — never shadow status tables or parallel transition state machines.
  - **Live queries & reactivity:** use `PageBolt.query(...)` (automatically live over SSE) — never manual refresh loops, `setInterval`/timer polling or ad-hoc client refetch/cache state.
  - **Platform primitives:** reuse native audit/history, search indexes, filters, paging, import/export, label maps, file fields, auth/users/invitations, envoys/channels, write triggers (`on:`), durable waits (`ctx.wait`) and `@norbital-ai/ui` controls (`Table`, `Board`, `RecordShell`, `TimeInput`/`TimeRangeInput`).
- **Scale-to-zero & Neon discipline:** every safety-net `cron` declares `rest` (e.g. `rest: '24h'`) so idle tenants suspend on Neon instead of billing 1 CU continuously. Prefer write triggers (`on: [{ model, verbs }]`) and durable waits (`ctx.wait({ until | model | approval })`) over polling crons; poll only external systems that cannot push webhooks (e.g. legacy ERPs).
- **AI cost & context efficiency:** bound `ctx.ai.sys_2.infer` with explicit `steps` and batch/dedupe inputs instead of calling System 2 per row; use `ctx.ai.sys_1` for lightweight classification/triage. Keep `src/agent/+agent.md` minimal (end-user domain rules only — never duplicate `[Catalogue]`, `KERNEL` or Studio/code instructions; keep code invariants in `src/agent/AGENTS.md`).
- **Data & query performance:** record IDs are monotonic UUIDv7 — paginate chronologically with `order_by: { id: 'desc' }` (or `'asc'`) without extra sort columns; pass explicit `limit` and narrow named `outputs`; batch lookups with `in` filters instead of N+1 `ctx.query` loops; link multi-model writes in one atomic `ctx.act` with `new_id(model)`.

## Rules

- A model exposes guarded verbs only. A business operation is an automation.
- A policy can only grant a verb the model declares; it filters rows, never shape.
- An automation runs with its declared `policies`, never its starter's; `actor.*` there matches nothing.
- Effectful bodies are `function*` and `yield*` their `ctx` Effects.
- Exact decimal calculations use Effect `BigDecimal`; stored decimal values are strings, never binary floating-point approximations.
- File fields require both `accept` MIME patterns and `max` in `KiB`/`MiB`/`GiB` or `KB`/`MB`/`GB` with no space (e.g. `{ kind: 'file', accept: ['application/pdf'], max: '20MiB', optional: true }`). Model one-to-many children with a single `ref` on the child model; never declare a `many: true` `ref` back-list on the parent.
- Named constraints take arrays for `unique` and `per`. Mark one unique constraint `import_key: true` for matching imports. Computed expressions live on fields; physical and search indexes live under `indexes`.
- Each create/update transform and per-verb effect receives `{ before, set, after, changed }` changes. Create/update transforms return sets or `{ sets, with, on_approved }` with one set per input in order, including approval replay. Preserve unchanged sets with `changes.map(({ set }) => set)`; a delete transform returns nothing or `{ with, on_approved }`. Effects receive approval lifecycle details in `ctx.event`.
- Commit related writes through one `ctx.act({ '<model>.<verb>': inputs })` map. Update/delete targets carry selected rows and their revisions. There are no `many`, `checked`, upsert or transaction alternatives.
- `seed/test/assets.json` and `seed/public/assets.json` are the reserved asset list: never name seed rows that, even for a model called assets.
- Migrations are generated. Edit one only to move data: the schema must arrive at what the models declare. Never edit `.norbital/`.
- Credentials never enter source, seeds or model fields.
- Keep evolving business rules, research prompts, scoring rubrics, and tunable thresholds in a runtime configuration model (seeded with defaults, editable directly as data) instead of hardcoding them in automation source and running repeated Studio build/migrate/merge cycles.
- When launching a large background sweep (e.g. 50+ records), queue the runs and report status right away instead of blocking the conversation inside repeated `wait` loops.

Detail: the `authoring-tenant-workspace` skill indexes every reference.

- A test sets no `timeout` option and never waits on the wall clock: the test lint refuses the run even when every case passes.
- Porting a system: use the supplied archive or `reference` its repository once, then trace its routes, forms, rules, jobs and tests. With `run_js`, filter batched `read_file` results inside the script. Return paths, domain keys and short excerpts for the current journey. Count distinct records or keys in code; a search excerpt counts matching lines. Apply related edits as one workspace_patch, using the current text for context. Record the wider inventory once and map each capability to Bolt. When a record names its approver, test another member of that team is denied. Import and export carry over as a file sync per model that had them.

## Messaging and envoys

Envoys are runtime `sys_envoy` rows, deployed through `sys_integration.envoy`. Do not look for an envoy source declaration or assume a contract filename. `describe_workspace { names: ['system'] }` returns available setup capabilities and account IDs. Create the envoy and its workspace account through native records, then open `integration.manage` with `page { path, configure }` for the person to pair it. Never collect credentials in chat.

A daily message is a cron automation using `ctx.send` through the intended active, paired account. Resolve it from runtime records, narrow its definition with `instance_id`, and fail clearly if missing or ambiguous. Recipient replies continue through the deployed envoy in the same conversation. Confirm queue admission separately from provider delivery; a timeout may be uncertain and a retried automation may repeat a committed send.

## Asking to apply a change

Write the approval summary in one or two short sentences: what changes for the person and any material data risk. Keep evaluation scores, schema inventories, commit messages and test logs in the work evidence. The native card already presents the version, measured data changes and decision buttons; do not paste the same proposal again in an assistant reply. Let the person use the card.
