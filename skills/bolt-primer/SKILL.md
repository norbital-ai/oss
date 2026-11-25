---
name: bolt-primer
description: Build a Bolt workspace with no other skill - source roles, contract queries, authoring order, pitfalls.
---

This page, its starters below and `workspace_lang` are enough for a normal build: read no other skill first. Open references only for what this page leaves open, batching several in one call (`skill { name, files: [...] }`). Ask for several types in one `workspace_lang` call. Emit **4–8 independent `workspace_read`, `workspace_write` or `workspace_edit` calls in the same turn** — they execute concurrently.

## Roles

A `+` file is a compiler role default-exporting its declaration; its path is its name (`^[a-z][a-z0-9_]*$`, folders singular). Other files are plain modules. Under `src/`:

- `+workspace.ts` `workspace(spec)`: `tz`, `locale`, `languages` (default `['en']`; English is basis; `>1` enables Globe switcher and `check/messages-locale-missing` + `check/untranslated-text`), `currency`, `apps`, `theme`, `ai`, `capabilities`, `limits`, `signup`
- `+secrets.ts` `secrets(spec)`: secret names (`UPPER_SNAKE`)
- `data/model/<name>/+model.ts` `model('<name>', spec)`: fields, `outputs`, writes, `state`, `constraints`, `indexes`, `effect` (post-commit). Nested folders; leaf names it. Beside it: `+representation.svelte` (record view), `+<sync>.sync.ts` `sync('<model>', '<sync>', spec)` (file or remote sync)
- `data/custom_field/<name>/+custom_field.ts` `custom_field(spec)`, `+renderer.svelte`
- `access_control/policy/+<name>.policy.ts` `policy(spec)`, `access_control/team/+team.ts` `team(spec)`
- `automation/+<name>.automation.ts` `automation(spec)`: job (`mode: 'job'`, default) or RPC (`mode: 'call'`); requires `policies`; `agent` controls tool exposure
- `integration/<name>/+integration.ts` `integration('<name>', spec)`, optional `+integration.svelte`
- `app/<app>/+app.ts` `app(spec)` (`shell: 'kiosk'` for shared devices), `+group.ts` `group(spec)`, `app/<app>/+<page>.page.svelte` (takes `ctx`)
- `agent/+agent.md`, `agent/+agent.external.md`, `agent/skill/<s>/+skill.md`, `agent/mcp/+<n>.mcp.ts` `mcp(spec)` (envoys are runtime `sys_envoy` rows)
- `i18n/+messages.ts` `messages(spec)`, `+<locale>.messages.ts`

Beside `src/`: `seed/+seeder.ts` `seeder(spec)`, `seed/public/**/<model>.json`, `seed/test/**/<model>.json`, `tests/*.test.ts`, `assets/`.

## Contracts

Start each role from its starter below; consult `bolt-contract` cards (`model.md`, `access.md`, `automation.md`, `sync.md`, `integration.md`, `page.md`, `behaviors.md`, `representation.md`, `test.md` — no `i18n.md`; i18n is in `authoring-tenant-workspace`, approvals/policies are in `norbital-platform`) only for extra fields and `workspace_lang` for anything left open (`{ op: 'type', type: ["import('@norbital-ai/ui').TableProps"] }`; single-arg specs via `Parameters<typeof import('pkg').fn>[0]`, model/integration `[1]`, sync `[2]`). Never write a throwaway file just to query `hover`/`completions`.

- Live names: `describe_workspace`, `workspace_read` (lists directories and reads files).
- **No `node_modules/` or `.norbital/`:** packages live in a shared host store and are unreadable via file tools. Inspect types with `workspace_lang` / `bolt-contract`; install exact releases with `workspace_install`.

## Studio protocol

1. Author in order: model, access, automation/sync, page, tests. Add a page only when the model's table and record sheet do not cover the task.
2. Edit with `workspace_write`, `workspace_edit` (pass `edits: [{ oldString, newString }]` to apply multiple hunks in one file in one call), `workspace_delete`, `workspace_move`. Edits stay in your working tree without checking. Run `workspace_diagnose` before `workspace_migrate` so model/schema errors are caught immediately (pass `{ path }` when fixing localized TS errors in 1–2 files; run full `{}` once before migrate/commit). After a schema change, run `workspace_migrate` to generate pending migrations into the working tree and test them on your preview database (with SQL checks before/after). Only `workspace_merge` migrates live.
3. After EVERY final edit (including `tests/*.test.ts` — Vitest does not run `tsc`), run BOTH full `workspace_diagnose {}` AND `workspace_test {}` (long runs report when finished) on the final working tree. Fix every failure; every automation and refused state needs a test.
4. Checkpoint with `workspace_commit` in any state; inspect history/diffs/versions with `workspace_history`.
5. `workspace_preview` builds the last commit, serves it and opens every page; `workspace_try` exercises automations on preview (no live integration links; prove sync decoding in tests, then create and start `sys_integration` on live after merge).
6. `workspace_merge` with the last commit, summary and capability ledger (`skip: reason` for omissions). Requires clean working tree, preview of that commit, and passing full `workspace_diagnose {}` + `workspace_test {}` on that exact commit (never skip either after a final edit); the merge queue replays on live automatically.

## Core principles

- **Model & UX economy (avoid sprawl):** Default to **4–8 core models** and **1–2 apps (3–6 pages total)**. Never map every prompt noun, config rule, or UI tab to its own table: inline thresholds, rules, line items, shifts, changeovers, and sub-configs as typed `json` / `custom_field` (or polymorphic `kind` models) unless independent lifecycle, FK targets, approvals, or cross-record queries genuinely require a separate table (see `authoring-tenant-workspace` `references/model-boundaries.md`). Delete unused starter models (such as `notes`) when replacing a blank workspace. Build an operational web app — never a landing/brochure home page with static "Step 1 / Step 2 / Step 3" instruction cards; the first page must show live records, KPIs, and actions.
- **Never duplicate built-ins:**
  - Access & approvals: `+team.ts`, `+<name>.policy.ts`, `ctx.approve`, `sys_approval` — never custom role/permission/approval models or hand-rolled auth checks.
  - Lifecycles: `kind: 'state'` with declared transitions, named `locked` constraints and policy `update.moves` — never shadow status tables or parallel state machines.
  - Live data: `PageBolt.query(...)` (live over SSE) — never manual refresh loops, `setInterval` polling or client refetch/cache state.
  - Platform primitives & UI behaviors: native audit/history, search indexes, filters, cursor paging, import/export, `enum_text`, `file` fields, auth/users/invitations, envoys/channels, write triggers (`on:`), durable waits (`ctx.wait`), `@norbital-ai/ui` (`Table`, `Board`, `RecordShell`, `Surface`, `Tabs`, `TabStrip`, `Sheet`, `Dialog`, `Popover`, `Tooltip`, `Combobox`, `Checkbox`, `TimeInput`/`TimeRangeInput`, `EventCalendar`), and `@norbital-ai/ui/behaviors` for EVERY custom interactive widget. **Never hand-roll** keyboard navigation/roving focus, Escape/outside dismiss, focus traps, menus, trees, grids, inline edit, drag/reorder/resize/panel groups, sliders, drawers, switch/radio/toggle/checkbox groups, token/trigger/file-drop/password/date-time/PIN/color inputs, pagination, clipboard, stick-to-bottom, debounce, or `localStorage` persistence — consult `skill { name: 'bolt-contract', file: 'behaviors.md' }` and `authoring-tenant-workspace` `references/behaviors-and-composition.md`, and expose custom widgets to Norbius with `register_control`.
- **Sync-first integrations (`integration-sync`):** poll and sync external systems of record exclusively inside `+<sync>.sync.ts` (incremental cursors/fingerprints that emit zero rows when idle); pages, reports, automations, transforms and agents read local synced models only (and local `sys_integration.status` via pure helpers). Direct on-demand live reads (still never background polling) apply only when the user explicitly opts out of continuous sync or when a full continuous mirror is unnecessary and fresh values are needed only at view time (`mode: 'call'` with `cache`) or when a report/agent run snapshots them (e.g. live FX/market quotes).
- **Scale-to-zero (Neon):** every safety-net `cron` depending only on workspace data declares `rest` (e.g. `rest: '24h'`) so idle tenants suspend instead of billing continuously. Prefer write triggers (`on: [{ model, verbs }]`) and `ctx.wait` over polling crons; poll only external systems without webhooks, and only inside `+<sync>.sync.ts`.
- **AI economy & accuracy (same job, lower cost, higher accuracy):** Design every AI automation to minimize LLM + billable tool (`web_search`) spend while raising accuracy: (1) handle deterministic filtering, parsing, math and dedupe in code before calling AI; (2) pick the cheapest accurate tier (`ctx.ai.sys_1.decide` for independent fixed-set classification/triage/scoring, `ctx.ai.sys_2.infer` only for synthesis/tool use with tight `steps` and `rules`); (3) maximize prompt-cache reuse — keep `system` + shared instructions static across calls and consolidate related work into a single structured `infer` call (e.g. one `infer` per entity returning all sections, scores, proposals and drafts instead of chaining cold calls that miss cache and repeat searches); (4) never pay twice — stamp completion (e.g. `researched_at`) and share one entity `ctx.schedule` dedupe key so sweeps never re-process completed records unless explicitly forced for one specific entity. Keep `src/agent/+agent.md` minimal (end-user domain rules only — never duplicate `[Catalogue]`, `KERNEL` or code rules; put code invariants in `src/agent/AGENTS.md`).
- **Data & query performance:** record IDs are monotonic UUIDv7 — paginate chronologically with `order_by: { id: 'desc' }` (or `'asc'`); pass explicit `limit` and narrow named `outputs`; batch lookups with `in` filters instead of N+1 `ctx.query` loops; link multi-model writes in one atomic `ctx.act` with `new_id(model)`.

## Rules

- Models expose guarded verbs only (`create`/`update`/`delete`/`import`); business operations are automations. Policies may grant `delete: {}` only on models that declare `delete: {}`, and state transitions use `update: { moves: 'all' }` or `moves: { <field>: ['<from>-><to>'] }`.
- Policies grant only declared model outputs/verbs and filter rows, never shape. Automations run as the system identity with their declared `policies` (`actor.*` matches nothing).
- Effectful `ctx` bodies are `function*` yielding `ctx` Effects; `try/catch` never catches a failed `yield*` (use `Effect.catch`/`catchTag`). Exact decimals (`decimal`/`money`) write and read as strings (`'10.00'`), never JS numbers (use Effect `BigDecimal` for math).
- **Zero-churn typing:** Always pass `{ctx}` to `<Table {ctx} of="..." />`, `<Board {ctx} ... />` and `<RecordShell {ctx} ... />`. Keep record IDs branded (`Id<'model'>`, `new_id('model')`, or read row `.id`) — never widen to `string` or use `as` assertions. Pass a read row directly as `update`/`delete` `target` instead of rebuilding `{ id, revision }`. Type write batches explicitly with `CreateInput<'model'>` / `UpdateInput<'model'>` from `@norbital-ai/bolt`, never use conditional spreads (`...(x ? { k: x } : {})`) inside `ctx.act` inputs, and set optional `ref` fields to `Id<'model'> | null` or omit them. `record_label` uses the row's own text/computed field (never a `ref` FK); `seq` patterns allow one `{0…}` counter plus `{yyyy}`, `{yy}`, `{mm}` only.
- **Bilingual workspaces (`languages: ['en', 'zh']`):** Use declared message keys (never literal English text) in `+app.ts` `title`/`description`/`pages.*.title`, and translate model/field/enum keys (`models.<m>.label|singular|fields.<f>|fields.<f>.<val>`) in `+<lang>.messages.ts`.
- **Default & sample rows on Studio merge:** `seed/public/` loads only during fresh workspace provisioning, NOT on `workspace_merge`. When shipping default rules, catalogues, or starter sample rows in Studio so live opens ready to use, insert them idempotently with deterministic UUIDs (`INSERT INTO <model> (id, ...) VALUES ('01900000-...', ...) ON CONFLICT (id) DO NOTHING;`) in your SQL migration (`id` is always the primary key; never use `ON CONFLICT (<non_unique_col>)`).
- `file` fields require `accept` and `max` (`KiB`/`MiB`/`GiB`/`KB`/`MB`/`GB`, no space). One-to-many uses a single `ref` on the child, never a `many: true` `ref` back-list on the parent.
- Named `constraints` take arrays for `unique`/`per` (`import_key: true` enables `import`); `computed` lives on fields; physical/search indexes live under `indexes`.
- Create/update transforms and per-verb effects receive `{ before, set, after, changed }` (read `c.after.x`, never `c.set.x ?? c.before.x`). Transforms return sets or `{ sets, with, on_approved }` in input order (`changes.map(({ set }) => set)` preserves unchanged sets); delete transforms return nothing or `{ with, on_approved }`. Approval lifecycle events arrive in `ctx.event`.
- Commit related writes in one `ctx.act({ '<model>.<verb>': inputs })`; update/delete targets carry selected rows with `revision`.
- `seed/test/assets.json` and `seed/public/assets.json` are reserved asset lists (never name model rows that). Credentials never enter source, seeds or model fields.
- Keep evolving rules, prompts, rubrics and thresholds in validated runtime configuration models rather than hardcoding in source.
- For large background sweeps (50+ records), queue runs and report status immediately instead of blocking in `wait` loops.
- Tests never set `timeout` or wait on wall clocks.
- Porting a system: `reference` once (or read archive), batch reads in `run_js` returning paths/domain keys/excerpts, map capabilities to Bolt, keep file syncs for imports/exports, and test another team member is denied when a record names its approver.

Detail: `authoring-tenant-workspace` indexes all references.

## Messaging, envoys & proposals

- Envoys are runtime `sys_envoy` rows deployed via `sys_integration.envoy` (no source envoy role). Inspect `describe_workspace { names: ['system'] }`, create rows natively, then open `integration.manage` via `page { path, configure }` for pairing. Never collect credentials in chat.
- Daily programmatic messages use a cron automation calling `ctx.send` on the active paired workspace account (narrowed with `instance_id`; fail if missing/ambiguous). Replies continue through the envoy; derive Sent state from `sys_message` status/`sent_at`, not queue admission.
- Keep merge/approval summaries to 1–2 short sentences (user impact + data risk); do not repeat what the native card already displays.
