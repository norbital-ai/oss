# @norbital-ai/pod

Pod is the framework for Norbital tenant workspaces. A workspace is a plain Svelte/Vite project:
Pod provides the filesystem compiler, authoring API, application shell, client proxy, server runtime,
and Vite plugin. Core is one host for Pod output; Pod itself does not depend on Core.

## Architecture

- [Documentation index](./docs/README.md)
- [Pod overview](./docs/OVERVIEW.md) — lifecycle, authoring surface, runtime boundary, and commands
- [Form system](./docs/FORM_SYSTEM.md)
- [Navigation state](./docs/NAVIGATION_STATE.md)
- [Sync engine](./docs/SYNC_ENGINE.md) — native live queries and optimistic writes

## Workspace contract

```text
workspace/
├── src/
│   ├── collections/
│   │   ├── +relationship.ts
│   │   └── <collection>/{+model.ts,+hooks.ts,+pipelines.ts,+integrations.ts,+representation.svelte}
│   ├── custom-types/<name>/{+definition.ts,+renderer.svelte}
│   ├── apps/**/+<lower_snake_case>.svelte
│   ├── automation/+<lower_snake_case>.ts
│   ├── remotes/+<lower_snake_case>.ts
│   └── +seed.ts
├── package.json
├── tsconfig.json
└── vite.config.ts
```

The compiler derives registry assembly, workspace metadata, client bindings, app loaders, and local
role types from those paths. Tenant authors do not create assembly files.

`vite.config.ts` is the only framework configuration:

```ts
import { pod } from '@norbital-ai/pod/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [pod()] });
```

There is no SvelteKit in a tenant workspace: no `svelte.config.*`, routes, `+page` files, `$app/*`, or
`@sveltejs/kit`. `pod()` installs the Svelte and Tailwind Vite integrations and discovers
`src/apps/**/+<lower_snake_case>.svelte`. App, automation, and remote IDs come from their filenames.

## Public imports

| Import                              | Purpose                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| `@norbital-ai/pod/authoring`        | Models, hooks, automations, handlers, and server authoring types |
| `$pod/client`                       | Generated unified typed client and app loaders                   |
| `@norbital-ai/pod/vite`             | `pod()` Vite plugin and filesystem compiler                      |
| `@norbital-ai/ui/collection-table`  | Typed table collection surface                                   |
| `@norbital-ai/ui/collection-form`   | Schema-derived form collection surface                           |
| `@norbital-ai/ui/collection-kanban` | Kanban collection surface                                        |
| `@norbital-ai/ui/data-renderer`     | Schema-aware field display and editing                           |
| `@norbital-ai/ui/layout`            | Portable layout primitives                                       |
| `@norbital-ai/ui/page-header`       | Presentational application heading                               |

Workspaces import shared peers directly: `svelte`, `zod`, `runed`, `@iconify/svelte`, and `vite`.
Pod does not re-export them or portable UI. `@norbital-ai/pod/authoring/internals` is compiler-generated
assembly glue and must not appear in authored `src/**`.

### View system

Tenant UI uses schema-driven defaults for mobile cards, forms, and detail from **declaration order** and
**field kinds** on `+model.ts`. Models carry zero presentation metadata. Every `CollectionTable` **requires**
an explicit `{#snippet columns({ Column })}` — table UI does not auto-derive columns and never accepts
`fields=`. Collection-owned `+representation.svelte` (with generated nullable-record
`RepresentationProps`) is the only create/display/edit override. Custom datatype renderers are discovered statically from
`custom-types/`; there is no manual registry. Apps compose `PageHeader` with `Stack`, `Inline`, `Cluster`,
`Split`, `Grid`, `Columns`, `Cover`, `Center`, and `Frame`; local scrolling is explicit `Bound` + `Scroll`. See
[template_workspaces/](../../template_workspaces/) for authoring conventions and examples.

Each custom type owns its schema in `+definition.ts` and its UI in `+renderer.svelte`. Definitions may
compose other filesystem custom-type schemas, but cannot import schema authority from a collection.

## Queries and mutations (sync engine)

Pod reads and writes go through a sync engine that maintains a local PGlite replica of
policy-scoped data. Every read is a live, reactive query; every write is optimistic.

```typescript
import { client } from '$pod/client';

// Live read — re-executes locally when data changes. No `refetch`, no `invalidate`.
const orders = client.db.orders.findMany({
	where: { status: { eq: 'open' } },
	with: { customer: true },
	orderBy: { created_at: 'desc' },
	limit: 25
});

// Optimistic write — UI updates same-frame. Server confirms or rejects.
await client.db.orders.create({
	customer_id: customerId,
	amount: 1500
});
```

**The invariant:** the read path never waits for data this device has already seen. Every server
answer folds back into the local replica, so the second visit to anything is instant.

**What the sync engine handles for you:**

- **Live reads** — queries re-execute locally when a matching collection changes, no manual refresh
- **Optimistic writes** — mutations apply to a local overlay before the server responds
- **Policy scoping** — rows outside your permission scope never reach local storage
- **Warm reload** — sync state is persisted; a reload renders from local data on frame 1
- **Instant relations** — `with: { customer: true }` is a batched local join, not N queries

Full architecture: [Sync Engine](./docs/SYNC_ENGINE.md).

## Generated state

`pod sync` and Vite builds use one generated root:

```text
.norbital/
├── diagnosis/     ignored structural and type diagnostics
├── dist/          ignored client, server, runtime, and SQL output
├── generated/     ignored registry, workspace, app, and client modules
├── migrations/    committed Drizzle migration history
├── types/         ignored role-local declarations
└── tsconfig.json  ignored generated TypeScript configuration
```

The authored root `tsconfig.json` extends `.norbital/tsconfig.json`. The generated config owns all
compiler paths and does not set `baseUrl`.

`vite build` compiles and validates the filesystem, runs sequential native TypeScript and Svelte checks,
builds the server and client environments, and writes deployable output to `.norbital/dist/`. Queries, hooks, automations,
and remotes execute only in the server bundle. The browser bundle contains tenant applications, Pod
UI, and the HTTP client proxy.

Pod imports `@norbital-ai/ui/base.css` through its virtual client entry. Tenant apps must not add a
second base stylesheet or Tailwind integration.

## Development

```bash
pod dev
pnpm --filter @norbital-ai/pod lint
pnpm --dir template_workspaces/hr-payroll sync
pnpm --dir template_workspaces/hr-payroll build
```

Start with the [Pod overview](./docs/OVERVIEW.md) for the generated-state contract, command reference,
trust boundary, and the complete tenant-template examples.

## Standalone runtime

Pod can build and host a workspace without Core:

```bash
pod build
pod migrate
pod seed       # optional; executes src/+seed.ts when present
pod start
```

`pod dev` performs `build` and `migrate` before serving. Use `pod dev --seed` when the authored fixture
should also run. Restart is an ordinary graceful process restart: stop `pod start` with `SIGTERM`, then run
`pod start` again against the same database and `.norbital/build` build.

Standalone startup has no credential or identity fallbacks. Every command other than `sync`, `check`, and
`build` requires:

| Variable                 | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `DATABASE_URL`           | PostgreSQL 18+ connection string                                   |
| `POD_HOST` / `POD_PORT`  | HTTP listen address                                                |
| `POD_ORG_ID`             | Organization UUID used by migration and seed bootstrap             |
| `POD_ORG_NAME`           | Organization name used by migration and seed bootstrap             |
| `POD_ADMIN_ID`           | Seed administrator UUID                                            |
| `POD_ADMIN_NAME`         | Seed administrator display name                                    |
| `POD_ADMIN_EMAIL`        | Seed administrator email                                           |
| `POD_TEMPLATE_KEY`       | Seed provenance key                                                |
| `POD_TRUSTED_HOST_TOKEN` | 32-byte minimum shared token used only on the host-to-Pod boundary |

The built-in server accepts only a loopback `POD_HOST`. Put a trusted authenticated host in front of it;
that host adds `x-norbital-host-token`, the user and organization headers, and a complete
`x-norbital-base-scope-json` for each protected request. Pod validates that the user, organization, role,
and team scope agree before its normal policy evaluator runs. Browser-controlled headers never select a
static administrator or bypass policy.

The built-in host implements `db` with isolated PostgreSQL transactions. Required facilities are derived
from the built manifest instead of a manual environment list: file fields require `fileStorage`,
geolocation requires `maps`, integrations require delivery plus `queue`, and automations require `queue`
(and `ai` for an agent specification). A DB-only standalone host rejects such a workspace before listening;
use a host that implements every reported facility.

Commit workspace source and `.norbital/migrations/`. Ignore `.norbital/diagnosis/`,
`.norbital/dist/`, `.norbital/generated/`, `.norbital/types/`, and `.norbital/tsconfig.json`.

Host checkpoint implementation is deliberately outside Pod's public package contract. Authoring
conventions and examples live in [template_workspaces/](../../template_workspaces/). For how reads
and writes work end-to-end, see [Sync Engine](./docs/SYNC_ENGINE.md).
