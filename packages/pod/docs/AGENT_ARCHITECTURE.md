# Agent architecture

Pod owns workspace agents: the loop implementation, tool dispatch, and tenant transcripts. The host
supplies model inference and may expose explicitly selected host tools. The host does not persist
agent transcripts. On Core, the host _does_ orchestrate the durable workflow and execute fenced AI
effects (`ai.turn` / `ai.prompt`) outside the guest.

This ownership rule is the same for every deployment target:

```text
interactive chat (hosted) ─┐
channel inbound (hosted) ──┼─► persist user turn ─► admitAgentTurn ─► _norbital_automation_job
                           │                                              │
                                                                           ▼
                                                             Core DBOS: one guest
                                                             automation-events step
                                                                           │
agentChat / HTTP agent/start (leftover) ─► runAgent in-guest ─┐           │
                                                              ▼           ▼
                                                   Pod loop logic (agent-loop.server.ts)
                                                                           │
                                          ┌───────────────────────────────┼───────────────┐
                                          ▼                               ▼               ▼
                                   workspace tools                 host AI effects   tenant transcript
                                                                   ai.turn/prompt    + ordinary sync
```

## Responsibilities

| Pod owns                                                           | The host owns                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop logic, streaming, subagents, iteration and token limits | One model-inference turn through `HostAiBinding`; Core also orchestrates the durable workflow and executes fenced `ai.turn` / `ai.prompt` effects |
| Tool selection and dispatch                                        | Provider credentials and provider-specific adapters                                                                                               |
| Workspace tools and their scoped API                               | Optional trusted tool implementations exposed through `HostAgentToolBinding`                                                                      |
| Runs, sessions, messages and channel conversations                 | Transport sockets and encrypted transport credentials                                                                                             |
| Transcript authorization, persistence and replication              | Process lifecycle and isolation for the tenant runtime                                                                                            |
| Interactive agent UI, floating entry and `/agent` route            | Proxying/mounting the Pod workspace application                                                                                                   |

A host must not create a parallel session store, transcript API, or agent UI. Core orchestrates the
durable workflow; it does not persist transcripts. A host tool returns plain data to Pod; Pod records
the call and result as part of its own transcript.

## One loop, two entry points

Loop _logic_ still lives in `src/server/agent/agent-loop.server.ts`. The same `chat_session`
transcript is used for every door. Hosted _entry_ is receipt admission, not an in-guest continuous
`runAgent`.

- Hosted interactive (`agentChatStart`) and channel inbound persist the user turn, then
  `admitAgentTurn` into `_norbital_automation_job`. Core DBOS drives one provider or tool
  transition per guest `automation-events` step. They do not `void runAgent` or retain a
  background lease.
- `agentChat` (the synchronous remote) and HTTP `agent/start` may still call `runAgent` in-guest.
  Those are leftover programmatic paths, not the hosted UI path.

Automations are not agent sessions. They are deterministic handlers configured with
`defineAutomation`; model judgement uses `api.infer` — the same host `chat` as the agent, with
optional schema, optional images, and optional named workspace tools. Always a normal chat session.
No `write_collection`, `spawn_subagent`, sandbox, authoring, or MCP; it does not own a
`chat_session` transcript. Caps are 64 calls and 100,000 prompt characters per invocation.

An interactive run has no automation name. A channel run carries the channel's standing task and
continues the session associated with the external conversation. These are entry-point differences,
not separate agent implementations.

Standalone `pod start` has no DBOS. `workspaceJobs` remains infrastructure-only (outbox drains,
conversation titles, integration import). After those, `standaloneAutomationJobs` is a continuous
pump that admits guest receipts (interactive chat, channel inbound, collection events) and drives
each through in-process run/settle with the host's `HostAiBinding`; one cron job per authored
schedule admits that occurrence, then the pump executes it. Core still uses DBOS for the same
guest protocol. Leftover `runAgent` is the programmatic/sync remote path, not `pod start` UI or
channel delivery.

## What bounds an agent

Permission bounds an agent; tool availability does not. `read_collection` and `write_collection` run
unelevated, so every read and every write meets the same policy, hooks and approval gates the acting
principal would meet clicking through the app. Curating a narrow per-agent tool subset would
therefore buy very little and cost the thing that matters most about a boundary — that people can
tell where it is. It would restrict what the agent can attempt while changing nothing about what it
is permitted to do, and it would read, to anyone auditing it, as though the tool list were the
containment. Pod does not work that way: `interactiveAgentSpec` and `channelAgentSpec` hand out the
entire surface deliberately, and what makes that defensible is that the ceiling is somewhere else
entirely.

Which principal supplies that ceiling depends on the surface, and the two surfaces have to answer
differently, because one of them has no user to point at.

**Interactive usage** — the web chat panel and the `/agent` route — runs as the signed-in user, with
that user's permissions. The agent is a faster hand on the same controls rather than a wider set of
them, and a refusal it meets is a refusal the person would have met. That is the data half, and it
is the half a `read_collection` or `write_collection` call obeys. Host tools carry the same person's
id as a lookup key; the host re-resolves it before opening that person's worktree.

**Channel usage** — Telegram, WhatsApp — always starts from the channel's reconciled agent profile.
For a public profile, that principal is the requestor. For an authenticated profile, delivery first
matches the transport sender to an active assigned account with a verified transport identity, then
keeps that human identity while substituting the profile principal's team memberships. Policy
placeholders therefore resolve to the contractor, but permissions cannot widen beyond the profile's
declared `policy`. An unmatched sender receives the registration instruction and no model run.

`pod migrate` reconciles one `kind='agent'` user per declared channel into a team holding that policy.
This is what makes `policy` load-bearing rather than decorative: the host command carrying an inbound
message arrives as an administrator, and running the agent there would make every channel omnipotent.

Channels do not list sandbox host tools. The funnel offers every sandbox-gated host tool when this
session has a bound sandbox, the same way interactive chat does. `hostTools` on the channel is only
the opt-in for non-sandbox host tools; `denyTools` withholds workspace or platform builtins without
touching sandbox. The host validates the channel principal and defaults its worktree mount to
read-only unless the channel declaration deliberately opts into authoring.

What each entry point _declares_ is a second axis, independent of whose permissions apply:

| Entry point                   | Acts as                                                     | Spec comes from                                  | Reach when nothing is authored                                                        |
| ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Interactive chat              | the signed-in user                                          | `src/+agent.ts`, else `interactiveAgentSpec`     | write, every workspace tool, sandbox host tools when bound                            |
| Public channel message        | the channel's agent principal, under its policy             | `channelAgentSpec`, plus the channel declaration | write, every workspace tool, sandbox host tools when bound, declared MCP servers only |
| Authenticated channel message | the linked member identity under the channel profile policy | `channelAgentSpec`, plus the channel declaration | write, every workspace tool, sandbox host tools when bound, declared MCP servers only |

A channel run is the one place an authored `src/+agent.ts` does not win outright. Its prompt, model
and budgets are carried; its `collections`, `access`, `tools`, `denyTools`, `hostTools`, and `mcpServers` are not, because
permission for that run belongs to the channel's policy and a file that could widen or narrow it from
the side would make the policy advisory. The channel's declared `task` is composed last, after the
baseline prompt and after the authored one, so the most specific instruction is the one the model
reads last.

## Tool funnel

Every model that can call tools goes through one assembly path (`assembleToolSpecs`). Two surfaces
feed it:

- **`agent`** — interactive chat, channels, subagents. Owns a `chat_session` transcript.
- **`infer`** — `api.infer` in hooks, automations, remotes. Ephemeral messages only; never a transcript.

Layers, in order, then sorted by name:

1. **Platform read builtins** — always: `describe_workspace`, `read_collection`, `list_skills`, `read_skill`
2. **Platform write** — `agent` only, `access === 'write'`, not plan mode: `write_collection`
3. **Platform coordination** — `agent` only, not plan mode: sandbox coordination tools; `spawn_subagent` on the root turn
4. **Workspace tools** (`+*.tool.ts`) — `agent` omit `spec.tools` → all, otherwise that allowlist; `infer` only names passed to `api.infer({ tools })`; then subtract `spec.denyTools` / `denyTools` on the channel
5. **MCP** — `agent` only, `spec.mcpServers`
6. **Sandbox host tools** — `agent` only, and only when this session has a bound sandbox. Taken from `agentTools.list()`, never from `spec.hostTools` / allow / deny. `denyTools` cannot name them.
7. **Other host tools** — `agent` only, names in `spec.hostTools` that are not sandbox-gated

Plan mode keeps layer 1 only. Infer is layers 1 and 4 only.

A bound sandbox means the host exposes `agentTools` and this turn has a requestor the host can
resolve as a sandbox principal. WhatsApp, web, and every other agent profile still receive those
tools when that is true; they are not handwritten onto the profile.

`denyTools` on `src/+agent.ts` or a channel declaration is typesafe over workspace tool names and
the platform builtins. Naming a `sandbox_*` tool there is an error.

## Transcript model

Agent state lives in the tenant database:

| Collection                | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `automation_run`          | Execution owner, status, input, output, error and timing                    |
| `chat_session`            | Conversation aggregate: ordered messages, nested turns, title, usage, state |
| `channel_conversation`    | Declared channel plus external conversation to `chat_session` binding       |
| `channel_inbound_message` | Provider-message deduplication and delivery outcome                         |

Provider deltas remain transient transport fragments. Pod accumulates them in memory and creates or
updates the assistant message inside the session only at a semantic, size, or latency-bounded
text-part checkpoint; the terminal provider result is always written once with `status: complete`.
Each aggregate mutation and its sync-outbox event commit in one transaction. A spawned child appends
a turn with `parent_turn_id` and `subagent_id` to that same aggregate. Root replay excludes child-turn
messages and keeps the parent's tool call/result exchange, so a nested transcript does not leak into
the next root prompt.

A `kind: 'goal'` row is an independent verifier verdict, not the agent's own claim. When the
resolved intent asked for a check, replay maps that row back into the window as a
`<goal-verification>` user message, the same way a summary re-enters as `<conversation-summary>`.

Every run and personal session is owned by its requestor. Collection permission guards scope session,
message and run reads to that owner. Channel principals are resolved inside Pod before a channel
message reaches the loop. Core or another host therefore has no transcript table to filter and no
transcript authorization decision to make.

## Model-inference boundary

`HostAiBinding` accepts the current messages, tool specifications and optional model/profile
selection. Streaming hosts implement `startStream`, `readStream` and `cancelStream`; the opaque id
names only a transient host queue. Pod pulls normalized text/tool/finish events, coalesces text into
durable parts, and writes lifecycle transitions. `chat` is the final-result compatibility path for hosts without live
streaming. Either shape is exactly one inference turn: Pod decides whether to execute tools, append
results, continue, stop, or mark the run failed. On the hosted receipt path, Core executes that turn
as a fenced `ai.turn` / `ai.prompt` effect outside the guest; leftover `runAgent` paths still pull
through the binding in-guest.

The binding deliberately carries no transcript identifier. The host needs messages to perform
inference, but it does not need or receive ownership of the conversation lifecycle.

## Workspace tools

Pod always provides its built-ins:

- `describe_workspace`;
- `read_collection`, narrowed by the agent's `collections` declaration;
- `write_collection`, available only when `access: 'write'`;
- `list_skills` and `read_skill`, for progressive disclosure of platform and workspace
  documentation (see [Skills](#skills));
- `spawn_subagent`, available only to a root turn; the child inherits the same approved tool and
  collection boundary and cannot recursively spawn another child.

Tenant-authored tools run through the scoped workspace API. Their reads and writes retain policy,
hook, approval, temporal-history and audit behavior. TypeScript narrowing is backed by runtime checks;
an undeclared collection or tool is refused before execution.

## Skills

Skills follow the [Agent Skills format](https://agentskills.io/specification): a directory with a
`SKILL.md` carrying `name` and `description` frontmatter, plus optional reference files beneath it.
Pod implements the reading half — progressive disclosure — and not the executing half; a skill's
`scripts/` are shell, and the agent loop has no shell to run them in.

There are two kinds of skill, and they share one flat namespace.

**System injected** are the skills Pod ships. They are authored at the repository root under
`skills/<name>/`, compiled by `scripts/generate-skills.mjs` into
`packages/pod/src/skills/skills.generated.ts` as `HOST_SKILLS`, and merged in at runtime. No
`SKILL.md` exists anywhere under `packages/pod/`; `@norbital-ai/pod/skills` is an export subpath that
re-exports the generated data, not a directory of markdown.

**File-based discovered** are the skills found by reading a filesystem. Two variants differ only in
which filesystem they are read from and whether they are committed:

| Kind                   | Where it lives                                               | Who maintains it        |
| ---------------------- | ------------------------------------------------------------ | ----------------------- |
| System injected        | authored at repo-root `skills/`, compiled into the package   | Pod                     |
| Discovered — workspace | `.agents/skills/<name>/SKILL.md`, inlined at compile time    | The workspace author    |
| Discovered — personal  | `.agents/skills/<name>/SKILL.md` on the run's own filesystem | Whoever that belongs to |

Pod ships `norbital-platform` (approvals, policies, record history, audit, agent capabilities) and
`authoring-tenant-workspace` (how to author a tenant workspace). Precedence on a name collision runs
host, then workspace, then personal. Host wins everything: a workspace copy is refused at compile
time with `SKILL_NAME_RESERVED`, and a personal copy is dropped at resolution, because anything that
shadowed `norbital-platform` would replace the only correct account of how approvals behave. Workspace
beats personal for the narrower reason that a workspace skill is the tenant's shared answer, which a
single sandbox should not be able to quietly substitute.

Personal skills are a self-hosted feature, and the qualifier is load-bearing. `personalSkills()`
reads `.agents/skills/` beneath `NORBITAL_POD_SANDBOX_DIR` when the host sets it and beneath the
process working directory otherwise. Compiled workspace skills win on name collision; anything extra
on disk appears as personal. Under `pod dev` and `pod start` that is the workspace directory — one
process, one principal, a real writable place — so a skill left there is that person's, is committed
nowhere, and is picked up on the next turn.

Under a host that runs one tenant runtime per organization, they do not work, and no configuration
makes them work. Core is that shape: its guest starts on `/app`, an immutable checkpoint bundle
mounted read-only, and it sets no sandbox directory, so discovery correctly finds nothing and every
run gets exactly the host and workspace skills it would have got anyway. Setting the variable would
not repair it, which is the part worth reading twice — one process environment variable cannot name a
different directory per person, and the runtime is shared by the whole organization, so anything it
pointed at would be organization-wide skills called personal. Nor is there a writer on that path:
Core's `sandbox_write_file` edits the build sandbox, a different guest from the one that reads this.
The runtime discovery path is intentionally organization-wide; actor-specific skills need a host
tool that reads the actor worktree, not a process environment variable in the shared runtime.

There is deliberately no user id anywhere in the discovery path, and that stays right under either
shape. Discovery asks the filesystem what is on it, which is a fact the process already has. Asking
who is acting would be redundant where there is one principal and unanswerable on a channel, since a
group chat is permissioned by profile precisely because no participant owns it.

Discovery is soft throughout: a missing directory, an unreadable file, malformed frontmatter or an
invalid name loses that one skill and never the run. It reads a place a person may put anything, so
it is bounded at 64 skills and 64 files per skill — not as a security boundary, since whoever can
write there can already fill it, but so that one runaway directory cannot turn `list_skills` into a
walk of someone's home.

Both skill tools are granted to every agent unconditionally, unlike `read_collection` and the
tenant-authored tools above: an agent spec cannot withhold them, and `list_skills` is not filtered by
anything the spec declares. Gating them is not a boundary worth having, because the failure they
prevent — a model confidently describing a platform it has never seen — is not one an agent opts into.

Disclosure is tiered on purpose:

1. **`list_skills`** returns the metadata tier — name, description, origin, and the file paths each
   skill carries — so a model can choose what to load without paying for every body up front.
2. **`read_skill`** with no file returns the skill body (`SKILL.md` with frontmatter removed).
3. **`read_skill`** with a file path returns one reference file. Paths are matched verbatim against
   the list the skill advertises; there is no path joining onto a root.

The manifest gains a `skills` entry carrying names and descriptions only. `@norbital-ai/pod/skills`
exports the host skills as data for hosts that want to offer them through their own tooling.

## MCP servers

A workspace declares remote MCP servers in `src/mcp/+<name>.mcp.ts` with
`defineMcpServer({ description, url, tools })`. The filename is the server identity; `tools` is a
required, non-empty allowlist. Pod never dumps a full remote catalog — only declared tools reach the
model as `mcp__<server>__<tool>`. The client speaks MCP 2026-07-28 statelessly via headers
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`.

Dispatch is default-deny, like host tools. Interactive chat with no authored `src/+agent.ts` grants
every declared server; an authored profile and channels must name
`mcpServers: ['stripe']`. Channels default to no MCP servers.

Elicitation v1: a server may return `resultType: input_required`. The UI shows what was asked; there
is no client MRTR retry yet. Implementation lives in `packages/pod/src/mcp/*`,
`authoring/mcp/define-mcp-server.ts`, and `server/agent/mcp-tools.server.ts` — not inlined into the
agent loop.

## System prompt

Every turn — interactive chat and channel delivery — composes a baseline system
prompt ahead of any authored `systemPrompt`. The baseline carries what a turn cannot recover from on
its own, because these are the things that shape the first sentence of a reply, before any tool call,
and a skill the model was never prompted to fetch cannot repair them:

- who the agent is and what it is for — an agent inside one workspace, helping the people who use it
  get work done in it;
- that its tool list is what it actually has, and that permission rather than tool availability is
  what bounds its use of the workspace's data: it acts as the person it is talking to in a workspace
  conversation, and under the channel's profile on Telegram or WhatsApp, and it is not privileged in
  either case;
- that any filesystem it can reach persists between turns and is visible to everyone in the
  organisation, so nothing private belongs on it;
- the `src/` layout, in enough detail to name the file a change belongs in — because there is no
  administrative console, and an agent that cannot name the file will describe a settings screen
  that does not exist;
- that it must ground answers in tool results, call `list_skills` and `read_skill` before answering
  anything about how Norbital itself behaves, and never invent which model or vendor it is.

Everything with depth — how approvals resolve, how history and audit work, what the system columns
mean — stays out of it and loads on demand through the skills, because carrying it on every turn
would spend most of a context window on text the turn never needed.

An authored prompt, when present, is appended after a `---` separator and still wins a conflict —
order is the point, because a model resolves ambiguity in favour of what it read last. Replacing the
authored prompt instead of composing with it would silently drop every workspace's domain
instructions the moment the baseline shipped.

## Intent

A turn is `do` (default) or `plan`. `resolveAgentIntent` in `shared/agent/intent.ts` is the one
decision: tool posture, whether an independent verifier runs, and whether the settled window folds
into a checkpoint. The composer Plan chip sends `intent: 'plan'`; everything else is `do`. There is
no Goal chip — the verifier is inferred from the intent, an explicit prompt, a mention, or a task
signal in the message.

**Plan** withholds writes, host tools, MCP tools, and `spawn_subagent`. The model keeps
`describe_workspace`, `list_skills`, `read_skill`, and `read_collection`. The settled window folds
through the same `kind: 'summary'` checkpoint compaction already uses. The verifier always runs, and
its prompt asks whether the plan is complete and executable, not whether the work already happened.

**Do** leaves the full tool list in place. A verifier runs when the message looks like a task, names
a record, or carries an explicit prompt. When the root loop would stop (`calls.length === 0`,
depth 0), that check is a separate `ai.chat` / durable `ai.prompt` with no tools. The agent's last
sentence is not evidence. A failed verdict is persisted as `kind: 'goal'` and injected back into the
window so the main agent continues. After three checks the turn fail-closes and stops. Subagents
never enter the gate.

Verifier scoring lives in `server/agent/goal-mode.server.ts` and `shared/agent/goal-verdict.ts`, not
inlined into the loop. The composer, the `@` menu, and the omni finder share one prefix language and
record engine in `ui/agent/mention-sources.ts`. Composer chip ranges live in
`ui/agent/composer-mentions.ts`; chrome tokens and the focus/seed channel live in
`ui/agent/composer-chrome.ts`.

## Host tools

A host can expose trusted operations such as sandbox editing or deployment without giving their
credentials to tenant code:

```ts
export type HostAgentToolBinding = {
	list(): Promise<readonly HostAgentToolSpec[]>;
	run(name: string, input: unknown): Promise<unknown>;
};
```

Dispatch is still default-deny. What changes is _how_ a name enters the offered set — that is the
[tool funnel](#tool-funnel), not a handwritten list on the profile:

1. The host registers implementations on `agentTools`.
2. Sandbox-gated host tools (`requiresSandbox`, or a `sandbox_*` name) are offered only when this
   session has a bound sandbox. They are not listed in `hostTools`, and `denyTools` cannot hide them.
3. Other host tools appear only when the running spec names them in `hostTools`.
4. `assertHostAgentTools` validates named `hostTools` against the host inventory at startup.
5. The loop repeats namespace and selection checks before dispatch.
6. The host validates the selected tool's input and returns structured-cloneable data.

Workspace tools, Pod built-ins and host tools share one model-visible namespace. Collisions are a
startup error.

A workspace configures the Pod-owned interactive agent in `src/+agent.ts`. The authored profile
carries `collections`, `access`, `tools`, `denyTools`, `hostTools`, `mcpServers`, model,
`systemPrompt` and budget. An authored profile still wins outright for interactive chat: a workspace
that wrote its own boundary meant it, and widening it from the fallback would make that file
advisory. `denyTools` withholds workspace tools and platform builtins; it cannot name sandbox host
tools.

When the workspace authored none, interactive chat runs under a fallback profile with `access:
'write'`, every workspace agent tool, every declared MCP server, and sandbox host tools when a
sandbox is bound. A channel run takes the same write access, workspace tools, and bound-sandbox
tools whether or not a profile was authored. Non-sandbox host tools and MCP servers still require
an explicit name on the channel declaration. Channel worktrees default to read-only.

Data access is the safe half. `read_collection` and `write_collection` both run unelevated, so
policy, hooks and approval gates apply exactly as they would to the same person clicking in the
app: the agent is a faster hand on the same controls, not a wider set of them. Leaving `collections`
unset is part of that — the ceiling comes from policy rather than from the spec.

## Actor workbench boundary

Host tools cross a stricter principal boundary than workspace tools. Pod attaches only the
`sandboxPrincipalId` selected by the authenticated request or channel delivery plus the authored
read-only/read-write mount policy. It does not attach roles or grants. The host resolves that id in
the tenant directory again, checks the actor kind and billing entitlement, and only then opens the
actor's worktree. An isolate can name a lookup key; it cannot make the host believe a role claim.

This supports both workspace actors without conflating them:

- an interactive human and their agent use that human's worktree and ephemeral workbench guest;
- a declared channel uses its independent `kind='agent'` principal, policy and worktree, regardless
  of which external person or group sent the message.

The runtime microVM remains one traffic-serving process for the tenant revision. It never doubles as
an authoring shell. Host tools acquire a separate actor workbench for one call and destroy its guest
afterward; the Git worktree and shared content-addressed dependencies remain on the host. Channels
still default to no host tools and no MCP servers, and an explicit channel allowlist defaults its workspace mount to
read-only. That is a product permission boundary, not a transport limitation.

## UI and replication

The Pod shell renders `AgentChatPanel` for every workspace; it does not wait for an authored
`src/+agent.ts` or a host plugin. The same panel is available from a floating
tenant-workspace action and from the full `/agent` route, including under standalone `pod start`.
Hosted `agentChatStart` admits a durable receipt rather than detaching `runAgent`; standalone has
no DBOS, so those receipts sit until a host drives them. It uses the product agent icon, exposes
the requestor's replicated conversation list as a thread
selector, and keeps a compact composer at the bottom of the panel. It calls `agentChatStart`,
subscribes to `chat_session`, and projects its embedded messages and turns from the local replica.
Completed messages, generated title, terminal state and usage therefore cross the same ordinary
sync stream; refresh, reconnect, offline catch-up and multi-tab convergence do not require an
agent-specific browser stream or a race-prone collection fan-out. Token deltas are deliberately not
replicated or persisted; the UI advances when a provider part completes.

The selector presents durable identities rather than raw usernames: the current person's personal
sessions are grouped under **Web agent — Me**, other personal sessions under **Web agent — Name**,
and declared channel sessions under their channel profile. It is an ARIA tree with roving focus:
Up/Down move between visible items, Right expands or enters a child, and Left collapses or returns
to the parent. Visual hierarchy comes from consistent indentation and icons, not text-drawn branch
characters.

Provider text and reasoning deltas stay in the host's short-lived stream queue. Pod appends one
durable `chat_session` message only when each provider text or reasoning part completes, so a token
delta never causes a PostgreSQL write. Reasoning is retained as its own transcript kind rather than
being folded into visible answer text. Provider usage is appended separately after the provider
finishes; this keeps content immutable while giving empty, tool-only, and refused completions the
same auditable accounting path.

Every mounted agent surface shares one model catalog and next-turn selection through
`agent-model-state.svelte.ts`. The first surface starts the load, concurrent surfaces join that
promise, and the picker remains disabled until the catalog is ready. Changing workspace transport
clears the catalog and selection before loading the new tenant's defaults, preventing a stale model
choice from crossing an organization boundary.

## Channels

Pod declarations choose the channel key, transport, policy and standing agent task. The host owns the
wire: credentials, webhook or long-poll listener, inbound authentication and outbound provider call.

Inbound delivery crosses the private host-command plane with the declared channel key. Pod owns
deduplication, principal resolution, conversation binding, transcript writes and receipt admission;
the principal it resolves to is the channel's own, for the reasons in
[What bounds an agent](#what-bounds-an-agent). Hosted inbound does not `void runAgent` or retain a
background lease for the model loop.
Outbound delivery calls `messaging.sendVia(channel, transport, message)` so the host selects the exact
credential even when multiple declared channels share one transport.

## Conformance

The OSS test suites prove the boundary without depending on Core:

- `agents/agent-transcript-e2e.test.ts` and `agents/agent-chat-e2e.test.ts` cover persistence,
  replay, ownership and interactive continuation;
- `agents/agent-live-capabilities-e2e.test.ts` covers provider streaming and a linked streaming
  subagent turn;
- `agents/host-agent-tool.test.ts` and `standalone/host-agent-tool-e2e.test.ts` cover selection,
  collisions, structured-clone transport and recorded tool results;
- `sync-engine/conversation-replication-e2e.test.ts` covers policy-scoped transcript replication;
- `standalone/channel-delivery-e2e.test.ts` covers inbound deduplication, conversation continuation,
  outbound delivery, the tool surface and prompt a channel run is offered, and what a channel
  principal holding no policy is allowed to do;
- `components/agent-chat-panel.test.ts` covers pending UI state and live replica updates.

Host repositories should test only their adapters: binding shape, credential isolation, tenant
identity binding and the absence of host-owned transcript storage.
