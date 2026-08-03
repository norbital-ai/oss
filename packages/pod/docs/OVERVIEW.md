# Pod overview

Pod is the filesystem-first framework used to build Norbital tenant workspaces. A tenant workspace is
a normal Svelte and Vite project: authors describe collections, apps, custom types, automations, and
server remotes under `src/`; Pod derives the registry, types, client, database migrations, runtime, and
application shell. Pod has no dependency on a particular host product.

The package [README](../README.md) is the canonical end-to-end guide. This page is the short
lifecycle reference.

## From source to running workspace

```text
tenant src/**
  → pod sync validates topology and generates typed assembly
  → Vite builds isolated server and browser bundles
  → host supplies identity, policy scope, storage, and optional facilities
  → browser uses a generated client backed by a local policy-scoped replica
```

The tenant owns authored source and committed migration history. Pod owns every other generated file in
`.norbital/`; never edit generated output by hand.

## Authoring surface

| Location                                      | Purpose                                                  |
| --------------------------------------------- | -------------------------------------------------------- |
| `src/collections/<id>/+model.ts`              | Required collection model and metadata.                  |
| `src/collections/<id>/+hooks.ts`              | Optional server-side validation and lifecycle behaviour. |
| `src/collections/<id>/+pipelines.ts`          | Optional export and processing pipelines.                |
| `src/collections/<id>/+integrations.ts`       | Optional inbound and outbound integration behavior.      |
| `src/collections/<id>/+representation.svelte` | Optional collection-specific create/display/edit UI.     |
| `src/collections/+relationship.ts`            | Relationship definitions between authored collections.   |
| `src/custom-types/<name>/+definition.ts`      | Reusable validated data type.                            |
| `src/custom-types/<name>/+renderer.svelte`    | Display and edit renderer for that type.                 |
| `src/apps/**/+<lower_snake_case>.svelte`      | Browser application surfaces discovered by filename.     |
| `src/automation/+<lower_snake_case>.ts`       | Scheduled or collection-event server automations.        |
| `src/remotes/+<lower_snake_case>.ts`          | Typed server query and command handlers.                 |
| `src/**/+<lower_snake_case>.tool.ts`          | Opt-in, compiler-discovered workspace agent tool.        |
| `src/+seed.ts`                                | Optional standalone development seed.                    |
| `pod.host.ts`                                 | Required Core or self-hosted deployment target.          |

Tenant code imports declaration helpers from `@norbital-ai/pod/authoring`, the Vite plugin from
`@norbital-ai/pod/vite`, and the generated typed browser client from `$pod/client`. The
`@norbital-ai/pod/authoring/internals` entry point is generated assembly glue, not a tenant API.

## Workspace setup

```ts
// vite.config.ts
import { pod } from '@norbital-ai/pod/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [pod()] });
```

This is the only framework configuration. Pod installs Svelte and Tailwind integrations, its base CSS,
and the application shell. A workspace must not add SvelteKit, `svelte.config.*`, routes, a second
Tailwind plugin, another base stylesheet, manual registries, or hand-written schema assembly.

## Commands and generated state

| Command                       | Use                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- |
| `pod sync`                    | Validate filesystem topology, generate assembly, and generate migrations. |
| `pod sync --watch`            | Continuously synchronize topology and diagnostics while authoring.        |
| `pod check`                   | Run the complete generated TypeScript and Svelte check.                   |
| `pod build`                   | Produce a standalone Pod build.                                           |
| `pod migration create <name>` | Create a named schema migration; add `--custom` for a data migration.     |
| `pod migrate`                 | Apply migrations in a standalone runtime.                                 |
| `pod seed`                    | Run the optional authored seed in a standalone runtime.                   |
| `pod start`                   | Serve an existing standalone build.                                       |
| `pod dev [--seed]`            | Build, migrate, optionally seed, then serve.                              |

`pod sync` and builds write the following root:

```text
.norbital/
├── diagnosis/      # ignored diagnostics
├── dist/           # ignored deployable output
├── build/          # ignored standalone output
├── generated/      # ignored source assembly
├── migrations/     # committed source history
├── types/          # ignored generated declarations
└── tsconfig.json   # ignored generated compiler configuration
```

The authored root `tsconfig.json` extends `.norbital/tsconfig.json`. Commit authored workspace
source, `pod.host.ts`, and `.norbital/migrations/`; ignore the other generated entries.

## Runtime and trust boundary

The browser never talks to tenant hooks or server handlers directly. Pod’s server runtime receives a
request from a host identity provider, resolves or validates its user, organisation, role, and base
scope, then evaluates ordinary policy before executing server code. The standalone runtime listens
only on a loopback address; a production self-hosted `pod.host.ts` must provide its identity provider.

Hosts implement facilities structurally required by the built workspace. A DB-only host can run a
workspace that needs only database access; file fields require file storage, and automations and
integrations require queue and delivery facilities as applicable. Non-inferable direct calls such as
AI, external notifications, and map lookups require the corresponding active host binding when
invoked — a stored geolocation needs no provider to read or render, so it does not gate startup.

## Data and sync model

The generated client exposes live queries and optimistic mutations. It maintains a local PGlite replica
containing only the rows allowed by the current policy scope; filtering, ordering, pagination, and
relations are local once data has arrived. Server responses fold back into that replica, so there is no
manual cache invalidation or query refetch cycle.

See [Sync engine](./SYNC_ENGINE.md) for the protocol, consistency model, and query/mutation guidance.

## Learn from a complete workspace

The templates are executable documentation as well as starter projects:

| Template                                                              | Focus                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Field Operations](../../../template_workspaces/field-operations/)             | Contractor dispatch, qualifications, variations, and photo evidence.          |
| [Construction Operations](../../../template_workspaces/construction/) | Projects, permits, quality, BIM references, claims, and workforce compliance. |
| [CRM](../../../template_workspaces/crm/)                              | Accounts, quoting, fulfilment, payments, and sales operations.                |
| [HR & Payroll](../../../template_workspaces/hr-payroll/)              | Multi-country payroll, attendance, leave, and statutory reporting.            |
| [Reclamation](../../../template_workspaces/reclamation/)              | Geospatial reclamation planning, costs, execution, and reconstruction.        |

Use `sync`, `lint`, and `build` in a template before changing it. A production tenant receives an
immutable template commit with its own committed package lockfile; editing a local template
directory never changes an already-provisioned tenant.

Templates are published as root-projected Git refs and consumed at exact commits. Pod and the other
public packages are supplied by an npm-compatible registry and resolved by each template's lockfile.
Package archives are generated release inputs and are not committed inside `packages/pod`. See the
[distribution contract](../../../release/README.md) for the provider-neutral template and package
boundaries.
