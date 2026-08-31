# Agents

The interactive agent is either reserved `web` (the signed-in person) or one declared envoy. It
runs a TanStack AI chat loop under a **subject snapshot** stored on the run and inbox rows.
Automations and functions are not agents.

Source: `src/runtime/agents/agents.ts`, `agent-runtime.ts`, `sandbox-tools.ts`,
`platform-tools.ts`, and `src/runtime/envoys/envoys.ts`.

How those subjects are minted: [access](../access/README.md). A gated write comes back pending:
[approvals](../access/approvals.md).

---

## Prompt and principals

`src/+agents.md` is required. It is the workspace-wide system message for every turn (web and
envoy). An envoy adds its `task` string from `src/envoys/+<name>.ts`. There is no `+agent.ts`.

| Kind           | Authority                                                                 | Trigger                                     |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| **Web agent**  | The signed-in person                                                      | User message                                |
| **Envoy**      | Declaration's policies (ceiling). Linked sender may narrow `userId` only. | Inbound Telegram / WhatsApp                 |
| **Automation** | `automationSubject` — never the caller's subject                          | Schedule, change, integration, manual       |
| **Function**   | Requestor's subject                                                       | `client.invoke` — request/response, no loop |

The root task's conversation ID is its workbench and sandbox key. Spawned tasks get their own task
IDs, store their direct parent, and inherit that root workbench key. Unrelated tasks owned by the
same person or Envoy therefore cannot discover or message one another. A linked sender may still
narrow `userId` on the subject; capability stays the Envoy's declared ceiling.

---

## Tools

One assembly path (`allowedTools`):

1. **Platform** (always considered): `describe_workspace`, `list_skills`, `read_skill`,
   `search_envoy_history`, `load_media`, `read_collection`, `write_collection`. Envoy-wide history
   scope still requires its explicit policy grant.
2. `write_collection` only if the subject has any `mutate.new`, `mutate.existing`, or `delete`
   grant on any collection.
3. **Authored** `defineAgentTool` — only when a policy names the tool.
4. **MCP** — only when a policy names the server. Wire names fold `:` to `_`.
5. **Sandbox** (unless `delegation: disabled`): `spawn_agent`, `list_agents`, `read_agent`,
   `message_agent`, `await_agent`, `steer_agent`, `stop_agent`, `resume_agent`. Structural;
   they do not grant workspace data authority.
6. **Host tools** — only if a policy names them. The host implements the dangerous side.

Denied tools return `{ error }` in the loop (`ToolNotAllowed`). There is no "missing means all"
fallback and no per-agent deny list.

`api.infer` (hooks, automations, functions) is one schema-validated call: no transcript, no
sandbox, no tools.

---

## Messages, inbox, lane, and runs

```text
  agents.enqueue
		│  authorize and resolve the exact agent/model envelope
		│  atomically persist one canonical user message + inbox receipt
		│  claim a compatible FIFO prefix when the lane is active and idle
		▼
  TanStack chat loop   one run, several provider/tool iterations
		│  middleware projects a compact provider view; durable history stays whole
		│  commit the complete assistant/tool-call batch before effects
		│  execute calls sequentially and persist canonical tool-result messages
		│  check the run/generation/driver fence at every safe boundary
		│  verify the durable goal and append a canonical verdict
		▼
  settle run + exact usage; atomically promote input or a bounded goal continuation
```

`chat_message` and `chat_message_part` are the canonical TanStack `ModelMessage` store. A provider
iteration is one assistant message; tool results are their own canonical messages. The client
derives TanStack `UIMessage` and panel controls from those rows rather than maintaining a second
transcript shape.

`agent_inbox` is the only durable input queue and `agent_lane` is the only active-run pointer.
Ordinary input never joins a run after claim. Steer requests a successor generation at the next
safe boundary; stop leaves the lane stopped; resume replays committed work as a typed `resume` run
and may claim a compatible pending prefix. Provider failure is terminal for that run—there is no
implicit retry ladder and no automatic agent recovery. Explicit `resume` is the only way to
continue stopped work. Nesting of delegated agents and automations remains capped
(`DEFAULT_NESTING_LIMIT = 8`).

A `chat_session` is the durable task; its conversation ID is also its stable `taskId`. Goal-bearing
tasks store a verifier contract that the implementing agent sees from its first turn. After each
implementation run, a separate structured-output call with no tenant tools appends a canonical
`kind: goal` user message. A passing verdict completes the task. An incomplete verdict remains
model-visible and is atomically admitted through `agent_inbox` as a bounded `cause: goal` run.

The context middleware keeps complete tool-call/result units under 60% of the selected model's
reported context window, prunes old tool payloads, filters transcript-only records, and folds the
prefix at the newest summary checkpoint. Compaction changes only `providerMessages`; canonical
durable history remains intact. Plan intent adds a planning instruction and exposes only read-only
planning tools. Missing context metadata is an error; the runtime does not guess a model cap.

**Metering.** Every implementation, verifier, planning, embedding, and tool-loop provider call has
one facility effect identity and one billing observation. Provider `costUsd` remains an audit fact;
the invoice authority is the separate non-negative integer `costMicroUnits` plus currency. Exact
facility-reported usage is cumulative on the run and settles once onto every session in its lineage;
currency mixing fails closed, and any unreported provider segment keeps `usage_unreported` true.

---

## What an agent can and cannot do

**Can** (when policy grants): read/write collections through the same engine as the UI; read
granted skills; call granted MCP and authored tools; delegate via sandbox tools; attach chat
documents.

**Cannot:** exceed policy; use a tool not in `allowedTools`; `write_collection` with no write
grant anywhere; nest past the depth limit; bypass approval gates (a gated write comes back
**202 pending** — success, not a refusal); run an automation under the caller's authority.

`write_collection` is unelevated. A permission failure is information about the subject's access,
not evidence that the platform lacks the feature.

`describe_workspace` returns **names**, subject-scoped — not implementation bodies or live rows.

---

## Honesty rules (runtime contract)

- Never claim a read or write succeeded without its tool result.
- Report `ToolNotAllowed` and `AccessDenied` as capability facts.
- A pending approval is a written, locked row. Name the team the compiled flow asked for.
