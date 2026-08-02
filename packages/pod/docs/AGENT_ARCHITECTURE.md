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
`src/lib/server/agent/agent-loop.server.ts`:

- an agent automation supplies a declared task, collections, access mode and tool allowlists;
- `remotes/agentChatStart` returns the run/session identity before inference and starts a live
  interactive turn; `remotes/agentChat` remains the synchronous programmatic counterpart;
- channel delivery binds an external conversation to a tenant session, invokes the same loop and
  sends the final text through the host messaging facility.

An interactive run has no automation name. A channel run carries the channel's standing task and
continues the session associated with the external conversation. These are entry-point differences,
not separate agent implementations.

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
- `write_collection`, available only when `access: 'write'`.
- `spawn_subagent`, available only to a root turn; the child inherits the same approved tool and
  collection boundary and cannot recursively spawn another child.

Tenant-authored tools run through the scoped workspace API. Their reads and writes retain policy,
hook, approval, temporal-history and audit behavior. TypeScript narrowing is backed by runtime checks;
an undeclared collection or tool is refused before execution.

## Host tools

A host can expose trusted operations such as sandbox editing or deployment without giving their
credentials to tenant code:

```ts
export type HostAgentToolBinding = {
	list(): Promise<readonly HostAgentToolSpec[]>;
	run(name: string, input: unknown): Promise<unknown>;
};
```

Host tools are default-deny:

1. The host registers implementations.
2. A workspace agent explicitly names allowed tools in `hostTools`.
3. `assertHostAgentTools` validates the workspace manifest against the host inventory at startup.
4. The loop repeats namespace and selection checks before dispatch.
5. The host validates the selected tool's input and returns structured-cloneable data.

Workspace tools, Pod built-ins and host tools share one model-visible namespace. Collisions are a
startup error. A workspace configures the Pod-owned interactive agent in `src/+agent.ts`; absent that
file, interactive chat remains read-only and receives no host tools. The authored profile carries
the same `collections`, `access`, `tools`, `hostTools`, model and budget fields as an agent
automation, without inventing a schedule merely to configure the UI.

`run(name, input)` carries no caller identity. A tenant isolate cannot make a trustworthy assertion
about a host principal; the host authorizes using the tenant identity already bound to that runtime.

## UI and replication

The Pod shell renders `AgentChatPanel` whenever the workspace manifest contains the agent authored in
`src/+agent.ts`; it does not wait for a host plugin. The same panel is available from a floating
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
deduplication, principal resolution, conversation binding, loop execution and transcript writes.
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
- `standalone/channel-delivery-e2e.test.ts` covers inbound deduplication, conversation continuation
  and outbound delivery;
- `components/agent-chat-panel.test.ts` covers pending UI state and live replica updates.

Host repositories should test only their adapters: binding shape, credential isolation, tenant
identity binding and the absence of host-owned transcript storage.
