---
name: bolt-primer
description: Build a Bolt workspace with no other skill - source roles, contract queries, authoring order, pitfalls.
---

This page, its starters at the end and `workspace_lang` are enough for a normal build: read no other skill first. Read a reference only for a diagnostic this page does not resolve. Ask for several types in one `workspace_lang` call.

## Roles

A `+` file is a compiler role, default-exporting its declaration; its path is its name (`^[a-z][a-z0-9_]*$`, folders singular). Other files are plain modules. Under `src/`:

- `+workspace.ts` `workspace(spec)`: zone, locale, currency, apps, capabilities
- `+secrets.ts` `secrets(spec)`: secret names
- `data/model/<name>/+model.ts` `model(spec)`: fields, reads, writes, state, search, `effect` (work after a committed write). Folders nest; the leaf names it. `+representation.svelte` beside it: record view; `+<sync>.sync.ts` `sync('<model>', '<sync>', spec)`: a file or remote sync
- `data/custom_field/<name>/+custom_field.ts` `custom_field(spec)`, `+renderer.svelte`: value type
- `access_control/policy/+<name>.policy.ts` `policy(spec)`: what holders may do
- `access_control/team/+team.ts` `team(spec)`: team handles to policies
- `automation/+<name>.automation.ts` `automation(spec)`: job or call with its own policies; `agent` controls its use as a tool
- `integration/<name>/+integration.ts` `integration(spec)`, `+integration.svelte`: connection, setup
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

- A type: `{ op:'type', type:["import('@norbital-ai/ui').TableProps"] }`, several at once. `import('pkg').X` works only for exported types; a value is `typeof import('pkg').x`. Packages: bolt, ui, std, bolt-cli.
- A declaration's spec: `Parameters<typeof import('pkg').fn>[0]`; its file supplies the name. Narrow with `X['field']`. Models and integrations use their generated per-file binding, not a root declaration imported back from their source.
- `type` answers any shape with no file. `completions`, `hover`, `signature` need path, line, column of a file you are writing: a file written only to ask is a wasted edit.
- Live names: `describe_workspace`, `workspace_list_dir`.

## Protocol

1. Author in order: model, access, automation or sync, page, tests. Add a page only for a task the model's table and record sheet do not cover.
2. Edit with `workspace_write`, `workspace_edit` and `workspace_move`, one file a call, or `workspace_patch`, any number of files in one call. Edits stay in your working tree and check nothing: finish the source, then diagnose. After a schema change `workspace_generate` writes the generated migrations into the working tree; a diagnosis fails until they exist. `workspace_migrate` runs them on your own workspace's database, with SQL reads before and after, so you see what they do to real rows. Only a merge migrates live.
3. `workspace_diagnose` runs the diagnosis on the working tree. `workspace_test` runs the tests; a long run goes on in the background and reports by itself. Both run by hand. Fix what they name. Tests `empty` proves nothing: every automation and refused state carries a test.
4. `workspace_commit` with a message, in any state; new commits join your line on top of live. `workspace_rebase` replays them on top of live, migrations too, when you want to test against live as it is now; a merge never needs it. Reverting to redo work never helps.
5. `workspace_preview` builds the last commit, serves it and opens every page. `workspace_try` runs each automation once on the preview and reads what it changed. A preview binds no integration links: a sync's decoding is proved in a test. After the merge, create its connection on live with `sys_integration.create { integration, name }`, start it, and read the rows.
6. `workspace_merge` with the last commit, a summary and a ledger saying for each capability what implements it, or `skip: reason`. It needs no uncommitted edits and a preview of that commit, and is refused over a known failed diagnosis or failed tests. Merges land one at a time: the queue replays your commits on live as it stands, runs any diagnosis or tests that head lacks, and checks again if the replay changed anything.

## Rules

- A model exposes guarded verbs only. A business operation is an automation.
- A policy can only grant a verb the model declares; it filters rows, never shape.
- An automation runs with its declared `policies`, never its starter's; `actor.*` there matches nothing.
- Effectful bodies are `function*` and `yield*` their `ctx` Effects.
- Decimals in policy and model code use `dec` values from the decimal module, never plain numbers.
- Named constraints take arrays for `unique` and `per`. Mark one unique constraint `import_key: true` for matching imports. Computed expressions live on fields; physical and search indexes live under `indexes`.
- Each create/update transform and per-verb effect receives `{ before, set, after, changed }` changes. Return sets or `{ sets, with, on_approved }` from create/update transforms; a delete transform returns nothing or `{ with, on_approved }`. Effects receive approval lifecycle details in `ctx.event`.
- Commit related writes through one `ctx.act({ '<model>.<verb>': inputs })` map. Update/delete targets carry selected rows and their revisions. There are no `many`, `checked`, upsert or transaction alternatives.
- `seed/test/assets.json` and `seed/public/assets.json` are the reserved asset list: never name seed rows that, even for a model called assets.
- Migrations are generated. Edit one only to move data: the schema must arrive at what the models declare. Never edit `.norbital/`.
- Credentials never enter source, seeds or model fields.
- Never rebuild search, filters, paging, import/export, approvals, history or label maps: the views render them.

Detail: the `authoring-tenant-workspace` skill indexes every reference.
- A test sets no `timeout` option and never waits on the wall clock: the test lint refuses the run even when every case passes.
- Porting a system: `reference` its repository first, then read its schema, routes, jobs and permissions with `read_file` (a script over `tool('read_file', …)` reads many at once). Inventory every capability, map each to a Bolt mechanism, build from that, never from memory of the product. Import and export carry over as a file sync per model that had them.

## Messaging and envoys

Envoys are runtime `sys_envoy` rows, deployed through `sys_integration.envoy`. Do not look for an envoy source declaration or assume a contract filename. `describe_workspace { names: ['system'] }` returns available setup capabilities and account IDs. Create the envoy and its workspace account through native records, then open `integration.manage` with `page { path, configure }` for the person to pair it. Never collect credentials in chat.

A daily message is a cron automation using `ctx.send` through the intended active, paired account. Resolve it from runtime records, narrow its definition with `instance_id`, and fail clearly if missing or ambiguous. Recipient replies continue through the deployed envoy in the same conversation. Confirm queue admission separately from provider delivery; a timeout may be uncertain and a retried automation may repeat a committed send.

## Asking to apply a change

Write the approval summary in one or two short sentences: what changes for the person and any material data risk. Keep evaluation scores, schema inventories, commit messages and test logs in the work evidence. The native card already presents the version, measured data changes and decision buttons; do not paste the same proposal again in an assistant reply. Let the person use the card.
