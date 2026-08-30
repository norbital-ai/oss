---
name: authoring-tenant-workspace
description: >-
  Author filesystem-first Bolt tenant workspaces and move changes through OSS packages, template
  repositories, Colony, and the website. Load for collections, datatypes, apps, automations,
  functions, generated $types, $bolt/client, template metadata, fixture seeding, or
  local/staging/production refresh behavior.
---

# Authoring Bolt Tenant Workspaces

Bolt tenant workspaces are plain Vite projects in `norbital-ai/templates` or
`norbital-ai/templates-private`. Authors write the compiler-owned `+` files under `src/`; the Bolt filesystem
compiler derives the registry, workspace, client, loaders, and local types under `.norbital/`. Never
hand-author assembly or generated output. The sealed authoring contract is the
[Bolt authoring package](https://github.com/norbital-ai/oss/blob/main/packages/bolt/src/authoring/index.ts).

## Ownership and refresh

| Source changed                | Owner                         | Required refresh                                     |
| ----------------------------- | ----------------------------- | ---------------------------------------------------- |
| `oss/packages/*`              | OSS package source            | package build → consumer install → template artifact |
| template `src/`, assets, meta | templates / templates-private | `bolt sync` → Colony publish + route                 |
| `norbital/apps/colony`        | hosting platform              | Colony Vite reload or platform deploy                |
| `norbital/apps/website`       | marketing/docs site           | website Vite reload or website deploy                |

A tenant page loads an immutable artifact. Template and package source are never tenant HMR inputs.
For local package/template work, stop Colony and run `pnpm --dir norbital run env -- dev --ui`; it builds OSS,
`pnpm run env -- link` establishes yalc links in every consumer, materializes them with pnpm, stages those builds for tenant
sandboxes, syncs templates, then starts a fresh Colony bootstrap that publishes and routes the
artifacts. Use `--template=<directory|handle>` to narrow template linking and sync.

To put every consumer on the local build **without** starting Colony, run
`pnpm run env -- link`. It publishes once, runs each consumer repository's own linker, and
then verifies: every managed package in every workspace must resolve through pnpm's virtual store and
must actually import. A workspace left stale or orphaned fails the command. There is no standalone
push — writing `.yalc/<name>` on its own reaches nothing that imports the package, and replaces
`node_modules/<name>` with a link to a directory carrying no `node_modules`, which orphans that
package's own dependencies.

Yalc reaches a tenant build through a mount, not through its lockfile. A tenant compiles inside a
microVM that installs `--offline --frozen-lockfile` against Colony's package store, so a linked
package is invisible to it: the compile whose output actually ships would keep using the published
build. Colony therefore mounts the staged builds read-only at `/var/lib/norbital-local-packages` and
the guest installer overlays them onto the installed tree, which is yalc's own rule — the local build
replaces the resolved one. A deployed host stages nothing, the mount is empty, and the install is
exactly what the lockfile pinned. The wrapper and the mount point live in the sandbox image, so this
only takes effect after `scripts/build-microsandbox-image.sh` is rerun.

`dev` refuses to build on a clobbered link. Linking restores `package.json` and the lockfile so no
local pin is ever committed, which leaves the tree and the manifest disagreeing on purpose; a later
`pnpm install` re-resolves the registry pin and drops the local build with no message. The run
compares each consumer's materialised `yalcSignature` against the one the push left in `.yalc` and
names any checkout that would compile against the published packages. If a run is interrupted during
its install step, links can be left half-written; `pnpm run env -- link` (from the norbital repository) repairs them.

Colony source uses its own Vite HMR; restart for `.env`, dependency, bootstrap, or artifact-routing
changes. Website source uses its own Vite HMR; after an OSS package change, run
`pnpm run env -- link` and restart the website dev server. Read
[generated-and-build.md](references/generated-and-build.md#source-to-runtime-map) before deciding
whether a local restart, release, deployment, or tenant rebuild is required.

Yalc is local only. Staging and production consume exact registry packages, remote template refs, and
committed Norbital builds. Staging follows Norbital `master`; production follows `production` and must
receive the same verified tree. An existing tenant does not change until a new artifact is built and
routed. Never use `env:reset` as a refresh command: it discards the source snapshot and database.

Sample rows come from the separate `seed_bank` repository, never from the template tree: Colony's
`scripts/seed-from-bank.mjs` maps each organization handle to a bank tree (`SEED_BANK_TREES` — the
bank names and the handles are deliberately two axes, e.g. handle `norbital_bca` → tree
`field-operations`) and loads one `<collection>.json` per collection, plus fixture media for `file()`
columns. A handle absent from that table is not seedable; add the mapping in the script, not in the
template. Seeding does not evolve deployed data. For an existing tenant, diff the authored models
against the migration lineage and write the next entry with `pnpm exec bolt migrate`, then edit its
SQL before deploying through Colony.

## Reference routing

| Task                                                                                                | Reference                                                             |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Built-in column types — read before using `custom()`**, collections, relationships, hooks, values | [collections-and-modeling.md](references/collections-and-modeling.md) |
| Dates, clock times, timestamps, filters                                                             | [dates-and-time.md](references/dates-and-time.md)                     |
| Queries: `$derived`, no N+1, batching                                                               | [data-access.md](references/data-access.md)                           |
| Apps, client, automations, functions, fixtures                                                      | [apps-and-server-roles.md](references/apps-and-server-roles.md)       |
| Why the layout system is shaped this way                                                            | [interface-ideology.md](references/interface-ideology.md)             |
| Composition, scrolling, scroll traps                                                                | [layout-and-scrolling.md](references/layout-and-scrolling.md)         |
| Controller UI: inline, `$derived`, no UUIDs                                                         | [controller-surfaces.md](references/controller-surfaces.md)           |
| Padding, gaps, the app inset                                                                        | [padding-and-spacing.md](references/padding-and-spacing.md)           |
| Headings, labels, captions: which type class                                                        | [typography.md](references/typography.md)                             |
| Generated files and build lifecycle                                                                 | [generated-and-build.md](references/generated-and-build.md)           |
| Mandatory bilingual copy, catalogs, the raw-text rule                                               | [internationalization.md](references/internationalization.md)         |
| Template manifest, README, marketing thumbnail (`assets/thumbnail.svg`)                             | [template-repository.md](references/template-repository.md)           |

Read only the relevant reference. Use the Bolt runtime internals
(`packages/bolt/src/runtime/` in the OSS repository) for hook, pipeline, and automation execution,
the `norbital-platform` skill for policy behavior, and the code-quality skill after edits.

**Template authoring defaults:** inline duplicated UI to keep the file count small; DRY only for
substantially big components; describe UI with `$derived` (queries are already reactive — no
`$effect` / `watch`); paint useful human information only; prefer nested/`with` queries over N+1
or gratuitous parallel fetches; never show system UUIDs, including on relationships. Collection
tables and Kanban cards declare visible fields explicitly, forms declare every mutable field exactly
once (`hidden` means retained but not painted), filters are schema-derived through relationship depth
two, and omitted renderer props always select the automatic datatype strategy.

## Authored filesystem

```text
src/
├── +agents.md                    # shared workspace prompt for web and envoy turns
├── +env.ts                       # optional — declare env vars; private keys are server-only
├── access/
│   ├── +teams.ts                  # which policies each named team holds
│   ├── +anonymous_limits.ts       # pre-sign-in address limits only
│   └── policies/+<name>.ts        # grants, approvals, capabilities, and limits
├── capabilities/
│   ├── tools/+<name>.ts           # optional workspace tool
│   ├── mcp/+<name>.ts             # optional remote MCP server
│   └── skills/<name>/+skill.md    # optional workspace Agent Skill
├── collections/
│   ├── +relationship.ts
│   └── <collection>/
│       ├── +model.ts
│       ├── +hooks.ts              # optional
│       ├── +pipelines.ts          # optional
│       ├── +integrations.ts       # optional
│       └── +representation.svelte # optional create/display/edit override
├── datatypes/
│   └── <name>/
│       ├── +definition.ts
│       └── +renderer.svelte       # required
├── apps/
│   ├── +<app>.svelte
│   └── <group>/
│       ├── +group.ts
│       └── +<app>.svelte
├── automations/+<automation>.ts
├── envoys/+<envoy>.ts
├── functions/+<function>.ts
├── i18n/
│   ├── messages.en.json           # English copy — its keys are the TenantI18nKeys type
│   └── messages.zh.json           # Chinese copy — mirror the English keys exactly
└── lib/**                         # optional, free-form helper code — no role, no `+` prefix
```

Directory and filename own all identities. Every role default-exports one declaration. Collection server
roles import adjacent `./$types.js` only when they need generated types.

**What the compiler actually enforces.** Every topology check keys on a leading `+`, so the rules below
bind role files and nothing else:

| Rule                                                                           | Applies to                             |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| An unknown, duplicate, misplaced, or legacy role file is a compiler error      | `+`-prefixed basenames only            |
| A `+`-prefixed file nested _below_ a collection directory is a compiler error  | e.g. `collections/x/panels/+y.svelte`  |
| A declared kind exists only in its assigned directory and uses `+<name>.<ext>` | compiler-owned declaration directories |

Everything without a `+` is ordinary source the compiler does not claim. `src/lib/**`,
`collections/<c>/lib/**`, `collections/<c>/panels/`, co-located `*.test.ts`, and adjacent components such
as `project-representation.svelte` are all legal — `lib` is listed as free-form helper code precisely so
a workspace can keep engine and helper code somewhere.

`src/i18n/` is special-cased, not ordinary source: it holds the tenant's translation catalogs, and
**both `messages.en.json` and `messages.zh.json` are expected** in every workspace — bilingual wiring
is mandatory even when the tenant only ships English today (the zh file mirrors the English copy
until real translations land; a missing locale falls back to an empty catalog, so keep the keys
aligned). `bolt sync` compiles them into the artifact: the English keys become the
`TenantI18nKeys` type, and the runtime merges both catalogs over the platform chrome catalogs
(bolt + `@norbital-ai/ui`) at build time under `$bolt/i18n-messages`. Use `useI18n<TenantKeys>()`
from `@norbital-ai/ui/i18n` in your app files, keyed by your own catalog keys (import your
`messages.en.json` for the key type). Every user-facing string in an app file must come from
`t(...)`; the raw-text rule is a review gate (see
[internationalization.md](references/internationalization.md#the-raw-text-rule)).
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
`dist`, and `tsconfig.json`. `.norbital/migrations` is generated but committed. `.norbital/config/` is
authored (doctor extensions) and committed. Other `.norbital` output is ignored. The authored root
`tsconfig.json` only extends `.norbital/tsconfig.json`.

## Models and datatypes

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

Models describe data and storage only. `recordLabel` is one field or an ordered tuple of
text-shaped fields: the runtime compiles it to a CEL concatenation, and CEL has no `+` for anything
but strings — an `instant()` column reaches the client as a `Date`, so a tuple naming one compiles
and resolves to nothing. For a composed title, write a `generatedAlwaysAs` SQL expression instead
(hr-payroll's leave events do exactly this). Declaration order and field kinds supply schema-derived
defaults. App files own presentation. Classify temporal fields before choosing `instant()`,
`custom('instant_range')`, or a date-shaped text column; read
[dates-and-time.md](references/dates-and-time.md) whenever a model, filter, fixture, import/export, or
UI touches dates or time.

Inline custom schemas do not exist. Structured domain values live in `datatypes/<name>/` with exactly a
`+definition.ts` default-exporting `defineCustomType({ name, description, schema })` and a mandatory
`+renderer.svelte`. Models use `custom('<name>')`; a schema factory infers its optional second argument.
The definition is the only schema and inferred value-type source, and named values use JSONB storage.
Scalar references stay ordinary `uuid()`/`text()` columns plus relationships. The compiler discovers
renderers statically; manual imports, registration, and runtime registries do not exist.

**The platform owns two custom datatypes, injected rather than filesystem-discovered, and a tenant
datatype may never shadow them.** They use the same `defineCustomType` declaration contract, runtime
registry, validation, renderer contract, and `custom('<name>', options?)` access pattern as tenant
datatypes. Use `custom('money', { allowedCurrencies: […] })` (validated against
`@norbital-ai/std/finance`'s `MoneyValueSchema`) and
`custom('instant_range', { precision: 'day', multiple: true })`. The only distinction is discovery:
there is no `src/datatypes/money/` or `src/datatypes/instant_range/`. The compiler injects those
definitions and refuses a tenant directory that redeclares either name. Do not cast the inferred
value type.

## One client and one database vocabulary

Apps import a single typed object. All reads are **live reactive queries** answered by Bolt's sync
engine — the server pushes the current answer for every mounted query. There is no
`refetch`, `invalidate`, or `revalidate`. Mutations are **optimistic**: the UI updates same-frame,
and the server settles each write asynchronously (`accepted` / `rebased` / `rejected` /
`quarantined`).

```ts
import { client } from '$bolt/client';

const employees = client.db.employees.findMany({ where, orderBy, columns, with, search, limit, after });
await client.db.claims.mutate(input);
client.db.claims.pending; // numeric in-flight count
const forecast = await client.invoke.holiday_feed(input);
```

Queries own their reactive `current`, `loading`, and `error` state. `mutate(values)` resolves
immediately with the optimistic row; the authority settles the write through the returned handle
rather than returning a row. The collection's numeric `pending` property is the count of writes
still in flight. Do not duplicate
query or mutation state in a component. Use opaque `after` cursors, never offset pagination. Use
`findGrouped` and `count` only for queryable reporting; do not load wide datasets and regroup them
in memory. Server roles use the same direct `api.db.<collection>` surface and singular
`mutate(recordOrGraph)` vocabulary, with Effects instead of browser Promises. Use the generated
collection methods directly.

`mutate` accepts the precisely generated nested graph. An included relationship is its complete
desired state: present rows are inserted or updated, stored rows absent from the submitted relationship
are deleted, and explicitly included relationships synchronize recursively. An omitted relationship is
untouched. The root and every included relationship reconcile atomically, so submit a relationship only
when replacement semantics are intended. Authorization, approvals, hooks, history, changelog
capture, and events all run through this one canonical mutation pipeline.

**How it works under the hood:** every live query is registered once with the host under its
stable key. When a commit lands (yours or someone else's), the host re-evaluates the queries
indexed under the changed collections — in the database, under each subscriber's own policy — and
pushes one apply frame per commit. The fan-out unit is the **collection**. A cursored read
(`after`) is one-shot: it is answered once and never registered. For the wire contract see
[the bolt-protocol sync schema](https://github.com/norbital-ai/oss/blob/main/packages/bolt-protocol/src/sync.ts).

## Apps, layout, and collection surfaces

Apps are `src/apps/**/+<app>.svelte`. Their `<svelte:head>` metadata is static (`title`, a
`description` — expected, since the studio and the overview card have nothing else to say what the
app is for, though nothing enforces it — literal `bolt:icon`, optional static `bolt:thumbnail` /
`bolt:banner` URLs). There is no host layout metadata.
App thumbnails and banners are optional — missing ones get a same-size icon fallback in the shell (overview
cards keep their 2:1 `Frame ratio="banner"` media slot; the omni finder shows a 16px thumb, else the
app's icon). Ship product images under `assets/`
and reference `/__bolt/request/api/template-seed-assets/<key>/<path>` URLs. The collection-owned `+representation.svelte`
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

Framework scroll owners share one visible contract: the scrollbar thumb appears only on hover and
directional edge fades appear only where more content exists. Compound components keep controls,
headers, legends, and pagination outside their internal scrollport; only their rows or cells scroll.
On page/month/filter changes, keep that shell and its height mounted, mark it `aria-busy`, and replace
only the data region with shape-matched `Skeleton` rows or cells. Never swap the whole component for a
loading paragraph, generic pulse rectangle, or empty branch.

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
description, and never expose `id`, UUID fields, or `*_id` keys as a list title or subtitle. Density,
duplication, and data-renderer rules are in [interface-ideology.md](references/interface-ideology.md).

## Who is looking at this page

`getPlatformStateContext()` from `@norbital-ai/bolt/client` is the only way an authored page learns
who is using it. It returns a **getter**, not a value — call it, then call the result, so the page
reads the current session rather than a snapshot taken at mount.

```svelte
import {getPlatformStateContext} from '@norbital-ai/bolt/client'; const platform = getPlatformStateContext();
const me = $derived(platform().user);
```

`platform()` publishes exactly three things and nothing else — `user`, `apps`, `envoys`. If you
want something that is not in this table, it is not there; do not guess a field name.

| Field        | Is                                     | Use it for                                                     |
| ------------ | -------------------------------------- | -------------------------------------------------------------- |
| `user.id`    | `user.id`, a **uuid**                  | The only value you may key a row by                            |
| `user.email` | The address, as the host reports it    | Display, and matching a column that genuinely holds an address |
| `user.admin` | `user.status === 'admin'`              | Widening a surface for administrators                          |
| `apps`       | The app names **this session may see** | Deriving authority — see below                                 |
| `envoys`     | Declared envoys, with `audience`       | Offering an envoy to the right audience                        |

**`user.id` is the row key. There is no second spelling.** A sibling field named `id` filled from
the display name would send an email's local part to a `uuid` column in every authored query of
the shape `where: { user_id: { eq: user.id } }`, failing as Postgres 22P02. The surface reports
"could not load your profile", which is a plausible sentence for a parse error and sends people
looking at the wrong layer. One spelling, and it is the one every other row key uses.

**Do not publish or read a label as a key.** A `team` field is gone from this context for the same
reason: it held the sidebar's role string — literally `'Admin'` or `'Member'` — under a name that
reads like a team identity. That failure mode is worse than the uuid one, because a label compared
against a key returns an empty result rather than an error, so the page renders as though the person
simply has nothing.

**Derive authority from `apps`, not from a lookup.** If a page needs to know whether this person is
dispatch or field staff, ask whether the dispatch app is in `apps` — the runtime already narrowed
that list by the policies the person's team holds. Fetching a profile row to answer it adds a query
that can fail, and a query that can fail becomes an error message shown to someone whose only
problem is that they are not an administrator.

**Distinguish "not yet known" from "not permitted".** `platform()` is readable before the session
resolves. A page that treats an unsettled value as a refusal shows a permission error to a person who
is merely still loading; give the unsettled case its own branch.

## Server roles

**Every declaration carries a `description` where the shape allows one.** Hooks and pipelines are
`{ description, handler }`; automations, functions, policies, datatypes, and groups take it as a
field; an app wears it as the `description` meta. They are not comments — they are compiled into the
manifest, and the Workspace Studio has nothing else to show somebody who will never open the source.
Write what the code does to this data in one sentence; "runs before create" restates the key and is
worse than nothing. (Envoys deliberately take no `description`: their `task` says what the surface is
for, and a second copy would drift.)

- `src/+agents.md` is the shared workspace prompt. A web turn runs as the signed-in person; an envoy
  adds its own `task` and runs under the policies declared in `src/envoys/+<name>.ts`. Tools, MCP
  servers, and skills are capabilities of policies, never fields on an agent or envoy.
- Hooks, pipelines, automations, functions, and tools are **Effect-native**. Every handler is an
  `Effect.gen(function* () { ... })` receiving `{ input, api }`, and every `api.db.*`,
  `api.infer`, and `api.readFileAsset` call returns an `Effect.Effect` you `yield*` — never a
  plain Promise (promises and plain values are still admitted and normalized at the authoring
  boundary). Import/export pipelines run the canonical import and export flows, and
  change-triggered automations receive `{ args, scope }` with the triggering row as
  `scope.incoming_record`.
- **A write declaration is arranged by how often each part runs**, and the nesting is the
  documentation: `create: { input, prepare, perRecord: { before, after } }`. `prepare` runs **once
  for the batch** and exists for the reads a whole batch needs — the bulk query a person can write
  and a resolver cannot derive; it returns data and decides nothing. `perRecord.before` and
  `perRecord.after` run **once per record**, and every decision lives there, written once, whether
  the write was one row or four thousand. `update` and `delete` take the same `perRecord` nesting;
  only `create` has `prepare`. `batchHandler` no longer exists. Details in
  [data-access.md](references/data-access.md#batch-genuine-bulk-work).
- Hooks validate and return the exact input/patch — and a create's `perRecord.before` may return the
  record **plus the records that belong to it**, keyed by a declared `many` relation name, which the
  runtime commits in the same transaction. Otherwise they make only immediate database or asset
  reads. Hooks MAY call bounded `api.infer` for judgement (photos etc.); heavy/durable infer still
  belongs in automations. They never send email or spawn agent sessions; background work goes
  through `api.automations.run(name, input, { after })`, which starts a **declared** automation
  durably and with retry, and is the only such door (there is no `api.tasks`). Reject a write with
  `refuse(message)` from `@norbital-ai/bolt/authoring` — it reaches the caller as a typed refusal
  (422 with your sentence), not as a runtime fault.
- **Validation goes in `perRecord.before`, always — and this is a correctness rule, not a
  preference.** A batch runs PREPARE → COMMIT → SETTLE. `before` and the graph it returns are inside
  PREPARE, before the one transaction, so a refusal fails the whole batch with nothing written.
  `after` runs in SETTLE, past the commit, so by then the row is a fact and nothing can undo it —
  a check there that refuses leaves the record behind, which is where hr-payroll's orphaned DRAFT
  runs with no payslips came from. **Anything that must succeed or fail atomically with the record
  belongs in `before` and its graph, never in `after`.** `after` is for work that follows the record
  existing, its failures are reported rather than swallowed, and a caller must not retry them.
- Automations run after commit, are durable and idempotent, and receive stable event IDs. They are
  always deterministic handlers; when one needs model judgement, call `api.infer` with an Effect
  `Schema.Schema` for `schema` (never zod), optional `images` (≤ 8, ≤ 20 MiB, values taken straight
  from a `file()` column), and optional provider-neutral `webSearch`. It offers no tools of any
  kind, no authoring, no sandbox, and no `write_collection`/`spawn_subagent`, and it does not own a
  chat transcript. Each run is one admitted function. If the work is not finished, the host calls
  the same function again.
- Functions are imperative request/response methods declared with `defineQueryHandler` /
  `defineCommandHandler`; their payload schema is an Effect `Schema` (e.g. `Schema.Struct`), adapted
  to `~standard` for dispatch validation. Reactive reads belong to `client.db`.
- **A policy is named by its file, and a team is what holds it.**
  `src/access/policies/+sales_rep.ts` declares `sales_rep` without a `name` field, and that filename
  is what the generated `PolicyName` union, teams, envoys, and automations bind to.
  `src/access/+teams.ts` maps each team name to the policy names it holds (`satisfies Teams`). There is no
  `roles` array on a policy and no second way to select one: a person belongs to exactly one team
  (`user.team_id`), team membership is a row an operator edits, and what a team may _do_
  is this compiled file. Team names are matched case-insensitively. Behaviour is in the
  `norbital-platform` skill's `approvals-and-policies.md`.
- Integrations use portable runtime delivery facilities; missing facilities fail at boot.
- Fixtures come from the seed-bank repository, one `<collection>.json` per collection per tree,
  keyed by handle in `SEED_BANK_TREES` — see the seeding paragraph above. Statutory and identity
  fixture tables are Colony's own `scripts/seed-from-bank.mjs` machinery, not template source.

## Prohibitions

Do not author `schema.ts`, `workspace.ts`, collection barrels, `*.schema.ts`, app `App.svelte`, SvelteKit
routes, a custom bundler, `defineTable`, `defineSchema`, `QueryRow`, `NorbitalAuthoring`, `$tenant`, or `$lib`.
The compiler rejects the former Page/Pane/Region, layout metadata, split-client, legacy enum, record-rep,
`+create.svelte`, call-site create APIs, and hand-written assembly; there is no compatibility path.

## Workflow

```bash
# Run from the selected template workspace in a checkout of the templates repository.
pnpm sync        # validates, generates, and builds the client + server artifact
pnpm lint
```

For local review, use the yalc/bootstrap flow above; do not publish. For staging/production, release
OSS packages first, update exact consumer pins and locks, publish template refs, deploy staging, then
promote the verified Norbital tree to production. Before finishing, run the relevant quality audit,
sync, lint, and focused behavior test.
