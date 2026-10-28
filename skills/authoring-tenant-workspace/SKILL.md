---
name: authoring-tenant-workspace
description: >-
  Author Bolt tenant workspaces. Load for models, ref fields, policies,
  source teams, apps and pages, automations, integration definitions and model syncs,
  integration connections, envoys, custom fields, seeds, `$bolt`, `@norbital-ai/ui`, template
  metadata, or the `src/` file layout.
---

# Authoring Bolt Tenant Workspaces

A workspace is a directory whose `src/` holds `+` files. Each `+` file is a **compiler role**: it
exports its declaration or supplied UI according to that role.
Names come from paths, never from file contents. Everything without a `+` is an ordinary module.
`bolt build` turns the tree into a portable artifact. Colony hosts it by default (tethered, nothing to configure); an
untethered host supplies every facility itself. See [hosts-and-facilities.md](references/hosts-and-facilities.md).

Work from the installed Bolt declarations and the `@norbital-ai/bolt/docs` corpus when an API is uncertain. In the realm,
the declarations and compiler role table live in `oss/packages/bolt/src/decl/` and
`oss/packages/bolt/src/compiler/discover.ts`. These references explain authoring choices; they do
not make an unimplemented API available.

## Mental model

Start with the model people work on: its fields, relations, read and write layers,
search, syncs, notices and business automations. A model is the entity and its exposed
contract; a representation presents one record through the shared controller. Add a page only
when it supports a distinct task beyond the model's normal view.

Prefer fewer entities. Parent-owned structured values belong in typed JSON or a custom datatype
unless identity, lifecycle, permissions, history or relational querying justify another model.
Configurable business choices belong in authorized runtime records; source defines the validated
language and the execution contract. Use Bolt's grants, approvals, state locks, relationships,
guarded write verbs, views and integration lifecycle rather than rebuilding them in template code.

## Terms

Each word names one thing:

| Term        | Means                                                                                                                | Where                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Environment | An operating environment: local, staging or production, and a tenant environment inside one.                         | The operator CLI that resets and operates environments; never a workspace setting. |
| Secrets     | Encrypted values stored in the tenant database, read by server code.                                                 | `src/+secrets.ts` with `secrets({ NAME: { label } })`.                             |
| Server code | Transforms, policy checks, automations, syncs, integrations and page loaders.                               | The `ctx` each receives; declarations from `@norbital-ai/bolt`.                    |
| Page SDK    | What browser-side page code calls.                                                                                   | `@norbital-ai/bolt/page`, imported in pages as `$bolt`.                            |
| Device      | What the shell running the page provides: location, notifications, push, background notices, opening external links. | `bolt.device` in pages; a shell installs `window.boltDevice`.                      |
| Shell       | The container a workspace runs in, which implements Device.                                                          | The web shell built into Bolt; native apps from `@norbital-ai/app-shell`.          |
| Host        | The server that runs a bundle and supplies its facilities: Colony (tethered, the default) or an untethered host.      | `@norbital-ai/bolt/facilities`; the Host API.                                      |

## Reference routing

| Task                                                                                              | Reference                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Deciding entity boundaries, inline values and runtime-configured business behaviour**           | [model-boundaries.md](references/model-boundaries.md)           |
| Field kinds, ref fields, layer maps, write callbacks, search and syncs                            | [models-and-modeling.md](references/models-and-modeling.md)     |
| Dates, instants, periods, the workspace zone, date filters                                        | [dates-and-time.md](references/dates-and-time.md)               |
| Reads: `bolt.query`, read requests, live and once, paging, `src/lib` helpers, no N+1              | [data-access.md](references/data-access.md)                     |
| Apps, pages, groups, automations, policies, agents, integration definitions and runtime instances | [apps-and-server-roles.md](references/apps-and-server-roles.md) |
| **What the platform already renders** — the page shape, toolbar, search, record sheet: never rebuild | [built-ins.md](references/built-ins.md)                         |
| **Where things go on a page** — header, actions, tabs, forms (readonly vs disabled), inner scroll | [app-structure.md](references/app-structure.md)                 |
| Template UI review: disclosure, alignment, useful charts and reuse of shared controls             | [ui-standard.md](references/ui-standard.md)                     |
| Why the layout system is shaped this way                                                          | [interface-ideology.md](references/interface-ideology.md)       |
| Composition, scrolling, scroll traps                                                              | [layout-and-scrolling.md](references/layout-and-scrolling.md)   |
| Controller UI: inline, `$derived`, no UUIDs                                                       | [controller-surfaces.md](references/controller-surfaces.md)     |
| Padding, gaps, the app inset                                                                      | [padding-and-spacing.md](references/padding-and-spacing.md)     |
| Headings, labels, captions                                                                        | [typography.md](references/typography.md)                       |
| `bolt` verbs, `.norbital/`, schema changes                                                        | [generated-and-build.md](references/generated-and-build.md)     |
| Tethered vs untethered, facilities, needs, `norbital.host.ts`, `bolt dev --host`                  | [hosts-and-facilities.md](references/hosts-and-facilities.md)   |
| Message catalogs, locales, the raw-text rule                                                      | [internationalization.md](references/internationalization.md)   |
| Template manifest, README, marketing thumbnail                                                    | [template-repository.md](references/template-repository.md)     |
| Authoring in Studio: changes, previews, merges, rollbacks, checks                                  | [studio.md](references/studio.md)                               |

Read only the relevant reference. Policy and approval behaviour is in the `norbital-platform` skill;
tests are in `authoring-test-suites`.

**Template authoring defaults:** read [built-ins.md](references/built-ins.md) before any page and reuse what it lists
(a search box is `search.text` on the model, page scope is `AppShell` `actions`); inline duplicated UI to keep the file count small; DRY only for
substantially big components; describe UI with `$derived` (model views own live reads — no subscription `$effect`);
paint useful human information only; prefer one read request with its layers over N+1; never show system ids.
For ordinary data entry, suggest a compact, polished, accessible form with meaningful groups and progressive
disclosure. This UI concept is a default suggestion: choose steps, widgets or an interactive editor
when they fit the task better. See [form layout defaults](references/app-structure.md#form-layout-defaults).

## The file tree

Each model has one named folder and one declaration. Names match `^[a-z][a-z0-9_]*$` and
come from paths. A declaration with bodies repeats its path-derived name as its first argument;
`bolt check` refuses a mismatch. Every callback sits inside its declaration on its trigger.

```text
<workspace>/
├── package.json, tsconfig.json, norbital.template.json
├── assets/                              marketing thumbnail + runtime assets
├── seed/                                model rows, assets, optional seed.ts
│   └── test/                            the test pack: synthetic rows the template's tests seed from
├── tests/                               native TestWorkspace + @effect/vitest
├── .norbital/                           generated, never edited or committed
└── src/
    ├── +workspace.ts                    zone, locale, currency, apps, AI, connections
    ├── +secrets.ts                      secret names, values supplied at runtime
    ├── data/
    │   ├── model/<name>/+model.ts       storage, refs, exposure and inline logic
    │   ├── model/<name>/+representation.svelte
    │   └── custom_field/<name>/+definition.ts, +renderer.svelte
    ├── access_control/team/+team.ts
    ├── access_control/policy/+<name>.policy.ts
    ├── integration/<name>/+integration.ts, +integration.svelte
    ├── automation/+<name>.automation.ts
    ├── agent/                           briefs, skills, envoys and MCP declarations
    ├── app/<app>/+app.ts, +<page>.page.svelte
    │             +<page>.page.server.ts, <page>.page.data.ts for SSR
    ├── app/<group>/+group.ts
    ├── kiosk/<name>/+kiosk.ts, +<page>.page.svelte
    ├── i18n/+messages.ts, +<locale>.messages.ts
    └── lib/                             ordinary helpers, no compiler roles
```

None of these exist; do not author them: `src/models/`, `src/datatypes/`,
`src/functions/`, `src/apps/`, `src/+agents.md`,
`+anonymous_limits.ts`, `bolt.host.ts`, `vite.config.ts`, `.norbital/migrations/`, JSON message
catalogs, `$types.js`, Promise-based guest handlers.

## The declaration contract

| Declaration               | Callbacks inside the literal                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `model(name, spec)`       | `create.transform`, `update.transform`, `delete.check`, `search.indexes.*`, `notify`, `syncs.*`                                  |
| `customField(name, spec)` | `validate`                                                                                                                        |
| `policy(spec)`            | `check` on each `create`, `update` and `delete` grant                                                                             |
| `integration(name, spec)` | `test`; the connection's data includes `webhook.verify` and `rate`                                                                |
| `automation(name, spec)`  | `run`                                                                                                                             |
| `team(spec)`              | none                                                                                                                              |

A model holds storage and exposure together. Relations are `kind: 'ref'` fields on the model
holding the foreign key; policies, views, reads and seeds name models. Syncs live on models and
name a file or integration connection. Everything effectful uses a generator and `yield*`;
search callbacks and validators stay pure. Read the relevant declaration in the
installed package before using an uncertain option.

`read`, `create.columns` and `update.columns` are **layer maps**: flat objects keyed by path,
`'orders'` the root, `'orders.customer'` and `'orders.lines'` the relations under it, at most five
levels, each parent declared too. `read: 'all'` is the root with every field. A model without
`read` is no read root but may be another model's layer. A write layer is a many-relation (child
rows) and never lists the key tying it to its parent. A model declares no named queries.

```ts
// src/data/model/orders/+model.ts
import { model } from "@norbital-ai/bolt";
export default model("orders", {
  description: "Customer orders.",
  label: "number",
  fields: {
    number: { kind: "seq", pattern: "SO-{yyyy}-{0000}" },
    customer: { kind: "ref", to: "customers", inverse: "orders" },
    notes: { kind: "text", optional: true },
  },
  read: {
    orders: { fields: ["number", "customer", "notes"] },
    "orders.customer": { fields: ["name", "code"] },
  },
  create: {
    columns: { orders: ["customer", "notes"] },
    transform: function* (rows, ctx) {
      if (rows.some((row) => row.notes === ""))
        return yield* ctx.refuse("Notes cannot be blank.", { field: "notes" });
      return rows;
    },
  },
  update: {
    columns: { orders: ["notes"] },
    transform: function* (changes, ctx) {
      if (changes.some(({ set }) => set.notes === ""))
        return yield* ctx.refuse("Notes cannot be blank.", { field: "notes" });
      return changes.map(({ set }) => set);
    },
  },
});
```

## Where code runs

Write callbacks run on every path, including imports, upserts, resubmits, restore and nested owned
children. A create receives rows; an update receives `{ before, set }` and returns sets; delete
checks receive stored rows and may refuse. Seed restores and derived roll-ups bypass callbacks.
Children run their own callbacks after the parent's. Prefetch before mapping: a callback may
read at most twice through `ctx.db.query`, as the workspace, and never writes or performs I/O.
Each 1000-row chunk gets one callback per verb per model and its own 2 s CPU budget; the whole
file remains one transaction. SQL writes are set-based, O(N/1000), with history and approvals.

A computed answer is a read request plus a pure, browser-safe `src/lib` helper: the page calls
`bolt.query({...})` then the helper, server code calls the same helper over `ctx.query({...})`,
and a heavy export is a `with: 'file'` sync. Business operations are named
automations with explicit typed inputs, `ctx.act`, `ctx.schedule`, `ctx.notify` and `ctx.refuse`. They
run as their `runAs` policies (or `'trigger'` for started-only runs) and add business I/O:
`request`, `send`, `web`, `files`, `convert`, `ai` and `geo`. Remote sync reads/writes are trusted,
return changes/acknowledgements and request through their own instance. File sync callbacks retain the importing/exporting caller's read scope and masks;
context never elevates authority. Notify callbacks read
as the workspace after commit and return notices. Policy checks read as the workspace (at most
twice through `ctx.db.query`), never write or perform I/O, and return a verdict.
Page-server loaders have caller-scoped reads only.

Model writes are only `create`, `update`, `delete` and keyed `upsert`, and every one takes an
array: `ctx.act('orders.create', [{ … }])`, `[{ target, set }]`, `[{ target }]`. Name business operations
as `<model>_<operation>` automations with explicit typed IDs/inputs. A started-only run uses
`runAs: 'trigger'` when it must retain the caller's authority, with explicit `policy.automations`
permission to start it and grants for every read and write it uses. Use `ctx.act.many(...)`
for independent atomic writes and the parent's write layers (nested child rows) for dependent creates. Dependent reads
and writes use `ctx.transaction(function* (tx) { ... })`, with `tx.query` and guarded `tx.act`,
read-your-writes and one commit. Its fixed five-second native session requires PostgreSQL 17+;
PGlite refuses it. Keep I/O outside; no async callback, captured Effects, nesting or manual
observations. Inner answers are provisional; the outer result alone is committed or held, with
no callback output in the held arm. See [data access](references/data-access.md). A whole durable
automation can contain several transactions.

Every invocation has 2 s cumulative CPU, 256 MiB heap, 40 facility crossings (10,000 for an
automation) and a 20 s idle deadline per host response, refreshed by progress. CPU admission is
released while awaiting I/O. Batch reads as one read request,
`ctx.query({ orders: { … }, 'orders.lines': {}, settings: { limit: 1 } })`, or `ctx.db.query({ … })`
inside write callbacks, policy checks and notify. Guest helpers use `Effect.fnUntraced` or
`Effect.fnUntracedEager`; the application owns execution. Decode unknown provider data once,
retain native ids/decimals/dates inside and never use casts, `any` or JSON round trips to erase them.

`bolt sync` emits declaration data as literal types into `.norbital/names.ts`, without bodies or
self-import cycles. `bolt dev` synchronizes on save; `bolt check` synchronizes first. A new field
appears in body types after the next sync. Details: [models](references/models-and-modeling.md).

## The browser: `$bolt` and `@norbital-ai/ui`

A page uses the generated `$bolt` module:

```svelte
<script lang="ts">
	import { bolt } from '$bolt';
	import { Table } from '@norbital-ai/ui';
	import { AppShell } from '@norbital-ai/ui/layout';
</script>

<AppShell icon="lucide:package" title={bolt.t('orders.title')} description={bolt.t('orders.description')}>
	<Table of="orders" where={{ status: { ne: 'shipped' } }} columns={['number', 'customer', 'status', 'total']} />
</AppShell>
```

`bolt.query` takes one read shape, the read request: a layer map whose keys without a dot are
roots and whose deep keys are declared layers, `bolt.query({ orders: { where, fields, orderBy, limit }, 'orders.customer': {} })`,
answering `{ orders: { rows, next } }`. A record is `where: { id: { eq: id } }, limit: 1`; an index
search is a root `search`. Every list defaults to `limit` 10,000. Its `Query<T>` is
live when `.current`, `.loading` or `.error` is read reactively, once when awaited outside a
reactive context, and an Effect when composed with `yield*`. `aggregate` and `history` share that
contract. Use `$derived` to capture inputs; identical reads share their subscription. Do not mirror
query state or create a subscription `$effect`. Time is explicit with
`bolt.clock('day').today` or `bolt.clock('minute' | 'hour').now` passed as query inputs.

Mutations use `bolt.act` and `bolt.start`, with `$bolt`'s `run`, `fork` and `attach` execution edge.
Success is `committed` or `pendingApproval`; refusals, conflicts and unknown outcomes are typed
failures. Effects stay outside `$state`. `bolt.convert`, `upload`, `fileUrl`, `runs`,
`approvals.decide`, `restore.preview/run`, `device`, `actor`, `org`, `t` and `href` serve their
specific namespaces. See [data access](references/data-access.md).
`bolt.actor` is who is looking at the page
(`kind`, `id`, `teams`, `admin`, `external`, `party`); key rows by `actor.id`, never by a label. `bolt.org`
is the workspace's display name and logo (`{ name, logo }`), on public pages too — show the name
from there, never a hard-coded string.

Custom write handlers must distinguish `pendingApproval` from `committed`: the change is written but held by
its request until approved. Reuse native approval views and the inbox, and do not report it as final.
A custom list shows `row.$approval` (`requestId`, `state`, `step`, `steps`, `requestedBy`); shared `Table` and `Board` accent it themselves.

Model views infer names and row types from their declared source props. `Table` and related
views support model, `Query` or row sources where their types say so; `Form`, `RecordShell` and
`Matrix` have distinct contracts. `Matrix` is model-backed, not an inline JSON-list editor.
Use shaped-data editors for parent-owned values. Layout primitives and `AppShell` come from
`@norbital-ai/ui/layout`; `CaptureKit` from `@norbital-ai/ui/capture`. A page never imports a role
module: it opens a record with `RecordShell of="<c>" id={id}` and a create sheet with
`RecordShell of="<c>" mode="create"`.

Every page sits in `AppShell`; where each thing goes is fixed by
[app-structure.md](references/app-structure.md). Compose layout only with `@norbital-ai/ui/layout`
primitives; raw layout classes are doctor errors (`layoutPack`). Padding has one owner, the
scrollport ([padding-and-spacing.md](references/padding-and-spacing.md)).

**App-surface completion gate.** Before calling UI complete: match a sibling app's media and inset;
count exactly one page-edge padding owner and one scroll owner per axis; render one normal-width and
one narrow state and look at them — compilation cannot prove visual correctness.

## Access in one paragraph

A policy (`src/access_control/policy/+<name>.policy.ts`, named by its file) holds `grants` per model
(`read history create update delete moves`), `automations` a holder may start, `capabilities`
(`apps tools mcp skills`) and `limits`. Grants are layer maps typed from the model's own
declaration: `read` is `true` or `{ orders: { where?, fields? }, 'orders.lines': { where?, fields? } }`
(a deeper `where` filters that layer only; an unnamed declared layer reads in full); `create` and
`update` are `true` or `{ columns?: { orders: [...], 'orders.lines': [...] }, check? }`; `delete` is
`true` or `{ check? }`. Authority is per access point: the root's policy alone guards a read or
write and every layer under it; the related model's policies are never consulted on that path.
Source teams link to authored policies. Members are runtime identities affiliated
with those source-defined teams; team/policy definitions are not edited through a runtime UI.

`columns` is checked before any guest code. A grant's `check: function* (rows, ctx)` then judges the
whole batch, nested layers included (create trees; `{ before, set }` per update; stored rows per
delete), and returns `ctx.allow()`, `ctx.deny(message, { row, path, field })` or
`ctx.approve((flow) => flow.step(name, { teams?, users? }) …)` with optional `if`/`else` and
`supersededBy`. A scope that hops a relation is one keyed `ctx.db.query({...})` read inside the
check (at most two). Among a holder's policies any allow executes; otherwise the first approve in
the team's policy order opens that flow; otherwise the first deny refuses.
A routed write commits provisionally, snapshots its flow and locks the held records.
Reject restores its checkpoint. Request changes keeps data for the requester; saving resubmits.
Automations, integrations and envoys never approve. Use `bolt.approvals.decide(id, { decision,
reason? })` for approve, reject or requestChanges; reasons are required for the latter two and
for superseding approval. Comments and withdrawal have no independent operation. Reuse native
requests, timelines, revisions and record controls instead of authoring runtime route objects.

Teams use `src/access_control/team/+team.ts`. `team` takes an exact handle map, with each entry a
policy list or an object containing `policies` and optional `name`/`parent`. Handles are exact
identifiers; names are display only. The parent graph
scopes data without inheriting policies or approval rights. The native `sys_team` catalogue is a
read-only source projection preserving FK/query compatibility; it is never seeded or edited for
authority. Do not author `sys_assignment` objects. Bolt's own suite tests the approval mechanism; a
template does not re-test it. Details: `norbital-platform` → `approvals-and-policies.md`.

## Workflow

```bash
# inside the workspace
bolt sync         # regenerate literal declaration types
bolt check        # sync, then every error of every stage in one run: layout, names, bundle, schema, then tsc or svelte-check
bolt test         # @effect/vitest with TestWorkspace.layer
bolt build        # .norbital/{bundle,source,seed} + release.json: packs base, test (when seed/test/ exists) and, with --bank=<bank checkout>, the private sample
bolt dev          # norbital.host.ts (or --host=<file>): untethered with page HMR; none: tethered, rebuild on save + page HMR in local Colony
```

Exit codes: 0 ok, 1 author error, 2 tool failure. Inspect the actual compiler and Svelte diagnostics;
a successful process does not prove that a UI warning or manual acceptance concern is resolved.

## Verify behaviour and inspect the result

Prove changed rules through the authored code (`TestWorkspace.layer({ root })`, `yield* t.as(member).act(…)` inside `it.effect`).
A test proves one of the workspace's own mechanisms (a calculation, a guard, a write callback) on
small synthetic input, within 2 s, with no timeouts, sleeps, spawns or builds. `TestWorkspace.layer({ root })`
seeds from the template's `test` pack (`seed/test/`): small synthetic rows written for its mechanisms. It never
loads the public `base` pack or the bank's `sample`; never put bank or customer data in it. Seed correctness
matrices, absence checks, Svelte mounts and layout/markup/CSS assertions are not tests; see
`authoring-test-suites`.
Inspecting a running standalone artifact is a probe: exercise the task, check the resulting records
and inspect desktop and narrow layouts, from uncommitted `.tmp/` scratch. Fix what it finds in source.

## Look at it: one workspace, standalone

From the realm root, `serve` runs `bolt build`, then the example untethered host `bolt-server` on a snapshot of the artifact with
an embedded PGlite, local files, and a loopback mail catcher that prints sign-in codes to the log:

```bash
bun run env -- serve --template=hr-payroll                 # sample pack from the private seed bank
bun run env -- serve --template=hr-payroll --seed=base   # the template's public `base` pack
bun run env -- serve --template=./path/to/workspace --port=4181 --seed=none
bun run env -- status                                      # lists it; kill <pid> stops it
```

`--template` is a directory name in either template repo, or a path. The agent answers when Colony's
`.env` carries `COLONY_AI_API_KEY` and a `COLONY_AI_SYS_2_*` model; `serve` hands them to `bolt-server`
as `BOLT_AI_SYS_1_*` / `BOLT_AI_SYS_2_*`.

**No data leaks.** The bank never enters a test. A serve host binds to 127.0.0.1, its database and
files live in a temporary directory removed when it stops, and it is a demo, not acceptance evidence.
Never copy bank rows into `seed/`, a screenshot, a transcript or a bug report: describe the row, do
not paste the person.

Before finishing, run `bolt check` and the focused test.
