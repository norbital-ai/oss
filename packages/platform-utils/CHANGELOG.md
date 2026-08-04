# @norbital-ai/platform-utils

## 0.3.0

### Minor Changes

- Allow channel declarations to opt into host tools via `hostTools`, with configurable sandbox workspace mode via `hostSandbox.workspace`.

  Channel agents still default to no host tools (so WhatsApp/Telegram cannot quietly inherit builder sandbox write). A channel that needs analysis can name tools explicitly; startup refuses names the host does not supply. When `hostTools` is non-empty and `hostSandbox` is omitted, the worktree mounts read-only and scratch (`/workspace/src/.tmp`) stays writable; set `hostSandbox.workspace: 'read-write'` for authoring-style repo mutation.

### Patch Changes

- Updated dependencies
  - @norbital-ai/std@0.0.4

## 0.2.0

### Minor Changes

- a1f5eae: Reorganize the package source layout and finish the HTTP-native tenant runtime transport.

  - `src/lib/` is flattened to `src/`: the folder existed only for the svelte-package convention, and
    the build (`svelte-package -i src`) emits the same `build/` tree, so every published specifier is
    unchanged. The `$lib/*` alias and the `#lib/*` imports map are repointed accordingly.
  - The browser UI moves out of the mislabelled `runtime/` and the client-state modules out of
    `client/` into `src/ui/` — `state/`, `shell/`, `collection/`, `agent/`, `settings/`, `sync/`,
    `subservices/` — with `src/ui/public.ts` as the `@norbital-ai/pod/client` entry. The
    `./client/platform`, `./client/runtime`, and `./client/agent` exports follow their files
    (`build/ui/shell/mount-client.js`, `build/ui/state/client.js`,
    `build/ui/agent/agent-chat-panel.svelte`).
  - `bin/invocation/standalone.ts` is reduced to a re-export; the standalone server it contained
    (`pod start`, migrate, seed, invite, static assets, jobs/channels/webhooks) now lives in
    `src/serve/standalone.ts` beside the hosted adapter.
  - The tenant runtime now serves HTTP directly (`src/serve/hosted.ts`, `src/serve/node-http.ts`)
    instead of the stdio duplex frame protocol; the host reaches it over `/_pod/bootstrap`,
    `/_runtime/*`, and `/_host/*` routes carrying the shared host token. The standalone runner shares
    the same `handlePodRequest`/`handlePodHostCommand` pipeline through `src/serve/node-http.ts`.
  - The serving layer is consolidated into one HTTP server core — `src/serve/server.ts`
    (`createPodHttpServer`, absorbing `src/serve/node-http.ts`) — with two adapters in front of it:
    the hosted adapter (`src/serve/hosted.ts`, which also absorbs `src/serve/bindings.ts`) and the
    standalone adapter (`src/serve/standalone.ts`, whose whole request pipeline now delegates to the
    core, passing the bundled runtime entry it already loaded). The `startPodHttpServer` export the
    generated `serve.mjs` calls is unchanged.
  - The CLI-side helpers move out of `bin/invocation/` into `src/host/` —
    `host-config.ts` → `host/config.ts`, `jobs.ts` → `host/jobs.ts`,
    `webhook-inbound.ts` → `host/webhook-inbound.ts` — leaving `bin/` with the CLI entry and the
    standalone re-export only. The `pod` bin path (`build/bin/invocation/index.js`) and the
    `@norbital-ai/pod/host` public surface are unchanged.
  - `src/remote/approval_request/` flattens to `src/remote/` root files
    (`approval_request.remote.ts`, `approval_request.runtime.server.ts`, `approval_request.schema.ts`).
  - The two serving adapters are renamed to deployment modes so they read as one server with two ways
    to run it: `src/serve/guest.ts` → `src/serve/hosted.ts` (Cube microVM, remote facilities) and
    `src/serve/self-hosted.ts` → `src/serve/standalone.ts` (`pod dev`/`pod start`, in-process
    facilities), both over the shared `src/serve/server.ts` core; the generated `serve.mjs` entry and
    the `startPodHttpServer` contract are unchanged.
  - `src/server/` loses its thin folders: `run/env.ts`, `run/host_plugins.ts`, and `run/facilities.ts`
    move up to `server/env.ts`, `server/host-plugins.ts`, and `server/facilities.ts` so `run/` holds
    only the run pipeline; `audit/audit_event.server.ts` moves up to `server/audit_event.server.ts`;
    `notifications/channels.ts` merges into `notifications/notification-outbox.server.ts`.

### Patch Changes

- Updated dependencies [a1f5eae]
  - @norbital-ai/std@0.0.3

## 0.1.0

### Minor Changes

- ab72b9c: Give the workspace agent a system prompt and a skill library, and let a workspace ship skills of its
  own.

  An interactive conversation in a workspace without `src/+agent.ts` ran with no system prompt at all.
  Nothing told the model what platform it was on, so it filled the gap: it named a vendor and a model
  version it had no way to know, described an administrative console that does not exist, and — having
  found `norbital_approval_id` on every row but no readable `approvals` collection — concluded Norbital
  has no approval system. Each of those reads to a user as a product limitation rather than as a
  guess, which is the part that makes it expensive.

  `AGENT_BASELINE_SYSTEM_PROMPT` is now composed ahead of any authored `systemPrompt` on every turn,
  including automation and channel runs. It carries only what a turn cannot recover from on its own:
  that the agent is a Norbital agent and what it is there for, that its tool list is what it actually
  has and that what bounds its use of the workspace's data is the acting principal's permissions rather
  than a curated tool list, that any filesystem it can reach is shared with everyone in the
  organisation rather than private to a person, and enough of the `src/` layout to name the file a
  change belongs in instead of inventing a settings screen. Those decide the first sentence of a reply,
  before
  any tool call, so a skill the model was never prompted to fetch cannot repair them. Everything with
  depth stays in the skills and loads on demand, because carrying all of it on every turn would be most
  of a context window spent on text the turn never needed. An authored prompt is composed after it and
  still wins a conflict.

  Skills follow the Agent Skills format (https://agentskills.io/specification): a directory with a
  `SKILL.md` carrying `name` and `description` frontmatter, plus reference files loaded only when
  asked for. Two built-in tools replace what would otherwise have been a bespoke documentation tool —
  `list_skills` returns the metadata tier, `read_skill` returns a body or one reference file. Pod ships
  `norbital-platform`, covering approvals and policies, records and history and audit, and what an
  agent can actually do; and `authoring-tenant-workspace`, which moved here out of a private repository
  so that one copy now serves both a workspace agent and the coding agents that build workspaces.

  A workspace can add its own under `src/skills/<name>/`. The compiler validates them against the same
  rules the host-side generator applies — the spec's name regex and length limits, `name` matching its
  directory, required non-empty `description` — and inlines them into the generated workspace, since
  markdown is not importable. Host skills win a name collision and the workspace copy is refused with a
  diagnostic, because a workspace shadowing `norbital-platform` would replace the only correct account
  of how approvals behave. `read_skill` matches file paths verbatim against the list the skill
  advertises rather than joining them onto a root.

  `@norbital-ai/pod/skills` exports the shipped skills as data so a host can offer them through its own
  tooling, and the manifest gains a `skills` entry carrying names and descriptions only.

- 99da5a7: Let a collection declare whether it keeps temporal history, and drop the relation when it stops.

  Which tables get a `<name>_history` relation used to be a hardcoded list inside the migration
  generator, and a differently-scoped list inside the runtime post-DDL. The two disagreed the moment
  one moved: adding the agent transcript tables to the generator's list stopped column changes being
  mirrored into history relations the migration lineage still declared, and nothing ever dropped
  them, so the lineage described two relations that had to evolve together while only one did.

  `history` is now an option on the collection definition itself — `history?: boolean` on
  `ModelMetadata` for a tenant collection and on `SystemTableMeta` for a system one — defaulting to
  true. Both the generator and the post-DDL read that one flag, the generator by importing the model
  that declares it and the post-DDL through the manifest it is published into, so neither can decide
  a collection is temporal while the other decides it is not. Opt out for a high-volume, append-only
  collection whose rows are already ordered by their own sequence, where the history row roughly
  doubles the write cost of every insert to buy a revision trail nothing reads.

  Turning it off is now a schema change like any other. The generator replays the lineage to work out
  which history relations are live, and emits a guarded drop for any whose record table is no longer
  temporal — including into a migration of its own when the flip is the only change, since a change
  drizzle cannot see would otherwise succeed while doing nothing. `chat_session`, `chat_turn`,
  `chat_message` and `audit_event` carry the flag, and the templates carry the drop.

  The post-DDL's history refresh also stops exempting every system collection. It only ever needed to
  skip the ones without history, and the collections that do have one — most of them — were silently
  outside the drift repair that keeps a history relation in step with its table.

### Patch Changes

- 675400c: Let a host offer a choice of model.

  `HostAiBinding` gains an optional `models(): Promise<AiModelCatalog>`, returning the host's default
  alongside the ids it will actually run. Optional rather than required, because a host may hold one
  set of credentials and offer no choice at all — and an empty catalog would misreport that as "no
  models available" rather than "no choice offered".

  The catalog stays on the host side deliberately. The host holds the credentials and decides the
  default, so a guest-side list would be a second source of truth free to disagree with whatever is
  doing the inference. A host that does not implement `models()` renders no picker at all.

- 2cd75e3: Let a host publish each model's context window.

  `AiModelOption` gains an optional `contextLength`. It is model metadata rather than usage — a guest
  holds the token counts but cannot turn them into "how full is the window" without the denominator,
  and inventing one would misreport every conversation. Hosts that omit it get an absolute token count
  and no percentage.

  `chat_session` gains cumulative `usage_cost_usd`, `usage_total_tokens`, `usage_turns_counted` and
  `usage_turns_unreported`, and `chat_turn` gains `usage_settled_at` as the idempotency key for
  accumulating into them.

- c386ba2: Build through turbo when packing, and fail a build that emitted `any`.

  `@norbital-ai/pod@0.0.3` shipped `utcInstantSchema` and `clockTimeZodSchema` as `any`, and `dateRangeZodSchema` as `{ start: any; end: any }`. The cause was ordering, not types. Every publishable package declared `"prepack": "pnpm build"` — its own build, run directly. `changeset publish` therefore compiled each package outside turbo's `^build` ordering, and the release workflow installs with `--ignore-scripts` and never builds, so `packages/std/build` did not exist when pod compiled. The two constants infer their type through `isUtcIsoInstant`/`isClockTime`, imported from `@norbital-ai/std/date`; with nothing to resolve, the predicate became `any`, the `.refine()` overload collapsed, and `svelte-package` wrote the degraded declaration and exited 0.

  The published `any` then became an index signature that flowed through `TablesForModels`, collapsing `TableName<S>` to `string`, stripping the named tables off `DbRelationalQueryRoot`, and pushing `AfterDbApi` onto its `string extends TableName<…>` branch — in every workspace, including ones with no `dateRange()` column.

  Three changes, none of them a type annotation:

  - `prepack` now runs `pnpm exec turbo run build --filter=<package>`, so packing goes through the dependency graph rather than around it. `prepack` is the only hook common to every path that produces a tarball — `changeset publish`, a developer's `pnpm pack`, and `publication:check` — which is why the ordering is fixed there rather than in the release workflow.
  - `scripts/build-package.mjs` refuses to start the compiler when a `workspace:` dependency has a build script but no `build/`, and reads its own emitted declarations back before swapping them in, discarding any output that contains `any` in type position. Both cost milliseconds, so they run on every build, publishing included.
  - `publication:check` unpacks each archive and re-runs that assertion against the bytes that would reach the registry. A GitHub Packages version can never be reused, so a poisoned publish is permanent.

  The two constants stay unannotated: with the ordering fixed, inference emits `z.ZodString` on its own.

- ab72b9c: Scope the seed executor's user-id-by-email cache to one tenant.

  A `user` payload's relationship links cannot use the id in the payload: `insertSeedRows` upserts
  users on `email` and deliberately leaves `norbital_id` alone, so a person the tenant already has —
  the founder, written by provisioning before any seed runs — keeps the id they were provisioned
  with. The executor therefore reads the id back out of the database by address before writing the
  `team_members` rows.

  That read was memoised in a module-level `Map` keyed on the address alone. One process seeds every
  tenant in a full environment reset, so the first tenant to write an address decided its id for all
  of them. Two templates seed `zuyao.liu@norbital.ai` under different ids, and whichever ran second
  inserted a `team_members` row pointing at a `user` row that exists only in the other tenant's
  database — `team_members_user_id_user_norbital_id_fkey`, and the reset exited 1.

  The cache is now created per `seedTemplateDataFromPlan` call, which is one tenant, matching
  `seedTableMetadataCache` beside it. The memoisation itself is unchanged, so a tenant that already
  holds an address still links to the id it already has rather than the payload's.

- Updated dependencies [ab72b9c]
- Updated dependencies [c386ba2]
  - @norbital-ai/std@0.0.2

## 0.0.1

- Initial public release of the shared host, manifest, seed, storage, and tenant database contracts.
