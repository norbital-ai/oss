# Pod runtime map

Pod is a host-agnostic Svelte runtime for filesystem-authored tenant workspaces. The same compiled
artifact runs inside Core or an explicit self-hosted adapter. A workspace is a plain Vite root; it has
no SvelteKit routes, adapters, configuration, or imports.

```text
src/** authoring → .norbital/generated/** → server runtime → HTTP transport → generated client → collection UI
```

## Authoring contract

Tenant-authored source lives under `src/`:

```text
src/
├── collections/
│   ├── +relationship.ts
│   └── <id>/{+model.ts,+hooks.ts,+pipelines.ts,+integrations.ts,+representation.svelte}
├── custom-types/<name>/{+definition.ts,+renderer.svelte}
├── apps/**/+<lower_snake_case>.svelte
├── automation/+<lower_snake_case>.ts
├── remotes/+<lower_snake_case>.ts
├── policies/+<lower_snake_case>.policy.ts
├── channels/+<lower_snake_case>.channel.ts
├── **/+<lower_snake_case>.tool.ts
├── +agent.ts
├── +env.ts
└── +seed.ts
```

Only `+model.ts` is required for each collection; the other collection roles and `+seed.ts` are optional.
Apps contain static `<svelte:head>` metadata: a literal title, optional description, literal `pod:icon`, and
optional static thumbnail/banner URLs. The shell owns document scroll; app bodies compose `PageHeader` with
Pod layout primitives. Local scroll regions are explicit `Bound` + `Scroll` pairs.
App, automation, remote, and agent-tool IDs come from their `+<lower_snake_case>` filenames.

`pod sync` validates the tree and writes one `.norbital/` tree:

- `diagnosis/`, `dist/`, `generated/`, `types/`, and `tsconfig.json` are ignored;
- `migrations/` is committed;
- the authored root `tsconfig.json` extends `.norbital/tsconfig.json`;
- the single generated config contains relative path mappings and no `baseUrl`.

Ignore those generated paths explicitly rather than ignoring `.norbital/` itself, because
`.norbital/migrations/` is source-controlled.

Authored roles import their adjacent `./$types.js`; apps import the unified typed `client` from
`$pod/client`. Generated state is never hand-edited.

Tenant authors must not create `schema.ts`, `workspace.ts`, collection `*.schema.ts`, assembly barrels, or
manual registries. `defineTable`, `defineSchema`, `QueryRow`, global `NorbitalAuthoring` augmentation,
`$tenant`, `$lib`, `collections/**/*.schema.ts`, and `apps/*/App.svelte` are not supported tenant contracts.
Internal platform system-database `.schema.ts` modules are unrelated.

## Runtime

`server/entry.ts` owns request context and dispatches public runtime operations plus private host
commands. `ui/state/client.ts` exposes the browser API proxy. `ui/shell/pod-shell.svelte` supplies the
frame, Pod router, and Pod-owned agent UI without importing SvelteKit.

Server handlers, hooks, automations, agent loops and tools, pipelines, integrations, remotes, and query
execution are reachable only from the server bundle. The client bundle contains tenant apps, the Pod
frame, agent presentation, app loaders, and HTTP proxy. Transcript rows remain tenant data and replicate
through ordinary sync; a host supplies one-turn AI and optional host tools but stores no transcript.

## Build

`vite/index.ts` owns the tenant build lifecycle:

1. Synchronize and structurally validate `src/**`, preserving last-valid generated modules on failure.
2. Run native TypeScript against the complete generated config, then run the Svelte component check, and
   publish their combined diagnostics.
3. Build the generated server workspace.
4. Build the generated client and flat app loaders.
5. Generate migrations from the generated registry and Pod system tables.
6. Write runtime, static, migration, and schema SQL artifacts under `.norbital/dist/`, while preserving
   committed migration history under `.norbital/migrations/`.

The plugin installs the Svelte and Tailwind integrations. Its client entry imports packaged `app.css`, which
imports `@norbital-ai/ui/base.css`; emitted CSS assets are linked from generated `dist/index.html`. Workspaces
must not add `svelte.config.*`, a second Tailwind plugin, duplicate base CSS, or a custom build script.

## Public surfaces

- `@norbital-ai/pod/authoring`: filesystem declarations and generated-role support types.
- `@norbital-ai/pod/authoring/internals`: compiler-generated assembly glue; tenant source never imports it.
- `@norbital-ai/pod/client`: shared client contexts and generated client factories.
- `@norbital-ai/pod/vite`: `pod()` plus filesystem compiler APIs.
- `pod sync`: one-shot generated-state synchronization.
- `pod sync --watch`: headless Vite watcher for topology/type diagnostic synchronization.

Tenant workspaces import peer dependencies directly: `svelte`, `zod`, `runed`, `@iconify/svelte`, and
`vite`. Pod does not re-export them. Vite deduplicates these peers so Pod and tenant source share one instance.

## Sync engine

Pod's reads and writes go through a sync engine that maintains a local PGlite replica of the
policy-scoped data a user is authorised to see. The sync unit is the **collection**, not the
query shape — so filtering, sorting, pagination, and relations are pure local SQL.

- **Client:** `ui/sync/` — PodSyncClient (connect, catch-up, diff application), live query
  registry, PGlite SharedWorker, optimistic write overlay
- **Server:** `server/collection/sync/` — wire protocol (`/_runtime/sync/shape|stream|mutate`; the client DDL rides on `/_pod/bootstrap`),
  sync_outbox change feed, outbox tailer with `(xid, seq)` cursor management, PostgreSQL NOTIFY/LISTEN

For the full architecture, invariants, and how to author queries and mutations, see
[`packages/pod/docs/SYNC_ENGINE.md`](../../docs/SYNC_ENGINE.md).
