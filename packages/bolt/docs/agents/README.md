# Agents

The interactive agent is either reserved `web` (the signed-in person) or one declared envoy. It
runs a tool loop under a **subject snapshot** stored on the turn row. Automations and functions
are not agents.

Source: `src/runtime/agents/agents.ts`, `platform-tools.ts`, `src/runtime/envoys/envoys.ts`,
`src/runtime/automations/automations.ts`.

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

`sandboxKeyFor` keys the envoy sandbox by `envoyPrincipalId(agent.name)` — one tree per
declared envoy, not per conversation and not the linked sender's personal sandbox.
`_conversationId` is unused. A linked sender may still narrow `userId` on the subject;
capability stays the envoy's declared ceiling. The web agent keys the sandbox by
`subject.userId`.

---

## Tools

One assembly path (`allowedTools`):

1. **Platform** (always considered): `describe_workspace`, `list_skills`, `read_skill`,
   `read_collection`, `write_collection`. `search_envoy_history` is offered only to envoys,
   not the reserved `web` agent.
2. `write_collection` only if the subject has any `mutate.new`, `mutate.existing`, or `delete`
   grant on any collection.
3. **Authored** `defineAgentTool` — only when a policy names the tool.
4. **MCP** — only when a policy names the server. Wire names fold `:` to `_`.
5. **Sandbox** (unless `delegation: disabled`): `spawn_agent`, `list_agents`, `read_agent`,
   `message_agent`, `await_agent`, `interrupt_agent`, `stop_agent`, `resume_agent`. Structural;
   they do not grant workspace data authority.
6. **Host tools** — only if a policy names them. The host implements the dangerous side.

Denied tools return `{ error }` in the loop (`ToolNotAllowed`). There is no "missing means all"
fallback and no per-agent deny list.

`api.infer` (hooks, automations, functions) is one schema-validated call: no transcript, no
sandbox, no tools.

---

## A turn

```text
  agents.enqueue
		│  authorize subject
		│  persist user message + running assistant row
		│  load the token-capped transcript window
		▼
  continueToolLoop     one ordinary invocation, no round count
		│  ai.execute → text | toolCalls
		│  append + commit each tool call before execution
		│  append + commit its exact result on return
		│  await_agent executes and joins that exact child turn
		▼
  settle turn + usage (tokens / USD on turn + chat_session)
```

The assistant message is **one row** with ordered `text` | `tool` | `tool-result` parts, not one
row per round.

There is no agent queue, retry, park, continuation row, or round limit. A stop fences the live
invocation at its next facility boundary. Resume is a new ordinary invocation that reconstructs
the same turn from its committed parts. A host restart marks an in-flight row interrupted; it is
never claimed again automatically. The host calls `Agents.recover` exactly once when it loads an
environment after restart; ordinary requests never run that sweep because they may overlap a live
turn. Nesting of delegated agents and automations remains capped
(`DEFAULT_NESTING_LIMIT = 8`).

The replay window keeps whole turns and whole tool-call/result pairs under 60% of the selected
model's reported context window. Missing context metadata is an error; the runtime does not guess a
model cap.

**Metering.** Cumulative and per-segment usage on the turn; billing settlement on completion.

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
