# Agents

Bolt agents run as durable Tasks coordinated by Effect v4. PostgreSQL holds the complete Task state;
Effect AI owns prompts, model calls, typed tools, response parts, structured output, retries, scopes,
and interruption. Web and Envoy callers use the same Task submission and control commands.

Source: `src/runtime/agents/agents.ts`, `src/runtime/agents/capability-catalog.ts`,
and `src/runtime/envoys/envoys.ts`.

How subjects and collection visibility are resolved: [access](../access/README.md). A gated write
returns the ordinary collection-mutation approval state: [approvals](../access/approvals.md).

---

## Runtime shape

```text
tasks.submit
     │  atomically admit Task + complete user message + inbox directive
     ▼
claim directive
     │  increment Task epoch + create fenced run + snapshot capabilities
     ▼
Effect Prompt → language model → complete assistant message
     │                              │
     │                              └─ tool calls commit before effects begin
     ▼
Effect Toolkit handlers run sequentially → complete tool-result messages
     │
     ├─ Plan verification phase
     ├─ required-child barrier
     └─ exact provider observation per call
     ▼
settle run and Task, or persist a waiting/attention boundary
```

Every model iteration loads durable rows, projects an Effect `Prompt`, calls the selected Effect
model, folds response parts into one complete assistant message, and commits that message before
executing any tool call. Calls run sequentially through the evaluated Effect `Toolkit`; each result
is encoded as a typed tool-result part and committed before the next model iteration.

Streaming response parts are temporary presentation data. Reconnection always resumes from the last
complete committed message.

---

## Public commands

The fixed command catalogue exposes:

```ts
tasks.submit({
  taskId,
  agentId,
  message,
  mode: "agent" | "plan" | "compact",
  priority: "normal" | "steer",
});

tasks.editMessage({ taskId, messageId, message });

tasks.control({ taskId, action: "stop" | "resume" });
```

`tasks.editMessage` appends a revision of one of the subject's own user messages and queues the
Agent directive that continues from it. The original row is not edited or deleted; the new row
names it in `supersedes_id`. Only the author may revise, and only the newest revision of a message
may be revised again.

`taskId` is the caller-minted idempotency key. Its first submission atomically creates the root
Task, canonical message, and directive. A later submission must match the immutable Task subject,
agent, and audience, then appends its message and directive atomically. Completed and failed Tasks
do not accept more work.

`steer` is directive priority, not a separate execution path. Stop takes effect at a safe boundary.
Resume is explicit and is admitted only for a stopped or attention Task after subject, agent,
model, capability, and access checks run again; it creates a new directive and execution fence.

Only the `subagent` tool creates a child Task. The runtime stamps its parent and keeps every
descendant in the root Task's workbench.

---

## Six durable collections

These ordinary Bolt system collections are the complete logical agent store:

| Collection      | Durable responsibility |
| --------------- | ---------------------- |
| `agent_task`    | Workbench, subject and agent ownership, audience, parent, lifecycle, active Plan/run, and epoch fence |
| `agent_run`     | One claimed directive, mode, phase, input boundary, model, immutable capability snapshot, status, and matching epoch |
| `agent_message` | One complete encoded Effect `Prompt.Message`, ordered by Task sequence, with author, semantic hash, optional run, and Compact or Plan-verdict annotation |
| `agent_inbox`   | The Task's only queue: ordered message directives with mode, priority, claim state, and claimed run |
| `agent_plan`    | Immutable Plan revisions containing objective, approach, verification criteria, checkpoint sequence, and state |
| `agent_usage`   | One immutable usage and exact-charge observation per provider attempt, with replay-safe settlement identity |

`agent_task.epoch` and `agent_run.epoch` form the write fence. Claiming work increments the Task
epoch and installs the active run atomically. Every later append, tool effect, usage observation, and
settlement checks that same run and epoch, so stale execution cannot write or spend.

Task ownership is explicit. `subject_id` names the signed-in person or Envoy principal; `agent_id`
names the selected agent; `audience` controls personal versus workbench visibility; `parent_id`
forms the bounded child tree. Transport delivery and receipt state remain in Envoy transport
collections rather than being copied into Task rows.

---

## Durable Effect messages

`agent_message.message` stores one encoded Effect `Prompt.Message`. Text, reasoning, file/image,
tool-call, and tool-result parts remain inside Effect's typed part union and codec. There is no
second parts store or provider-specific transcript shape.

The ordering contract is strict:

1. append the complete assistant message containing a tool call;
2. check the Task/run epoch;
3. execute the Effect tool handler with the tool-call ID;
4. append one complete Effect tool-result message;
5. start the next model iteration.

`semantic_hash` gives immutable replay identity. Generated indexes may expose searchable message or
annotation fields, but those indexes are projections of the encoded message rather than another
message model.

---

## Agent, Plan, and Compact modes

Agent mode performs ordinary implementation or conversation work. If a Plan is active, its exact
revision is included in the prompt and governs execution.

Plan mode creates one `agent_plan` revision containing the objective, implementation approach, and
verification criteria. It receives only the read-oriented planning capability set and does not
perform implementation writes. A newer Plan atomically supersedes the active revision while prior
revisions remain queryable.

After an Agent run implements an active Plan, the same Task runtime enters its `verify` phase and
makes a separate tool-free structured-output call. A complete verdict verifies the Plan. An
incomplete verdict appends its gaps and admits a bounded successor Agent directive. The production
runtime permits three verification attempts before marking the Plan stalled and the Task attention.
Plan and Compact runs do not enter this phase.

Compact mode appends an annotated system message containing the summary, cutoff sequence, and
explicitly retained message IDs. It never edits or deletes durable messages. Manual Compact uses a
normal `tasks.submit` directive with `mode: "compact"`. Agent mode also performs one automatic
Compact checkpoint when its projected prompt exceeds 64 KiB and no checkpoint has yet been written
for that run. Both paths preserve the active Plan, current instruction, decisions, constraints,
receipts, unresolved work, and child outcomes needed to continue.

Prompt projection uses the current system contract, active Plan, newest applicable Compact
checkpoint and retained messages, messages after the checkpoint, and the run's immutable capability
snapshot. Full history remains available to ordinary queries and audit policy.

---

## Todo progress

`todo` is an Effect tool. One call replaces the ordered logical checklist with stable IDs and
`pending`, `doing`, or `done` states. Duplicate IDs, empty text, multiple doing items, and regression
of a completed ID fail validation.

The call and result are canonical `agent_message` rows. The latest successful `todo` result in the
active run is the current projection; the last terminal run remains visible until another directive
starts. There is no Todo collection. Todo is progress evidence, while Plan verification remains the
completion authority.

---

## Child Tasks and barriers

The `subagent` tool supports spawn, read, message, await, steer, stop, and resume inside one root
workbench. Child depth uses the host-stamped invocation budget and is bounded by the platform limit.
Cross-workbench and cross-tenant discovery or messaging are refused.

Every directly spawned child is a required join. Before a parent can settle, its child barrier is:

- `waiting` while any required child is non-terminal;
- `consume` when terminal child results have not yet been appended as canonical tool results;
- `clear` only after every child is terminal and consumed.

A waiting barrier commits `phase: "children"` and waiting Task/run state, then releases the host
invocation. Child completion readies the parent through the ordinary durable scheduler. Re-entry
increments the Task/run epoch, preserves the run's immutable capability snapshot, replays the
unresolved subagent call, and appends its single result before continuing. Messages entering a child
from its caller use `parent-agent` attribution.

---

## Capabilities and tools

Each run stores an immutable snapshot of qualified Tool, Skill, and MCP capability IDs and content
digests. Capabilities come from system, host, tenant, and personal tiers, are filtered by the current
subject and mode, and are compiled into Effect `Tool` and `Toolkit` handlers. A capability body or
credential is never copied into the run snapshot.

Platform collection tools use the same policy engine and approval behavior as UI mutations.
Authored tools, MCP tools, sandbox operations, and host tools appear only when the effective policy
and run mode allow them. A missing grant is a typed tool failure, never implicit access.

---

## Ordinary sync engine reads

Agent state has no special event stream or client queue. UI and Envoy consumers issue ordinary
declarative queries such as:

```ts
client.db.agent_task.findMany({ where: { id: { eq: taskId } } });
client.db.agent_message.findMany({
  where: { task_id: { eq: taskId } },
  orderBy: { sequence: "asc" },
});
client.db.agent_plan.findMany({
  where: { task_id: { eq: taskId } },
  orderBy: { revision: "desc" },
});
client.db.agent_task.findMany({ where: { parent_id: { eq: taskId } } });
```

A browser client's one physical multiplexed Sync v2 connection keeps every admitted query live
across tabs and workspaces. Agent mutations enter the same committed change batches and precise
prefix deltas as any other collection. Field masks hide capability snapshots, provider details, and
internal failures when the viewer lacks permission.

The primary Task view renders the ordered durable messages. Plan state, Compact checkpoints, Todo
progress, current run diagnostics, exact usage, and child Tasks are projections of these same live
queries. A child view recursively renders that child's Task and transcript.

---

## Exact metering

Every language or embedding provider attempt receives a deterministic `call_id` before dispatch and
produces one `agent_usage` row. Plan creation, Plan verification, manual and automatic Compact,
ordinary Agent iterations, retries, fallbacks, embeddings, and child calls all follow this path.

The row records provider, model, operation, provider-authoritative integer usage units, and an exact
charge encoded as integer coefficient plus decimal scale. It also records whether the charge came
from the provider or a versioned price table. Currency is never accumulated with floating-point
arithmetic.

`settlement_id` is exactly `ai:${callId}` and is replay-safe. A complete observation starts pending
settlement; missing usage, charge, source, or pricing version marks the row attention. A settled row
is valid only when all four are present. Task totals are exact aggregations of visible usage rows or
the billing ledger and are converted to presentation decimals only at the UI boundary.

Provider calls and external tool effects run outside database transactions. The immutable usage row
and idempotent ledger settlement ensure a retry cannot silently double-charge or settle an estimate.
