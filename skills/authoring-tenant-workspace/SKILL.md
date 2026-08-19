---
name: authoring-tenant-workspace
description: >-
  Author filesystem-first Bolt tenant workspaces in the public OSS repository. Load for collections,
  custom types, apps, automations, remotes, seeds, generated $types, the unified $bolt/client,
  temporal values, filters, client rendering, and template repository metadata including the
  marketing thumbnail (`assets/thumbnail.svg`).
---

# Authoring Bolt Tenant Workspaces

Bolt tenant workspaces are plain Vite projects. Authors write `src/` plus `.agents/skills/` for Agent
Skills; the Bolt filesystem compiler
derives the registry, workspace, client, loaders, and local types under `.norbital/`. Never hand-author
assembly or generated output. The sealed authoring contract is the
[Bolt authoring package](https://github.com/norbital-ai/oss/blob/main/packages/bolt/src/authoring/index.ts).

## Live checkpoint redeploy

Local `/app/...` tenants run an immutable release artifact, not editable OSS source via HMR. After
publishing a runtime or template release, consume the new release in Colony and restart the dev
bootstrap before reporting success. The Colony dev bootstrap converges on every start — it seeds the
tenant from each workspace under `COLONY_WORKSPACE_ROOTS`, compiles the checkout with `bolt sync`, builds and publishes a
release artifact, routes it, and provisions and migrates the tenant database when a Postgres URL is
set. There is no separate `tenant:update` step; restart `pnpm --filter colony dev` after
`pnpm yalc:link` (or a template publish) and hard-refresh the iframe.

`+seed.ts` initializes new tenants; it does not evolve deployed data. For an existing tenant, diff the
authored models against the migration lineage and write the next entry with `pnpm exec bolt migrate`,
then edit its SQL before deploying through Colony.

## Reference routing

| Task                                                                    | Reference                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Collections, relationships, hooks, values                               | [collections-and-modeling.md](references/collections-and-modeling.md) |
| Dates, clock times, timestamps, filters                                 | [dates-and-time.md](references/dates-and-time.md)                     |
| Queries: `$derived`, no N+1, batching                                   | [data-access.md](references/data-access.md)                           |
| Apps, client, automation, remotes, seed                                 | [apps-and-server-roles.md](references/apps-and-server-roles.md)       |
| Why the layout system is shaped this way                                | [interface-ideology.md](references/interface-ideology.md)             |
| Composition, scrolling, scroll traps                                    | [layout-and-scrolling.md](references/layout-and-scrolling.md)         |
| Controller UI: inline, `$derived`, no UUIDs                             | [controller-surfaces.md](references/controller-surfaces.md)           |
| Padding, gaps, the app inset                                            | [padding-and-spacing.md](references/padding-and-spacing.md)           |
| Headings, labels, captions: which type class                            | [typography.md](references/typography.md)                             |
| Generated files and build lifecycle                                     | [generated-and-build.md](references/generated-and-build.md)           |
| Mandatory bilingual copy, catalogs, the raw-text rule                   | [internationalization.md](references/internationalization.md)         |
| Template manifest, README, marketing thumbnail (`assets/thumbnail.svg`) | [template-repository.md](references/template-repository.md)           |

Read only the relevant reference. Use the Bolt runtime internals
(`packages/bolt/src/runtime/` in the OSS repository) for hook, pipeline, and automation execution,
the `norbital-platform` skill for policy behavior, and the code-quality skill after edits.

**Template authoring defaults:** inline duplicated UI to keep the file count small; DRY only for
substantially big components; describe UI with `$derived` (queries are already reactive — no
`$effect` / `watch`); paint useful human information only; prefer nested/`with` queries over N+1
or gratuitous parallel fetches; never show system UUIDs, including on relationships.

## Authored filesystem

```text
.agents/skills/
└── <name>/
    └── SKILL.md                   # optional — workspace Agent Skill (repo root, sibling of src/)

src/
├── mcp/
│   └── +<name>.mcp.ts             # optional — remote MCP server declaration
├── collections/
│   ├── +relationship.ts
│   └── <collection>/
│       ├── +model.ts
│       ├── +hooks.ts              # optional
│       ├── +pipelines.ts          # optional
│       ├── +integrations.ts       # optional
│       └── +representation.svelte # optional create/display/edit override
├── custom-types/
│   └── <name>/
│       ├── +definition.ts
│       └── +renderer.svelte       # required
├── apps/
│   ├── +<app>.svelte
│   └── <group>/
│       ├── +group.ts
│       └── +<app>.svelte
├── automation/+<automation>.ts
├── remotes/+<remote>.ts
├── policies/+<name>.policy.ts     # optional
├── channels/+<name>.channel.ts    # optional
├── i18n/
│   ├── messages.en.json           # required — English copy
│   └── messages.zh.json           # required — Chinese copy, exact same keys
├── lib/**                         # optional, free-form helper code — no role, no `+` prefix
├── +agent.ts                      # optional
├── +env.ts                        # optional — declare env vars; private keys are server-only
└── +seed.ts                       # optional
```

Directory and filename own all identities. Every role default-exports one declaration. Collection server
roles import adjacent `./$types.js` only when they need generated types.

**What the compiler actually enforces.** Every topology check keys on a leading `+`, so the rules below
bind role files and nothing else:

| Rule                                                                                  | Applies to                            |
| ------------------------------------------------------------------------------------- | ------------------------------------- |
| An unknown, duplicate, misplaced, or legacy role file is a compiler error             | `+`-prefixed basenames only           |
| A `+`-prefixed file nested _below_ a collection directory is a compiler error         | e.g. `collections/x/panels/+y.svelte` |
| `src/policies` and `src/channels` hold only `+<lower_snake_case>.{policy,channel}.ts` | those directories                     |

Everything without a `+` is ordinary source the compiler does not claim. `src/lib/**`,
`collections/<c>/lib/**`, `collections/<c>/panels/`, co-located `*.test.ts`, and adjacent components such
as `project-representation.svelte` are all legal — `lib` is listed as free-form helper code precisely so
a workspace can keep engine and helper code somewhere.

`src/i18n/` is special-cased, not ordinary source: it holds the tenant's translation catalogs, and
**both `messages.en.json` and `messages.zh.json` are required** in every workspace — bilingual wiring
is mandatory even when the tenant only ships English today (the zh file mirrors the English copy
until real translations land). The compiler enforces that the two files carry exactly the same keys,
and the bolt runtime merges them over the platform chrome catalogs (bolt + `@norbital-ai/ui`) at build
time. Use `useI18n<TenantKeys>()` from `@norbital-ai/ui/i18n` in your app files, keyed by your own
catalog keys (import your `messages.en.json` for the key type). Every user-facing string in an app
file must come from `t(...)`; the compiler rejects raw text in Svelte markup (see
[internationalization.md](references/internationalization.md#the-raw-text-rule-statically-enforced)).
App metadata stays static English in `<svelte:head>`; override the sidebar label per locale with an
`app.<id>.title` key in your catalog.

Two consequences worth stating, because the compiler will not state them for you:

- A non-`+` component beside a role is **not** a way to opt out of a role's contract. A create/edit
  surface still belongs behind `+representation.svelte`; moving it into `job-form.svelte` and rendering
  it from a call site is the rejected call-site create API with a different filename, and nothing will
  fail the build.
- Compiler-legal is not skill-legal. The layout, spacing, data-access and date rules in the references
  apply to every authored file, `+`-prefixed or not.

`bolt sync` owns `.norbital/generated/{models,registry,apps,workspace,client}.ts`, `types`, `diagnosis`,
`dist`, and `tsconfig.json`. `.norbital/migrations` is generated but committed; other `.norbital` output is
ignored. The authored root `tsconfig.json` only extends `.norbital/tsconfig.json`.

## Models and custom types

Use one model signature: `defineModel(columns, metadata?)`. The directory owns the collection name.

```ts
import { defineModel, enums, text } from '@norbital-ai/bolt/authoring';

export default defineModel(
	{
		title: text().notNull(),
		status: enums(['open', 'in_review', 'closed'])
	},
	{ description: 'Requests for information.', recordLabel: 'title', icon: 'lucide:file-question' }
);
```

Models describe data and storage only. `recordLabel` is one field or an ordered field tuple; it is not a
view expression. Declaration order and field kinds supply schema-derived defaults. App files own presentation.
Classify temporal fields before choosing `date()`, `clockTime()`, `timestamp()`, or `dateRange()`; read
[dates-and-time.md](references/dates-and-time.md) whenever a model, filter, seed, import/export, or UI
touches dates or time.

Inline custom schemas do not exist. Structured domain values live in `custom-types/<name>/` with exactly a
`+definition.ts` default-exporting `defineCustomType({ name, description, schema })` and a mandatory
`+renderer.svelte`. Models use `custom('<name>')`; a schema factory infers its optional second argument,
such as `custom('money', { allowedCurrencies: ['MYR'] })`. The definition is the only schema and inferred
value-type source, and named values use JSONB storage. Scalar references stay ordinary `uuid()`/`text()`
columns plus relationships. The compiler discovers renderers statically; manual imports, registration, and
runtime registries do not exist. There are no built-in custom-type exceptions: `money` must also have its
filesystem definition and renderer in every workspace that uses it. Do not cast the inferred value type.

## One client and one database vocabulary

Apps import a single typed object. All reads are **live reactive queries** backed by Bolt's sync
engine — a policy-scoped local replica of the data this device has already seen. There is no
`refetch`, `invalidate`, or `revalidate`. Mutations are **optimistic**: the UI updates same-frame,
and the server confirms or rejects asynchronously.

```ts
import { client } from '$bolt/client';

const employees = client.db.employees.findMany({ where, orderBy, columns, with, search, limit, after });
await client.db.claims.create(input);
const forecast = await client.invoke.holiday_feed(input);
```

Reads return reactive queries; mutations are promises and update live queries automatically. Use
opaque `after` cursors, never offset pagination. Use `findGrouped` and `aggregate` only for
queryable reporting; do not load wide datasets and regroup them in memory. Server roles use the
same method names through the Effect-native `api.db` surface.

**How it works under the hood:** every `findMany`/`findFirst` executes against the local replica —
no network for data this device has already seen. When a mutation lands (yours or
someone else's), the sync engine re-evaluates every live query that depends on the changed
collections. The sync unit is the **collection**, not the query shape, so changing a sort or
filter never creates server work against a resident collection. For the wire protocol see
[the bolt sync source](https://github.com/norbital-ai/oss/blob/main/packages/bolt/src/runtime/sync/sync.ts).

## Apps, layout, and collection surfaces

Apps are `src/apps/**/+<app>.svelte`. Their `<svelte:head>` metadata is static (`title`, a required
`description`, literal `bolt:icon`, optional static `bolt:thumbnail` / `bolt:banner` URLs). There is no host layout metadata.
App thumbnails and banners are optional — missing ones get a same-size icon fallback in the shell (overview
cards keep their 16:9 media slot, omni finder keeps its 6×6 tile). Ship product images under `assets/`
and reference `/api/template-seed-assets/<key>/<path>` URLs. The collection-owned `+representation.svelte`
can also declare a static `bolt:banner` meta, rendered above the record detail sheet header. See
[apps-and-server-roles.md](references/apps-and-server-roles.md#app-media--icons-thumbnails-banners) for the
in-product media contract.

**Template marketing thumbnail is separate:** website gallery / homepage cards / `og:image` read
`<key>/assets/thumbnail.svg` once (optional manifest `thumbnail` override only if the path differs).
Do not configure that image a second time as `bolt:thumbnail`. Details in
[template-repository.md](references/template-repository.md#marketing-thumbnail-declare-once).

The bolt shell owns the application region, default document scroll, query container, and app identity.
Use ordinary `PageHeader` and `Tabs` from `@norbital-ai/ui` where their semantics fit; neither controls
geometry. Compose body layout with primitives from `@norbital-ai/ui/layout`:

| Intent                        | Primitive            |
| ----------------------------- | -------------------- |
| Vertical rhythm               | `Stack`              |
| One row / wrapping group      | `Inline` / `Cluster` |
| Two adaptive regions          | `Split`              |
| Intrinsic cells / exact spans | `Grid` / `Columns`   |
| Top, main, bottom             | `Cover`              |
| Readable measure / media crop | `Center` / `Frame`   |
| Local scrolling               | `Bound` + `Scroll`   |

Parents choose the layout algorithm; children do not request growth. Prefer intrinsic layout and shared
container-query tokens over viewport breakpoint recipes. `Grid` is intrinsic; use `Columns` only for exact
counts or spans. `Split` accepts named ratios and shared collapse tokens, not arbitrary widths.

Every app is `Cover top={pageHeading}` wrapping exactly one body region. That region owns the app inset,
while the concrete content surface owns scrolling. There are three legal bodies and nothing else:

| Body                                                         | Inset owner                  | Scroll owner                         |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------ |
| `<Tabs …/>`                                                  | `TabsContent`, automatically | each tab's one concrete body surface |
| `<Scroll name="…" inset>` for flowing content                | the `Scroll`                 | the `Scroll`                         |
| `<Bound size="full" inset>` for one self-scrolling component | the `Bound`                  | that component                       |

A bare `CollectionTable` in the `Cover` body has no scroll contract and no inset; it renders flush against
the shell edge. An `inset` wrapper placed around a `Tabs`, or inside a tab snippet, double-pads. A tab
snippet must render exactly one bounded body owner: a self-scrolling collection surface, a `Bound` around
one self-scrolling component, or `Bound` + named `Scroll` for custom flowing content. Each ancestor chain
has one scroll owner per axis and one inset owner; sibling panes may own their own. `Scroll`
is keyboard focusable and owns overscroll containment and scrollbar behavior. Do not use generic `overflow`
wrappers, flex/min-size chains, raw layout flex/grid wrappers, margins between siblings, or literal
`px-4 sm:px-6` classes. Clipping is valid only for text truncation, `Frame` media, or an audited popup/sheet
boundary.

**Read the layout guides** before authoring an app surface:
[interface-ideology.md](references/interface-ideology.md) for the axioms every rule below derives from,
[layout-and-scrolling.md](references/layout-and-scrolling.md) for scroll priority, min-height rules, mobile
responsiveness, and scroll-trap anti-patterns, and
[padding-and-spacing.md](references/padding-and-spacing.md) for gap/pad ownership and the app inset.

Bolt collection surfaces receive the generated `client` explicitly. A table has explicit typed columns;
its collection-owned representation decides whether custom create/display/edit surfaces exist:

```svelte
<script lang="ts">
	import { client } from '$bolt/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
</script>

<svelte:head>
	<title>Requests</title>
	<meta name="bolt:icon" content="lucide:file-question" />
</svelte:head>

{#snippet pageHeading()}
	<PageHeader title="Requests" description="Track and resolve project RFIs." />
{/snippet}

<Cover as="main" top={pageHeading}>
	<Bound size="full" inset>
		<CollectionTable {client} collection="rfis">
			{#snippet columns({ Column })}
				<Column name="rfi_number" />
				<Column name="title" />
				<Column name="status" />
			{/snippet}
		</CollectionTable>
	</Bound>
</Cover>
```

Use `query`, `view`, and display composition only where a surface differs. A duplicate collection surface in one app
must have an explicit unique `view`. Custom create, display, and edit flows use only the collection-owned
`+representation.svelte` role. It imports generated `RepresentationProps` from `./$types.js` and branches
on `record`: `null` means create, while a row means an existing record. Do not pass representations at a
call site. Keep editable fields inside the generated form and avoid duplicating them in read-only summaries.

Collection surfaces are record summaries, not database inspectors: give each one a human-readable title and
description, and never expose `norbital_id`, UUID fields, or `*_id` keys as a list title or subtitle. Density,
duplication, and data-renderer rules are in [interface-ideology.md](references/interface-ideology.md).

## Server roles

**Every declaration carries a mandatory `description`.** Hooks and pipelines are `{ description, handler }`;
automations, remotes, policies, channels, agent tools, custom types, apps, and groups each take one as a
field. They are not comments — they are compiled into the manifest, and the Workspace Studio has nothing
else to show somebody who will never open the source. Write what the code does to this data in one
sentence; "runs before create" restates the key and is worse than nothing.

- `src/+agent.ts` configures the interactive agent. Do not list sandbox host tools in `hostTools` —
  the funnel supplies them when a sandbox is bound (including WhatsApp and other channels). Use
  typesafe `denyTools` to withhold workspace or platform tools; it cannot hide a bound sandbox.
  Non-sandbox host tools remain an explicit `hostTools` opt-in. The funnel is documented in the
  platform skill (`agent-capabilities.md`).
- Hooks, pipelines, automations, remotes, and agent tools are **Effect-native**. Every handler is an
  `Effect.gen(function* () { ... })` receiving `{ input, api }`, and every `api.db.*`,
  `api.infer`, and `api.readFileAsset` call returns an `Effect.Effect` you `yield*` — never a
  plain Promise (promises and plain values are still admitted and normalized at the authoring
  boundary). The runtime actually executes these handlers: before/after hooks wrap create, update,
  and delete (create also takes a `batchHandler` for bulk writes), import/export pipelines run the
  canonical import and export flows, and change-triggered automations receive
  `{ args, scope }` with the triggering row as `scope.incoming_record`.
- Hooks validate and return the exact input/patch, then make only immediate database or asset
  reads. Hooks MAY call bounded `api.infer` for judgement (photos etc.); heavy/durable infer still
  belongs in automations. They never queue work, send email, or spawn agent sessions. Reject a write
  with `refuse(message)` from `@norbital-ai/bolt/authoring` — it reaches the caller as a typed
  refusal (422 with your sentence), not as a runtime fault.
- **Validation goes in `before`, always.** There are no transactions around a hook: the database
  facility autocommits every statement, so by the time `after` runs the row is a fact and nothing can
  undo it. A check in `after` that refuses leaves the record behind — hr-payroll's orphaned DRAFT
  runs with no payslips came from exactly that. `after` is for work that follows the record
  existing, and its failures are reported rather than swallowed.
- Automations run after commit, are durable and idempotent, and receive stable event IDs. They are
  always deterministic handlers; when one needs model judgement, call `api.infer` with an Effect
  `Schema.Schema` for `schema` (never zod), optional `images`, and optional named workspace tools.
  It never offers authoring, sandbox, `write_collection`, or `spawn_subagent`, and it does not own a
  chat transcript. Each run is one admitted function. If the work is not finished, the host calls
  the same function again.
- Remotes are imperative request/response methods declared with `defineQueryHandler` /
  `defineCommandHandler`; their payload schema is an Effect `Schema` (e.g. `Schema.Struct`), adapted
  to `~standard` for dispatch validation. Reactive reads belong to `client.db`.
- Integrations use portable runtime delivery facilities; missing facilities fail at boot.
- Put tenant-specific fixture behavior in `src/+seed.ts`. Sensitive statutory or system seed remains Colony-owned.

## Prohibitions

Do not author `schema.ts`, `workspace.ts`, collection barrels, `*.schema.ts`, app `App.svelte`, SvelteKit
routes, a custom bundler, `defineTable`, `defineSchema`, `QueryRow`, `NorbitalAuthoring`, `$tenant`, or `$lib`.
The compiler rejects the former Page/Pane/Region, layout metadata, split-client, legacy enum, record-rep,
`+create.svelte`, call-site create APIs, and hand-written assembly; there is no compatibility path.

## Workflow

```bash
# Run from the selected template workspace in a checkout of the templates repository.
pnpm sync        # template script wrapping `bolt sync`
pnpm lint
pnpm build       # `vite build` through the `bolt()` plugin
```

Publish through the OSS release workflow before asking Colony to consume the change. Before finishing, run
the relevant quality audit, sync, lint, build, and focused behaviour test in OSS.
