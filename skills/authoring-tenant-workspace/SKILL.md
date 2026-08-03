---
name: authoring-tenant-workspace
description: >-
  Author filesystem-first Pod tenant workspaces in the public OSS repository. Load for collections,
  custom types, apps, automations, remotes, seeds, generated $types, the unified $pod/client,
  temporal values, filters, and client rendering.
---

# Authoring Pod Tenant Workspaces

Pod 1.0 tenant workspaces are plain Vite projects. Authors write only `src/`; the Pod filesystem compiler
derives the registry, workspace, client, loaders, and local types under `.norbital/`. Never hand-author
assembly or generated output. The sealed contract is in the OSS Pod package:
[Form system documentation](https://github.com/norbital-ai/oss/blob/main/packages/pod/docs/FORM_SYSTEM.md).

## Live checkpoint redeploy

Local `/app/...` tenants run an immutable checkpoint, not editable OSS source via HMR. After publishing
a runtime or template release, consume the new release in Core and redeploy before reporting success:

```bash
# Core (`pnpm dev`) must be running
pnpm tenant:update --org=<org-slug>
pnpm tenant:update --org=<org-slug> --template=<slug>
```

Use `--template` after publishing the template projection ref, then hard-refresh the iframe. Use
`pnpm env:reset --target dev --template <slug>` only for a deliberate reseed. Do not keep one-off tenant import,
provisioning, or patch scripts: durable fixtures belong in `src/+seed.ts` or the Core seed plan.

`+seed.ts` initializes new tenants; it does not evolve deployed data. For an existing tenant, create a
committed migration with `pnpm exec pod migration create <name> --custom`, edit its SQL, then run
`pnpm tenant:update --org=<org-slug> --template=<slug>`. Resolve update conflicts in Organization
Studio → Template updates using the explicit Template/Tenant choices.

## Reference routing

| Task                                      | Reference                                                             |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Collections, relationships, hooks, values | [collections-and-modeling.md](references/collections-and-modeling.md) |
| Dates, clock times, timestamps, filters   | [dates-and-time.md](references/dates-and-time.md)                     |
| Queries and batching                      | [data-access.md](references/data-access.md)                           |
| Apps, client, automation, remotes, seed   | [apps-and-server-roles.md](references/apps-and-server-roles.md)       |
| Why the layout system is shaped this way  | [interface-ideology.md](references/interface-ideology.md)             |
| Composition, scrolling, scroll traps      | [layout-and-scrolling.md](references/layout-and-scrolling.md)         |
| Padding, gaps, the app inset              | [padding-and-spacing.md](references/padding-and-spacing.md)           |
| Generated files and build lifecycle       | [generated-and-build.md](references/generated-and-build.md)           |

Read only the relevant reference. Use `TENANT_WORKSPACE.md` for runtime internals,
`ACCESS_CONTROL.md` for policy behavior, and the code-quality skill after edits.

## Authored filesystem

```text
src/
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
└── +seed.ts                       # optional
```

Directory and filename own all identities. Every role default-exports one declaration. Unknown, duplicate,
misplaced, or legacy role files are compiler errors. Collection server roles import adjacent
`./$types.js` only when they need generated types.

`pod sync` owns `.norbital/generated/{models,registry,apps,workspace,client}.ts`, `types`, `diagnosis`,
`dist`, and `tsconfig.json`. `.norbital/migrations` is generated but committed; other `.norbital` output is
ignored. The authored root `tsconfig.json` only extends `.norbital/tsconfig.json`.

## Models and custom types

Use one model signature: `defineModel(columns, metadata?)`. The directory owns the collection name.

```ts
import { defineModel, enums, text } from '@norbital-ai/pod/authoring';

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
`+definition.ts` default-exporting `defineCustomType({ name, schema })` and a mandatory
`+renderer.svelte`. Models use `custom('<name>')`; a schema factory infers its optional second argument,
such as `custom('money', { allowedCurrencies: ['MYR'] })`. The definition is the only schema and inferred
value-type source, and named values use JSONB storage. Scalar references stay ordinary `uuid()`/`text()`
columns plus relationships. The compiler discovers renderers statically; manual imports, registration, and
runtime registries do not exist. There are no built-in custom-type exceptions: `money` must also have its
filesystem definition and renderer in every workspace that uses it. Do not cast the inferred value type.

## One client and one database vocabulary

Apps import a single typed object. All reads are **live reactive queries** backed by Pod's sync
engine — a local PGlite replica of policy-scoped data. There is no `refetch`, `invalidate`, or
`revalidate`. Mutations are **optimistic**: the UI updates same-frame, and the server confirms
or rejects asynchronously.

```ts
import { client } from '$pod/client';

const employees = client.db.employees.findMany({ where, orderBy, columns, with, search, limit, after });
await client.db.claims.create(input);
const forecast = await client.invoke.holiday_feed(input);
```

Reads return reactive queries; mutations are promises and update live queries automatically. Use
opaque `after` cursors, never offset pagination. Use `findGrouped` and `aggregate` only for
queryable reporting; do not load wide datasets and regroup them in memory. Server roles use the
same method names with plain promises.

**How it works under the hood:** every `findMany`/`findFirst` executes against the local PGlite
replica — no network for data this device has already seen. When a mutation lands (yours or
someone else's), the sync engine re-evaluates every live query that depends on the changed
collections. The sync unit is the **collection**, not the query shape, so changing a sort or
filter never creates server work against a resident collection. For the full architecture see
[the public sync-engine documentation](https://github.com/norbital-ai/oss/blob/main/packages/pod/docs/SYNC_ENGINE.md).

## Apps, layout, and collection surfaces

Apps are `src/apps/**/+<app>.svelte`. Their `<svelte:head>` metadata is static (`title`, optional
description, literal `pod:icon`, optional static thumbnail/banner URLs). There is no host layout metadata.

The pod shell owns the application region, default document scroll, query container, and app identity.
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

Every app is `Cover top={pageHeading}` wrapping exactly one body region, and that region owns both scroll
and the app inset. There are three legal bodies and nothing else:

| Body                                                         | Owns scroll + inset          |
| ------------------------------------------------------------ | ---------------------------- |
| `<Tabs …/>`                                                  | `TabsContent`, automatically |
| `<Scroll name="…" inset>` for flowing content                | the `Scroll`                 |
| `<Bound size="full" inset>` for one self-scrolling component | the `Bound`                  |

A bare `CollectionTable` in the `Cover` body has no scroll contract and no inset; it renders flush against
the shell edge. An `inset` wrapper placed around a `Tabs`, or inside a tab snippet, double-pads. Each
ancestor chain has one scroll owner per axis and one inset owner; sibling panes may own their own. `Scroll`
is keyboard focusable and owns overscroll containment and scrollbar behavior. Do not use generic `overflow`
wrappers, flex/min-size chains, raw layout flex/grid wrappers, margins between siblings, or literal
`px-4 sm:px-6` classes. Clipping is valid only for text truncation, `Frame` media, or an audited popup/sheet
boundary.

**Read the layout guides** before authoring an app surface:
[interface-ideology.md](references/interface-ideology.md) for the axioms every rule below derives from,
[layout-and-scrolling.md](references/layout-and-scrolling.md) for scroll priority, min-height rules, mobile
responsiveness, and scroll-trap anti-patterns, and
[padding-and-spacing.md](references/padding-and-spacing.md) for gap/pad ownership and the app inset.

Pod collection surfaces receive the generated `client` explicitly. A table has explicit typed columns;
its collection-owned representation decides whether custom create/display/edit surfaces exist:

```svelte
<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
</script>

<svelte:head>
	<title>Requests</title>
	<meta name="pod:icon" content="lucide:file-question" />
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

- Hooks validate and return the exact input/patch, then make only same-transaction database or asset reads.
  Hooks never send network traffic, queue work, email, AI, or notifications.
- Automations run after commit, are durable and idempotent, and receive stable event IDs. Agent-decided
  automation is not a v1 feature.
- Remotes are imperative request/response methods. Reactive reads belong to `client.db`.
- Integrations use portable runtime delivery facilities; missing facilities fail at boot.
- Put tenant-specific fixture behavior in `src/+seed.ts`. Sensitive statutory or system seed remains Core-owned.

## Prohibitions

Do not author `schema.ts`, `workspace.ts`, collection barrels, `*.schema.ts`, app `App.svelte`, SvelteKit
routes, a custom bundler, `defineTable`, `defineSchema`, `QueryRow`, `NorbitalAuthoring`, `$tenant`, or `$lib`.
The compiler rejects the former Page/Pane/Region, layout metadata, split-client, legacy enum, record-rep,
`+create.svelte`, and call-site create APIs; there is no compatibility path.

## Workflow

```bash
# Run from the selected template workspace in a checkout of the public OSS repository.
pnpm sync
pnpm lint
pnpm build
```

Publish through the OSS release workflow before asking Core to consume the change. Before finishing, run
the relevant quality audit, sync, lint, build, and focused behaviour test in OSS.
