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

| Pod owns                                              | The host owns                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Agent loop, iteration and token limits                | One model-inference turn through `HostAiBinding.chat`                        |
| Tool selection and dispatch                           | Provider credentials and provider-specific adapters                          |
| Workspace tools and their scoped API                  | Optional trusted tool implementations exposed through `HostAgentToolBinding` |
| Runs, sessions, messages and channel conversations    | Transport sockets and encrypted transport credentials                        |
| Transcript authorization, persistence and replication | Process lifecycle and isolation for the tenant runtime                       |
| Interactive agent UI                                  | Optional host navigation entry pointing to Pod's `/agent` surface            |

A host must not create a parallel session store, transcript API, loop, or agent UI. A host tool
returns plain data to Pod; Pod records the call and result as part of its own transcript.

## One loop, three entry points

All agent work converges on `runAgent` in
`src/lib/server/agent/agent-loop.server.ts`:

- an agent automation supplies a declared task, collections, access mode and tool allowlists;
- `remotes/agentChat` starts or continues an interactive run;
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
| `channel_conversation`    | Declared channel plus external conversation to `chat_session` binding       |
| `channel_inbound_message` | Provider-message deduplication and delivery outcome                         |

`chat_turn` remains in the system schema for compatibility but the current Pod loop does not write
it. Replay reads ordered `chat_message.parts`; it does not reconstruct messages from a second event
format.

Every run and personal session is owned by its requestor. Collection permission guards scope session,
message and run reads to that owner. Channel principals are resolved inside Pod before a channel
message reaches the loop. Core or another host therefore has no transcript table to filter and no
transcript authorization decision to make.

## Model-inference boundary

`HostAiBinding.chat` accepts the current messages, tool specifications and optional model/profile
selection. It returns text, tool calls, stop reason and optional usage. That is one inference turn:
Pod decides whether to execute tools, append results, continue, stop, or mark the run failed.

The binding deliberately carries no transcript identifier. The host needs messages to perform
inference, but it does not need or receive ownership of the conversation lifecycle.

## Workspace tools

Pod always provides its built-ins:

- `describe_workspace`;
- `read_collection`, narrowed by the agent's `collections` declaration;
- `write_collection`, available only when `access: 'write'`.

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
startup error. Interactive chat exposes workspace tools but no host tools because it has no authored
`hostTools` allowlist.

`run(name, input)` carries no caller identity. A tenant isolate cannot make a trustworthy assertion
about a host principal; the host authorizes using the tenant identity already bound to that runtime.

## UI and replication

The Pod shell renders `AgentChatPanel` when the trusted host-plugin inventory advertises the exact
`/agent` entry. The panel calls `agentChat` and reads `chat_message` from the local replica. Completed
messages arrive through the ordinary sync engine, so refresh, reconnect, offline catch-up and
multi-tab convergence do not require an agent-specific stream.

Hosted navigation performs a full document navigation into `/agent`. This gives the route the normal
Pod bootstrap, identity and replica instead of mounting a host-owned chat component.

## Channels

Pod declarations choose the channel key, transport, policy and standing agent task. The host owns the
wire: credentials, webhook or long-poll listener, inbound authentication and outbound provider call.

Inbound delivery crosses the private host-command plane with the declared channel key. Pod owns
deduplication, principal resolution, conversation binding, loop execution and transcript writes.
Outbound delivery calls `messaging.sendVia(channel, transport, message)` so the host selects the exact
credential even when multiple declared channels share one transport.

## Conformance

The OSS test suites prove the boundary without depending on Core:

- `runtime/agent-transcript-e2e.test.ts` and `runtime/agent-chat-e2e.test.ts` cover persistence,
  replay, ownership and interactive continuation;
- `runtime/host-agent-tool.test.ts` and `standalone/host-agent-tool-e2e.test.ts` cover selection,
  collisions, structured-clone transport and recorded tool results;
- `sync/conversation-replication-e2e.test.ts` covers policy-scoped transcript replication;
- `standalone/channel-delivery-e2e.test.ts` covers inbound deduplication, conversation continuation
  and outbound delivery;
- `components/agent-chat-panel.test.ts` covers pending UI state and live replica updates.

Host repositories should test only their adapters: binding shape, credential isolation, tenant
identity binding and the absence of host-owned transcript storage.
