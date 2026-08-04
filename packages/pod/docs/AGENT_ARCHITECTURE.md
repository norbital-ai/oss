# Agent architecture

Pod owns workspace agents. The host supplies model inference and may expose explicitly selected
host tools, but it does not run the agent loop and does not persist agent transcripts.

This ownership rule is the same for every deployment target:

```text
interactive chat ─┐
automation run ───┼─► Pod agent loop ─► host AI binding
channel message ──┘         │                 │
                            ├─► workspace tools
                            ├─► selected host tools
                            └─► tenant transcript + ordinary sync
```

## Responsibilities

| Pod owns                                                     | The host owns                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Agent loop, streaming, subagents, iteration and token limits | One model-inference turn through `HostAiBinding`                             |
| Tool selection and dispatch                                  | Provider credentials and provider-specific adapters                          |
| Workspace tools and their scoped API                         | Optional trusted tool implementations exposed through `HostAgentToolBinding` |
| Runs, sessions, messages and channel conversations           | Transport sockets and encrypted transport credentials                        |
| Transcript authorization, persistence and replication        | Process lifecycle and isolation for the tenant runtime                       |
| Interactive agent UI, floating entry and `/agent` route      | Proxying/mounting the Pod workspace application                              |

A host must not create a parallel session store, transcript API, loop, or agent UI. A host tool
returns plain data to Pod; Pod records the call and result as part of its own transcript.

## One loop, three entry points

All agent work converges on `runAgent` in
`src/server/agent/agent-loop.server.ts`:

- an agent automation supplies a declared task, collections, access mode and tool allowlists;
- `remotes/agentChatStart` returns the run/session identity before inference and starts a live
  interactive turn; `remotes/agentChat` remains the synchronous programmatic counterpart;
- channel delivery binds an external conversation to a tenant session, invokes the same loop and
  sends the final text through the host messaging facility.

An interactive run has no automation name. A channel run carries the channel's standing task and
continues the session associated with the external conversation. These are entry-point differences,
not separate agent implementations.

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
is the half a `read_collection` or `write_collection` call obeys. Host tools do not obey it: they run
outside the guest, on whatever principal the host resolved, which under a host that runs one runtime
per organization is one principal for everybody — see
[The principal a host tool cannot know](#the-principal-a-host-tool-cannot-know).

**Channel usage** — Telegram, WhatsApp — runs under the channel's own agent profile instead. A
channel may be a group chat, so there is no single person behind it to inherit permissions from:
`pod migrate` reconciles one `kind='agent'` user per declared channel into a team holding that
channel's declared `policy`, and `deliverChannelMessage` re-enters the workspace as that principal
before the loop starts. This is what makes `policy` on a channel declaration load-bearing rather than
decorative: the host command that carries an inbound message arrives as an administrator, and running
the agent there would make every channel omnipotent.

Host tools are the one thing that boundary does not cover, so a channel run is offered none of them.
A host tool authorizes on the principal it _acts as_, and nothing in a channel declaration chooses
that principal — Core, for one, resolves it to the organization's own builder for every caller. A
channel run holding `sandbox_bash` or `sandbox_write` would therefore not be refused by its policy;
it would succeed as the organization's builder, with shell and git access to the workspace's source
tree, from a Telegram or WhatsApp group that anyone in the group can post to. `channelAgentSpec`
consequently names `hostTools: []` while keeping write access and the entire workspace tool surface,
and the hold is on the identity gap rather than on channel agents: when a binding call can carry
an acting principal, a channel run should get the host tools its own principal is entitled to.

Interactive chat keeps its host tools, on a narrower version of the same problem. Those calls also
act as the host's chosen principal rather than as the signed-in user, but a signed-in user on a
deployment that holds a builder seat is not a semi-public group conversation, and the fallback
profile documents the trade where it is made.

What each entry point _declares_ is a second axis, independent of whose permissions apply:

| Entry point      | Acts as                                         | Spec comes from                                        | Reach when nothing is authored               |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Interactive chat | the signed-in user                              | `src/+agent.ts`, else `interactiveAgentSpec`           | write, every workspace tool, every host tool |
| Channel message  | the channel's agent principal, under its policy | `channelAgentSpec`, plus the channel declaration       | write, every workspace tool, no host tools   |
| Agent automation | the principal its host command carries          | the automation's declared `collections`/`access`/tools | whatever the file declares                   |

A channel run is the one place an authored `src/+agent.ts` does not win outright. Its prompt, model
and budgets are carried; its `collections`, `access`, `tools` and `hostTools` are not, because
permission for that run belongs to the channel's policy and a file that could widen or narrow it from
the side would make the policy advisory. The channel's declared `task` is composed last, after the
baseline prompt and after the authored one, so the most specific instruction is the one the model
reads last.

## Transcript model

Agent state lives in the tenant database:

| Collection                | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `automation_run`          | Execution owner, status, input, output, error and timing                    |
| `chat_session`            | Personal or channel conversation; links an automation run when applicable   |
| `chat_message`            | Ordered `AiMessage` values, including assistant tool calls and tool results |
| `chat_turn`               | Root and nested turn lifecycle, parent link, heartbeat, model and failure   |
| `channel_conversation`    | Declared channel plus external conversation to `chat_session` binding       |
| `channel_inbound_message` | Provider-message deduplication and delivery outcome                         |

An assistant row is created with `status: streaming` on its first text delta, updated in place as
batches arrive, and marked `complete` only after provider completion. A spawned child writes a
`chat_turn` with `parent_turn_id` and `subagent_id`; its messages use the same session and therefore
stream through the same tenant sync connection. Root replay excludes child-turn messages and keeps
the parent's tool call/result exchange, so a nested transcript does not leak into the next root
prompt.

Every run and personal session is owned by its requestor. Collection permission guards scope session,
message and run reads to that owner. Channel principals are resolved inside Pod before a channel
message reaches the loop. Core or another host therefore has no transcript table to filter and no
transcript authorization decision to make.

## Model-inference boundary

`HostAiBinding` accepts the current messages, tool specifications and optional model/profile
selection. Streaming hosts implement `startStream`, `readStream` and `cancelStream`; the opaque id
names only a transient host queue. Pod pulls normalized text/tool/finish events and writes every
durable state transition. `chat` is the final-result compatibility path for hosts without live
streaming. Either shape is exactly one inference turn: Pod decides whether to execute tools, append
results, continue, stop, or mark the run failed.

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
| Discovered — workspace | `src/skills/<name>/SKILL.md`, inlined at compile time        | The workspace author    |
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
process working directory otherwise. Under `pod dev` and `pod start` that is the workspace directory
— one process, one principal, a real writable place — so a skill left there is that person's, is
committed nowhere, and is picked up on the next turn.

Under a host that runs one tenant runtime per organization, they do not work, and no configuration
makes them work. Core is that shape: its guest starts on `/app`, an immutable checkpoint bundle
mounted read-only, and it sets no sandbox directory, so discovery correctly finds nothing and every
run gets exactly the host and workspace skills it would have got anyway. Setting the variable would
not repair it, which is the part worth reading twice — one process environment variable cannot name a
different directory per person, and the runtime is shared by the whole organization, so anything it
pointed at would be organization-wide skills called personal. Nor is there a writer on that path:
Core's `sandbox_write_file` edits the build sandbox, a different guest from the one that reads this.
The missing piece is an acting principal, not a path; see
[The principal a host tool cannot know](#the-principal-a-host-tool-cannot-know).

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

## System prompt

Every turn — interactive chat, automation runs and channel delivery — composes a baseline system
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

## Host tools

A host can expose trusted operations such as sandbox editing or deployment without giving their
credentials to tenant code:

```ts
export type HostAgentToolBinding = {
	list(): Promise<readonly HostAgentToolSpec[]>;
	run(name: string, input: unknown): Promise<unknown>;
};
```

The dispatch path is default-deny — nothing reaches a host tool that the running spec did not name:

1. The host registers implementations.
2. The agent spec explicitly names allowed tools in `hostTools`.
3. `assertHostAgentTools` validates the workspace manifest against the host inventory at startup.
4. The loop repeats namespace and selection checks before dispatch.
5. The host validates the selected tool's input and returns structured-cloneable data.

Read that as a property of dispatch rather than as the deployment's posture. What the _spec_ names is
a separate decision, and for interactive chat with no authored `src/+agent.ts` the answer is all of
them, as below. For a channel run it is none of them, for the reason in
[What bounds an agent](#what-bounds-an-agent).

Workspace tools, Pod built-ins and host tools share one model-visible namespace. Collisions are a
startup error.

A workspace configures the Pod-owned interactive agent in `src/+agent.ts`. The authored profile
carries the same `collections`, `access`, `tools`, `hostTools`, model, `systemPrompt` and budget
fields as an agent automation, without inventing a schedule merely to configure the UI. An authored
profile still wins outright: a workspace that wrote its own boundary meant it, and widening it from
the fallback would make that file advisory.

When the workspace authored none, interactive chat runs under a fallback profile with `access:
'write'`, every workspace agent tool, and every host tool the deployment offers. That is a deliberate
operator decision and it is not the conservative one. A channel run takes the same write access and
the same workspace tools whether or not a profile was authored, and no host tools at all.

Data access is the safe half. `read_collection` and `write_collection` both run unelevated, so
policy, hooks and approval gates apply exactly as they would to the same person clicking in the
app: the agent is a faster hand on the same controls, not a wider set of them. Leaving `collections`
unset is part of that — the ceiling comes from policy rather than from the spec.

Host tools are the half that trades something away. A host tool carries no requestor — the binding
frame has nowhere to put one, and the runtime is a single microVM shared by the whole organization
— so it authorizes on the principal it _acts as_, which is the tenant's builder principal. Naming
them in the fallback therefore hands a `basic` user the reach of a builder: the workspace's source
tree, its shell, its dependencies. The one remaining gate is that the tenant must hold a builder seat
at all. Narrowing this back to a per-requestor decision needs a requestor on the host-tool binding
first; until that exists the choice is all users or no users, and this deployment chose all.

`run(name, input)` carries no caller identity. A tenant isolate cannot make a trustworthy assertion
about a host principal; the host authorizes using the tenant identity already bound to that runtime.

## The principal a host tool cannot know

This is the gap the two sections above keep referring to, written out once so it does not have to be
rediscovered from the symptoms.

A guest reaches a host facility through the facility proxy in
`packages/pod/src/serve/hosted.ts`: a call crosses as a `binding` frame carrying
`{ facility, method, args }` down the stdio channel the host opened
(`packages/pod/src/serve/stdio.ts`), the arguments escaped by `encodeWireValue` in
`packages/platform-utils/src/runtime/wire.ts` — a facility name, a method name, arguments, and
nothing else. There is nowhere in it to say who is asking. The omission is one-directional rather
than a property of the transport: the host's private command plane (`/_host/command`) carries an
`identity` of `userId`, `organizationId` and `organizationName`, so identity crosses this wire
perfectly well in the direction the host is the one asserting it.

Every layer above the call has the same shape, because none of them could have more than the call
does. `HostAgentToolBinding.run(name, input)` in
`packages/platform-utils/src/runtime/binding.ts` takes a tool name and the model's raw input, and the
comment immediately above it already says what is absent and why: a tenant isolate's claim about who
is asking is not something the host can verify, so a host tool authorizes against what the host
already knows. `HostAgentTool.run(input)` in `packages/pod/src/host/agent-tools.ts` receives only
the validated input, and its type comment says the same. The guest end matches — the agent loop
dispatches `binding.run(call.name, call.input)` and has no third argument to pass even if it wanted
one.

Correlating a binding call with an in-flight request cannot stand in for the missing field, which is
the plausible-looking repair worth ruling out explicitly. An interactive turn is started detached, so
the request that began it has already returned by the time the loop calls a tool: a binding call can
arrive with no request pending at all. A channel run does not have a request in that sense either,
and one channel multiplexes many conversations whose message ids are independent of the binding
correlation ids. Whatever the host guessed from concurrency would be a guess, and a guess is exactly
the thing an authorization decision must not be.

Until a binding call carries the acting principal, three things are not implementable rather than
merely unbuilt. Interactive runs cannot have per-user sandboxes, because the host cannot tell which user's
sandbox to open. Channel runs cannot have per-channel sandboxes, for the same reason and with the
same consequence — which is why `channelAgentSpec` offers no host tools at all. And personal skills
cannot exist under a host that runs one runtime per organization, because the filesystem discovery
reads is chosen per process and a process serves everybody.

## UI and replication

The Pod shell renders `AgentChatPanel` for every workspace; it does not wait for an authored
`src/+agent.ts` or a host plugin. The same panel is available from a floating
tenant-workspace action and from the full `/agent` route, including under standalone `pod start`. It
uses the product agent icon, exposes the requestor's replicated conversation list as a thread
selector, and keeps a compact composer at the bottom of the panel. It calls `agentChatStart`,
subscribes as soon as the session identity comes back, and reads
`chat_message` plus `chat_turn` from the local replica. Partial and completed messages therefore use
the ordinary sync engine; refresh, reconnect, offline catch-up and multi-tab convergence do not
require an agent-specific browser stream.

## Channels

Pod declarations choose the channel key, transport, policy and standing agent task. The host owns the
wire: credentials, webhook or long-poll listener, inbound authentication and outbound provider call.

Inbound delivery crosses the private host-command plane with the declared channel key. Pod owns
deduplication, principal resolution, conversation binding, loop execution and transcript writes; the
principal it resolves to is the channel's own, for the reasons in
[What bounds an agent](#what-bounds-an-agent).
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
