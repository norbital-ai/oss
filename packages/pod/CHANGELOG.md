# @norbital-ai/pod

## 0.4.0

### Minor Changes

- ce88fce: Make the host-owned stdio channel the only way a hosted guest reaches its host

  **Breaking for hosted deployments.** A hosted guest no longer speaks HTTP to its host, so this
  version of `@norbital-ai/pod` cannot run under a host that has not learned the stdio wire. Standalone
  and self-hosted workspaces (`pod dev`, `pod start`) are untouched — nothing about that path changes.

  A hosted guest reaches its host for every facility call — the database above all, once per SQL
  statement while a request is being served. It used to do that over its own outbound HTTP
  connections, which requires the sandbox to have a way out. It does not: on a sealed sandbox the
  egress allow rule is programmed into the firewall and the traffic still does not arrive. So the
  outbound client is deleted rather than deprecated. There was no deployment it could serve and
  keeping it would have meant keeping a second code path that only ever fails, silently and late.

  `platform-utils` carries the length-prefixed frame codec both ends share. Pod speaks it over the
  guest process's own stdin and stdout. The direction of requests is unchanged — the guest still asks,
  because it must — but the channel is opened by the host, so the guest never dials out and the
  sandbox can be closed.

  A host must now:

  - start the guest process with a writable stdin and a readable stdout, and speak frames over them;
  - push a `configure` frame carrying `hostPlugins` before the guest will bind its port, and answer
    each `binding` request frame with a `binding` response correlated by `id`;
  - wait for the guest's `ready` frame rather than for the process to exist, since a process that
    started and a runtime that can answer are different things;
  - stop setting `NORBITAL_CORE_URL` and `NORBITAL_BINDING_SECRET`, which are no longer read. The
    channel the host opened is itself the capability; a shared secret over a host-opened pipe proved
    nothing. `POD_HOST_TOKEN` is still required and still faces the other way, gating inbound traffic
    from the host's proxy;
  - read the guest's diagnostics on stderr. stdout carries frames and nothing else: the real stdout is
    claimed before the workspace bundle is imported and `process.stdout.write` is pointed at stderr, so
    a `console.log` anywhere in the process — including in a dependency — cannot corrupt the stream.

  `NORBITAL_RUNTIME_TRANSPORT` is gone with the transport it selected.

### Patch Changes

- Updated dependencies [ce88fce]
  - @norbital-ai/platform-utils@0.4.0
  - @norbital-ai/ui@4.0.0

## 0.3.0

### Minor Changes

- Allow channel declarations to opt into host tools via `hostTools`, with configurable sandbox workspace mode via `hostSandbox.workspace`.

  Channel agents still default to no host tools (so WhatsApp/Telegram cannot quietly inherit builder sandbox write). A channel that needs analysis can name tools explicitly; startup refuses names the host does not supply. When `hostTools` is non-empty and `hostSandbox` is omitted, the worktree mounts read-only and scratch (`/workspace/src/.tmp`) stays writable; set `hostSandbox.workspace: 'read-write'` for authoring-style repo mutation.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @norbital-ai/platform-utils@0.3.0
  - @norbital-ai/std@0.0.4
  - @norbital-ai/ui@3.0.0

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
- Updated dependencies [a1f5eae]
  - @norbital-ai/platform-utils@0.2.0
  - @norbital-ai/std@0.0.3
  - @norbital-ai/ui@2.0.0

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

- ab72b9c: Bound a channel agent by its profile's policy rather than by a short tool list.

  A Telegram or WhatsApp agent was built a spec inline from the channel's declared `task` and nothing
  else, which meant it defaulted to `access: 'read'`, named no workspace tools and no host tools, and
  never read `src/+agent.ts`. In practice a channel agent held four tools — `describe_workspace`,
  `read_collection`, `list_skills`, `read_skill` — and a workspace had no way to widen it. Meanwhile the
  baseline system prompt told that same agent it had been given the whole tool surface and was bounded
  by permission rather than by which tools it was handed. On the channel path that was not true.

  It is now, for the workspace's own surface. A channel run takes `access: 'write'` and every workspace
  agent tool, the same as an interactive run with no authored profile. Nothing there is curated per
  agent, because an agent is bounded by what its principal may do and a narrower tool list removes
  capability without removing reach — while reading, to anyone auditing it, as though the tool list
  were the containment.

  What bounds a channel run is the principal it acts as. An interactive run inherits the signed-in
  user's permissions; a channel may be a group chat, so there is no single person behind it to inherit
  from, and the run acts as the channel's own `kind='agent'` principal, which `pod migrate` places in a
  team carrying the channel's declared `policy`. `read_collection` and `write_collection` run
  unelevated, so every read and write meets that policy, its hooks and its approval gates exactly as
  any other principal would. A channel principal whose team was never reconciled holds no grants and is
  refused outright — the profile is the boundary, and there is deliberately no second, tool-shaped one
  beside it that could disagree with it.

  An authored `src/+agent.ts` is supplementary on this path rather than authoritative, which is the one
  place a channel differs from interactive chat. Its prompt, model and budgets are carried; its
  `collections`, `access`, `tools` and `hostTools` are not, because permission here belongs to the
  channel's policy and a file able to widen or narrow it from the side would make that policy advisory.
  The channel's declared `task` composes last — after the baseline prompt and after the authored one —
  so the most specific instruction is the one the model reads last.

  Host tools are the part the channel's policy does not bound, so a channel run is offered none of
  them. A host tool carries no requestor, so it authorizes on the principal it _acts as_, and nothing
  in a channel declaration chooses that principal — a host is free to resolve it to something that is
  not the channel, and a host running one runtime per organization resolves it to one builder for
  everybody. A channel run holding a shell or file-writing host tool would therefore not be refused by
  its policy; it would succeed as that builder, against the workspace's own source tree, from a group
  chat anyone in the group can post to. `channelAgentSpec` names `hostTools: []` until a binding frame
  can carry the acting principal, at which point a channel run should get the host tools its own
  principal is entitled to.

- ab72b9c: Stand in for integration delivery under `pod dev`, so declaring an integration cannot make a
  workspace unrunnable locally.

  A workspace whose manifest carries an integration requires `integrationDelivery` before it starts,
  and that gate is right: the outbox has nowhere to drain without it, so a workspace that booted anyway
  would accumulate rows that retry with backoff and dead-letter after ten attempts, far from the cause.
  What was missing is the other half of the bargain Pod already makes for messaging. The development
  host `pod dev` builds for a `mode: 'core'` target holds none of the credentials an outbound call
  needs, so it declared no delivery at all — and a Core-targeted workspace that declares an integration
  therefore refused to start, naming a facility no development machine could ever have supplied, on the
  one command that is meant to run it. The `crm` template is exactly that workspace: it stopped being
  runnable with `pod dev` the moment it gained its external-system integration.

  `consoleIntegrationDelivery()` is the counterpart of `consoleMessaging()`. It logs the binding, the
  record, the declared destination and the payload instead of putting them on a wire, and reports
  success so the local outbox settles instead of filling with retries an author has to explain while
  working on something else entirely. `pod dev` supplies it and nothing else does. A deployed host still
  names `httpIntegrationDelivery()` or a function of its own, and `pod start` still refuses a
  self-hosted configuration that names neither — a real deployment quietly writing its outbound
  deliveries to a console is the failure this must not turn into.

- 1008494: Expose the elevated server API to workspace code as `getElevatedApi()` from
  `@norbital-ai/pod/authoring`.

  Tenant code could previously have elevated writes or reads, never both. An `after` hook receives
  `AfterHookApi`, whose `db` is an `ElevatedMutationApi` — permission-bypassing writes and no `query`.
  A remote command handler receives `BeforeApi` — `query`, but ordinary permission-checked writes.
  Anything that reads previous state and writes a derived record from it could satisfy neither, and
  both workarounds fail in the same direction: a command handler writing unelevated is refused for any
  role whose policy grants read on the derived collection but not create, and a hook reaching for
  `api.db.query` calls a method that is not on the object it was handed.

  `getElevatedApi()` returns the `AfterApi` the runtime already builds internally, which carries both
  halves. It is loaded on call rather than at module scope, so `@norbital-ai/pod/authoring` stays free
  of `node:async_hooks` for workspace definitions that are also read in the browser.

  Elevation bypasses policy for every read and write made through it. It is for records the workspace
  itself authors — a derived projection, a computed rollup, an audit row — not for carrying out
  something a user asked for on their own behalf.

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

- ab72b9c: Let a self-hosted pod's owner keep their own skills, by reading the filesystem the run is already on.

  A workspace skill is committed under `src/skills/` and belongs to everyone in the tenant, which is
  right for the things a tenant agrees on and wrong for everything else. Somebody who works out the
  exact phrasing that gets a report out the way they want it has nowhere to put that: committing it
  imposes their preference on colleagues who did not ask for it, and not committing it means retyping
  it into every conversation. The gap was never a missing feature so much as a missing place.

  Under `pod dev` and `pod start` the place already existed. One process runs on one working directory
  for one principal, so the filesystem a run is executing on is already that person's own box, and
  `.agents/skills/<name>/SKILL.md` is already the convention this repository uses for skills an agent
  should find locally. A personal skill is therefore simply a skill present in that directory,
  discovered by reading it at run time, committed nowhere and shared with nobody.

  Read the scope carefully, because it is narrower than "personal skills work". This is a self-hosted
  feature. Under a host that runs one tenant runtime per organization — Core does — there is no
  per-person filesystem for discovery to find. `personalSkills()` reads `.agents/skills/` beneath
  `NORBITAL_POD_SANDBOX_DIR` or the working directory, and Core sets neither to anything writable: its
  guest starts on `/app`, an immutable checkpoint bundle mounted read-only, so discovery correctly
  finds nothing and every run gets exactly the host and workspace skills it got before. Pointing that
  variable somewhere writable would not fix it either, which is the part worth understanding. One
  process environment variable cannot name a different directory per person, and the process is shared
  by the whole organization, so the result would be organization-wide skills wearing the word
  "personal". Nor is there a writer: `sandbox_write_file` edits the build sandbox, which is a different
  guest from the one that would read this. What is missing is not a path but an acting principal on the
  binding frame that reaches the host, and that gap is written up in `docs/AGENT_ARCHITECTURE.md`.

  The design rationale holds regardless of which of those a deployment is. There is no user id anywhere
  in the discovery path, and there should not be: it asks the filesystem what is on it. A self-hosted
  run has one principal, so the files are theirs by construction. A channel agent has no single person
  behind it at all — a Telegram or WhatsApp group is permissioned by profile precisely because asking
  which participant owns the channel's skills is a question with no answer. Filtering by acting user
  would be redundant in the first case and incoherent in the second.

  Two kinds of skill, then, rather than three sources: system injected, which is what Pod compiles into
  its own package and merges into every run; and file-based discovered, which is workspace and personal
  differing only in which filesystem holds them and whether it is committed. All three read as one flat
  namespace, resolved host, then workspace, then personal. Host still wins outright — a personal skill
  shadowing `norbital-platform` would replace the only correct account of how approvals behave exactly
  as a workspace one would — and workspace beats personal because a shared answer should not be
  quietly substituted for one filesystem's runs. The losing copy is dropped rather than merged.

  Discovery reuses the frontmatter parser and the name rule the other two kinds are already held to, so
  a skill someone wrote for a workspace is a skill they can drop into a directory unchanged. Failure is
  soft in a way the compiled path does not need to be: there is no build to report a diagnostic to and
  nobody watching one, so a malformed document, an unreadable file or a directory that is not a skill
  at all costs that one skill and warns, rather than taking `list_skills` down for the run and losing
  the platform skills over a typo in a personal one. Nothing is cached, so a file written mid-session
  is usable in the next turn; the read is one directory of small markdown files, behind a model
  inference that costs orders of magnitude more.

- e4df75a: Name the Settings section for what an admin does in it, not for who implements it.

  Pod's own settings entry was `Tenant workspace` under a database icon, which named the storage the
  rows sit in rather than the members, invitations, teams and audit trail an admin opens it to manage.
  It is now **People** (`lucide:users`), and the surface's own heading follows.

  `resolveBillingSettingsHref` replaces the inline `core-billing` lookup the trial banner used. It
  resolves `core-organization` and appends `?tab=billing`, because a host that groups its
  organization-scoped settings into one tabbed surface needs the tab named for the deep link to still
  land on the payment form; the shell already forwards `location.search` into the host frame.

  **Migration for hosts:** a host that registered separate `placement: 'settings'` plugins for
  billing, organization profile and channel credentials should register one `core-organization`
  plugin that reads `?tab=` and selects among them. A host that keeps a standalone billing plugin
  under any other key loses the banner's "Add payment method" action, which degrades to no action
  rather than to a broken link.

### Patch Changes

- 2cd75e3: Compact the agent's context visibly, nest subagents, and report the run's real usage.

  The window was trimmed by a recency limit and a scan back to the nearest user message, recomputed
  every turn. Old turns fell out of the model's view with nothing recording that they had, and the
  same conversation produced a different starting point each time it ran. Compaction now writes a
  durable checkpoint — an ordinary `chat_message` with `kind = 'summary'` — and the window builder
  starts from the newest one. Nothing is deleted: the transcript below a checkpoint stays readable in
  full, behind a tab beside the summary, so a reader can always see what a recap replaced. `/compact`
  forces one and takes optional instructions steering what the summary keeps; it is matched against
  the whole message, so prose that merely begins with the word is still prose.

  A subagent writes into its parent's session, so its rows interleaved into the parent transcript and
  the task handed to the child rendered as a bubble labelled "You". A delegated run now renders inside
  the call that spawned it, through the same component as its parent and with no composer of its own.

  The composer reports context-window occupancy, total tokens and cost. Every figure comes from the
  provider's own accounting on `chat_message.usage`; the window it is measured against comes from the
  host's model catalog. Anything the host did not report is absent rather than estimated — in
  particular there is no cost derived from a price list, because a number a reader takes for a bill
  has to be the bill.

  A conversation's spend is now accumulated onto `chat_session` as each turn settles, rather than
  summed from the messages on screen: a derived total falls when a message is deleted, and what was
  spent does not. The increment claims its turn through `chat_turn.usage_settled_at` in the same
  statement, so a retried or resumed run adds nothing the second time. Turns whose host reported no
  cost are counted separately, so a total is never passed off as complete when part of it is
  unmeasured. Compaction does not affect any of it — a checkpoint changes which messages the model is
  sent, not which ones were paid for.

  This also fixes usage being lost entirely on any turn that called a tool: those iterations produce
  no text message, so the provider's accounting for them had nowhere to be stored.

- 675400c: Show each tool call, and give the composer its model picker back.

  The agent transcript collapsed a turn's calls into one `Using read_collection, read_collection…`
  line and discarded `role === 'tool'` rows outright, so two different reads of two different
  collections were indistinguishable and no result was ever visible. Each call now renders as its own
  row — icon, label, and the identifying argument — with its input, error and result joined to it by
  `toolCallId`. Results are collapsed by default and capped, because a tool result is the reader's own
  policy-filtered data but still is not conversation.

  A thrown tool was previously fed back to the model as `{ error }` while the run reported success;
  those now render as a failed call.

  The composer regains the model picker lost when the agent moved out of the host. It reads the host's
  catalog through the new optional `HostAiBinding.models()` and sends a model only when the choice
  differs from the host default, so an untouched picker never turns a display value into a caller
  assertion. A caller-supplied model is rejected unless the host advertises it: model choice is spend,
  so the ceiling belongs to the side holding the credentials. A host without `models()` renders no
  picker.

- c386ba2: Build through turbo when packing, and fail a build that emitted `any`.

  `@norbital-ai/pod@0.0.3` shipped `utcInstantSchema` and `clockTimeZodSchema` as `any`, and `dateRangeZodSchema` as `{ start: any; end: any }`. The cause was ordering, not types. Every publishable package declared `"prepack": "pnpm build"` — its own build, run directly. `changeset publish` therefore compiled each package outside turbo's `^build` ordering, and the release workflow installs with `--ignore-scripts` and never builds, so `packages/std/build` did not exist when pod compiled. The two constants infer their type through `isUtcIsoInstant`/`isClockTime`, imported from `@norbital-ai/std/date`; with nothing to resolve, the predicate became `any`, the `.refine()` overload collapsed, and `svelte-package` wrote the degraded declaration and exited 0.

  The published `any` then became an index signature that flowed through `TablesForModels`, collapsing `TableName<S>` to `string`, stripping the named tables off `DbRelationalQueryRoot`, and pushing `AfterDbApi` onto its `string extends TableName<…>` branch — in every workspace, including ones with no `dateRange()` column.

  Three changes, none of them a type annotation:

  - `prepack` now runs `pnpm exec turbo run build --filter=<package>`, so packing goes through the dependency graph rather than around it. `prepack` is the only hook common to every path that produces a tarball — `changeset publish`, a developer's `pnpm pack`, and `publication:check` — which is why the ordering is fixed there rather than in the release workflow.
  - `scripts/build-package.mjs` refuses to start the compiler when a `workspace:` dependency has a build script but no `build/`, and reads its own emitted declarations back before swapping them in, discarding any output that contains `any` in type position. Both cost milliseconds, so they run on every build, publishing included.
  - `publication:check` unpacks each archive and re-runs that assertion against the bytes that would reach the registry. A GitHub Packages version can never be reused, so a poisoned publish is permanent.

  The two constants stay unannotated: with the ordering fixed, inference emits `z.ZodString` on its own.

- Updated dependencies [ab72b9c]
- Updated dependencies [ab72b9c]
- Updated dependencies [675400c]
- Updated dependencies [2cd75e3]
- Updated dependencies [c386ba2]
- Updated dependencies [99da5a7]
- Updated dependencies [ab72b9c]
  - @norbital-ai/platform-utils@0.1.0
  - @norbital-ai/std@0.0.2
  - @norbital-ai/ui@1.0.0

## 0.0.3

### Patch Changes

- 6178bff: Give every workspace the agent surface, and let the tenant settings tabs span their pane.

  The shell gated the agent FAB and the `/agent` route on an authored `src/+agent.ts` profile, but
  `agentChat` and `agentChatStart` are plain authenticated commands and were always callable whatever
  the shell rendered. Hiding the surface never removed the reach behind it, so the UI is no longer
  gated and the fallback profile is the real boundary. That fallback is the intent rather than a hole
  in it: an agent someone is talking to should reach what that person reaches, so leaving `collections`
  unset widens `allowedCollections` to every tenant collection precisely so the ceiling comes from
  policy instead of the spec — `read_collection` runs `findMany` unelevated, `write_collection` is not
  offered, and no host tool is. `src/+agent.ts` is for the case policy cannot cover: a channel with no
  authenticated requestor to scope against, such as a public WhatsApp or Telegram surface.

  `workspaceProvidesAgentSurface` and `workspaceAuthorizesAgentSurface` no longer take the manifest's
  `agent` entry. Both are internal to the Pod shell and are not reachable through any package export.

  The tenant settings tabs now pass `listClass="mx-0 w-full"` so the row squares up with the header and
  the panel below it instead of floating short of the surface, and the redundant "Tenant-owned
  configuration" eyebrow above the "Tenant settings" heading is gone.

- Updated dependencies [6178bff]
  - @norbital-ai/ui@0.0.3

## 0.0.2

### Patch Changes

- e0dd1a9: Group tenant and host-owned settings under one shell with Core provenance badges, preserve plugin
  placement across the server/browser boundary, standardize workspace page tabs, fully unmount the
  outgoing tenant document while an organization switch is in progress, and restore bounded Kanban
  lane scrolling after the layout-primitive migration.
- 2495a32: Export Drizzle's SQL expression builder from the workspace authoring surface so models can declare
  read-only generated relational projections. This lets provenance variants retain their canonical
  JSON audit record while exposing indexed foreign-key paths for nested queries.
- 4e095e3: Keep browser replica synchronization demand-driven so background collection warming cannot compete with visible reads or issue requests for inaccessible collections. Close a tab's replica transport when the page is actually discarded.
- Updated dependencies [e0dd1a9]
- Updated dependencies [3b63018]
  - @norbital-ai/ui@0.0.2

## 0.0.1

- Initial public release of the Pod authoring SDK, tenant runtime, sync engine, agent runtime, and
  host boundary.
