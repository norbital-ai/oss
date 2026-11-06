---
name: bolt-primer
description: Build a Bolt workspace with no other skill - source roles, contract queries, authoring order, pitfalls.
---

This page and `workspace_lang` are enough for a normal build. Read a reference only for a diagnostic this page does not resolve. Ask for several types in one `workspace_lang` call.

## Roles

A `+` file is a compiler role, default-exporting its declaration; its path is its name (`^[a-z][a-z0-9_]*$`, folders singular). Other files are plain modules. Under `src/`:

- `+workspace.ts` `workspace(spec)`: zone, locale, currency, apps, AI, connections
- `+secrets.ts` `secrets(spec)`: secret names
- `data/model/<name>/+model.ts` `model(name, spec)`: fields, reads, writes, state, search, syncs. Folders nest; the leaf names it. `+representation.svelte` beside it: record view
- `data/custom_field/<name>/+definition.ts` `customField(name, spec)`, `+renderer.svelte`: value type
- `access_control/policy/+<name>.policy.ts` `policy(spec)`: what holders may do
- `access_control/team/+team.ts` `team(spec)`: team handles to policies
- `automation/+<name>.automation.ts` `automation(name, spec)`: job with its own policies
- `integration/<name>/+integration.ts` `integration(name, spec)`, `+integration.svelte`: connection, setup
- `app/<app>/+app.ts` `app(name, spec)`: label and `pages`; `+group.ts` `group(name, spec)`
- `app/<app>/+<page>.page.svelte`: page, `import { bolt } from '$bolt'`; `+<page>.page.server.ts` `pageServer(spec)`: loader
- `kiosk/<k>/+kiosk.ts` `kiosk(name, spec)`: standalone surface, its own pages
- `agent/+agent.md`, `agent/skill/<s>/+skill.md`: brief, skill
- `agent/envoy/+<id>.envoy.ts` `envoy(spec)`; `agent/mcp/+<n>.mcp.ts` `mcp(spec)`
- `i18n/+messages.ts` `messages(spec)`, `+<locale>.messages.ts`

Beside `src/`: `seed/+seeder.ts` `seeder(spec)`; rows `seed/public/**/<model>.json`, `seed/test/**/<model>.json`; `tests/*.test.ts`; `assets/`.

## Contracts

`bolt-contract` is the API authority: `skill { name: 'bolt-contract', file: 'model.md' }`, one generated card per role (model, access, automation, sync, page, test). Read a role's card once, before writing that role.

`workspace_lang` answers only what a card leaves out:

- A type: `{ op:'type', type:["import('@norbital-ai/ui').TableProps"] }`, several at once. `import('pkg').X` works only for exported types; a value is `typeof import('pkg').x`. Packages: bolt, ui, std, bolt-cli.
- A function's spec: `Parameters<typeof import('pkg').fn>[1]`; `[1]` for `(name, spec)`, `[0]` for `(spec)`. Narrow with `X['field']`.
- `completions`, `hover`, `signature` need path, line, column, in your working tree: an edit commits nothing, so a probe is a file.
- Live names: `describe_workspace`, `workspace_list`.

## Protocol

1. Author in order: model, access, automation or sync, page, tests. Add a page only for a task the model's table and record sheet do not cover.
2. Edit with `workspace_write`, `workspace_edit` and `workspace_move`, one file a call. Edits stay in your working tree. After a schema change `workspace_generate` writes the generated migrations into the working tree; a diagnosis fails until they exist.
3. `workspace_commit` with a message, in any state; new commits join your line on top of live. If live moved, `workspace_rebase` replays them on top of it, migrations too: a merge never does, and reverting to redo work never helps.
4. `workspace_diagnose` runs the diagnosis on the working tree. `workspace_test` runs the tests in the background: keep working, and the result reaches you as a system message at your next step, or collect it with `wait`. Both run by hand. Fix what they name. Tests `empty` proves nothing: every automation and refused state carries a test.
5. `workspace_preview` builds the last commit, serves it and opens every page. `workspace_try` runs each automation once on the preview and reads what it changed. A preview binds no integration links: a sync's decoding is proved in a test. After the merge, create its connection on live with `sys_integration.create { integration, name }`, start it, and read the rows.
6. `workspace_merge` with the last commit, a summary and a ledger line per capability: what implements it, or `skip: reason`. It needs no uncommitted edits, commits on top of live, a passed diagnosis and passed tests on that commit, and its preview; it runs neither.

## Rules

- A model exposes guarded verbs only. A business operation is an automation.
- A policy can only grant a verb the model declares; it filters rows, never shape.
- An automation runs with its declared `policies`, never its starter's; `requestor.*` there matches nothing.
- Effectful bodies are `function*` and `yield*` their `ctx` Effects.
- Decimals in policy and model code use `dec` values from the decimal module, never plain numbers.
- Model key options (`key`, `unique` fields, `noOverlap` key) take arrays.
- `seed/test/assets.json` and `seed/public/assets.json` are the reserved asset list: never name seed rows that, even for a model called assets.
- Migrations are generated by the build: never hand-write one. Never edit `.norbital/`.
- Credentials never enter source, seeds or model fields.
- Never rebuild search, filters, paging, import/export, approvals, history or label maps: the views render them.

Detail: the `authoring-tenant-workspace` skill indexes every reference.
- A test sets no `timeout` option and never waits on the wall clock: the test lint refuses the run even when every case passes.
- Porting a system: `reference` its repository first, then read its schema, routes, jobs and permissions with `read_file` (a script over `tool('read_file', …)` reads many at once). Inventory every capability, map each to a Bolt mechanism, build from that, never from memory of the product. Import and export carry over as a file sync per model that had them.
