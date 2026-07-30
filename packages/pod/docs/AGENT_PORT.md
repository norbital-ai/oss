# The agent port: what moved from Core into Pod

The agent loop now lives in the OSS package. This file records what moved, what deliberately did not,
and what is still owed — measured against `norbital/apps/core/src/lib/agent` rather than estimated.

**Status: the six planned steps are done.** The loop, its storage, its permissions, an interactive
surface, channel authoring, and a chat panel are all in Pod. What remains is listed under
[Still owed](#still-owed) and is smaller than what landed, but it is not nothing.

## What Pod now owns

| Step | What landed                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------- |
| 1    | `chat_session` / `chat_turn` / `chat_message` as system collections, migrated in all templates |
| 2    | The loop writes `AiMessage` verbatim; `agent_run_step` retired                                 |
| 3    | Transcripts scoped to their session's owner                                                    |
| 4    | `remotes/agentChat` — an interactive conversation is a run with no automation name             |
| 5    | `src/channels/+<name>.channel.ts`, with `policy` bound to the generated `PolicyName`           |
| 6    | `@norbital-ai/pod/client/agent` — a chat panel driven by the pod's own loop                    |

Two decisions shaped the rest:

**One transcript model.** An automation's agent run and a person talking to the agent produce the same
messages, so they share `chat_session`; `automation_run_id` marks which is which. The old
`agent_run_step` was a bespoke decomposition (`kind`/`role`/`content`/`tool_*`) rebuilt on read, so the
stored form and the in-memory form could disagree. Storing the message means replay is a read.

**The tenant database, not a system one.** Core keeps agent state in a system database shared across
tenants. Pod has none, so this was a rewrite rather than a copy — and it is why `organization_id`
disappeared: a pod database _is_ one tenant, so that column would be a constant on every row and a
filter every query had to remember.

## What deliberately stayed in Core

| Core subsystem                    | Why it stays                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `$lib/tenant_workspace/sandbox/*` | a sandbox is host infrastructure; re-expose as `HostAgentTool` |
| `$lib/workspace_studio/*`         | a host surface, reached as a host plugin                       |
| `$lib/billing/*`                  | Core owns the commercial relationship                          |
| `$lib/live_object/*`              | superseded by Pod's own sync                                   |
| `@durable-streams/*`              | a socket the tenant cannot hold open                           |

`tools/coding.tool.ts` and `tools/deployment.tool.ts` follow the sandbox and stay in Core.

## Still owed

**Channel delivery.** Authoring a channel does not yet route anything. Core's channel runtime is
~2,500 lines across `channel-manager`, `channel-history`, `automation`, and `pending-channel-message`,
all of it against Core's system DB. It needs the same rewrite the chat tables got, plus per-transport
tables of its own.

**The rest of the agent UI.** Core has roughly 40 components carrying streaming, subagent trees, todo
panels, and file upload. They depend on `@durable-streams` and `@tanstack/ai`; the panel here is a
working chat surface, not a replacement for them.

**Nothing further on the collection allowlist.** An earlier note here called it an ad-hoc placeholder
needing policy-driven replacement; reading it again, that overstated the problem. `read_collection`
calls `findMany` without `isElevated`, so the permission guard already applies and policy is the
enforcement. `spec.collections` narrows further on top of that — a declared scope, not a substitute
for one. It is a correct belt-and-braces, so it stays.

## A note on verification

Steps 1–5 are covered end to end against real Postgres — `agent-transcript-e2e` and `agent-chat-e2e`
prove transcript shape, sequence continuity, replay across turns, and cross-user rejection.

Step 6 is not. There is no component test infrastructure in this package — no jsdom, no browser runner
— so the panel is covered by `svelte-check` and by its one data dependency being proven end to end.
Rendering is unverified, and that gap is worth closing before anyone relies on it.
