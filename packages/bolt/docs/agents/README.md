# Agents

A Bolt agent holds a **conversation**, coordinated by Effect v4. PostgreSQL holds the complete
conversation state; Effect AI owns prompts, model calls, typed tools, response parts, structured
output, retries, scopes, and interruption. Web and Envoy callers use the same send and control
commands.

**An agent has no tasks.** It has a conversation, turns within it, and a queue of messages waiting to
be answered — and that queue belongs to the conversation, not to a work scheduler. `bolt_task`, the
durable work queue, runs automations, schedules and envoy drains, and the agent path touches it zero
times. Some queue work *calls* a conversation — a scheduled envoy drain is queue work, and it then
sends a message — but the queue's involvement ends at the caller's door.

Source: `src/runtime/agents/agents.ts`, `src/runtime/agents/capability-catalog.ts`,
and `src/runtime/envoys/envoys.ts`.

How subjects and collection visibility are resolved: [access](../access/README.md). A gated write
returns the ordinary collection-mutation approval state: [approvals](../access/approvals.md).

---

## Runtime shape

```text
conversations.send
     │  admit one queued conversation_message; no directive, no work occurrence
     ▼
take the conversation
     │  status idle→running is the mutex; mint a turn + snapshot capabilities
     │  the queued message it answers is marked consumed in the same write
     ▼
Effect Prompt → language model → complete assistant message
     │                              │
     │                              └─ tool calls commit before effects begin
     ▼
Effect Toolkit handlers run sequentially → complete tool-result messages
     │
     ├─ Plan verification phase
     ├─ required-child barrier — runs any child that has not run, here
     └─ exact provider observation per call
     ▼
settle the turn and the conversation
     │
     └─ another message still queued? answer it in a new turn, same invocation
```

Every model iteration loads durable rows, projects an Effect `Prompt`, calls the selected Effect
model, folds response parts into one complete assistant message, and commits that message before
executing any tool call. Calls run sequentially through the evaluated Effect `Toolkit`; each result
is encoded as a typed tool-result part and committed before the next model iteration.

Every write goes to the collection it belongs to — a message to `conversation_message`, a turn to
`turn`, a plan to `plan`, a provider call to `turn_usage` — and never as a relation nested under the
conversation row. Nesting makes a mutate a *replacement*, so the write has to name every sibling it
is not changing, which costs a read of the whole conversation before every write.

Rows that change together are still written together. A mutate is one transaction and publishes one
commit, and its roots may name different collections — so starting a turn creates the run, marks the
message it answers answered and moves the conversation to `running` in **one** statement, and
settling it writes the run and the conversation in one more. A whole turn is four commits. The
conversation row is written only when the conversation itself changes: recording a provider call,
delivering steering and recalling a cancelled message all leave it alone. Nesting makes a mutate a
*replacement*, so the write has to name every sibling it is not changing, which costs a read of the
whole transcript before every write. The turn also holds its transcript in memory for its duration
and records each row as it writes it, so a streamed part reads nothing at all.

Providers may deliver acknowledged part snapshots through `AIMessageProgress`. Part starts persist
empty placeholders; part ends persist their content. Token deltas stay inside the provider adapter.
Reasoning parts are kept: the provider sends them whether or not anyone asked, `ReasoningPart` is a
member of Effect's `AssistantMessagePart`, and the column already accepts one. One assistant row is
updated while the turn holds the conversation, with a `generation` annotation containing
the provider call, boundary sequence and active part indexes. Completed parts cannot change. The
final response must match the completed snapshot before the annotation is cleared and tools execute.
Reconnection reads the latest durable snapshot through ordinary live queries. Interrupted rows stay
visible but are excluded from model prompts and tool execution.

Nothing is pushed to a browser out of band: every step is a row, and the sync engine delivers it the
way it delivers any other row. That is what lets a viewer who connects mid-stream see the partial
text, a reconnect recover it, and a second tab stay correct.

---

## Public commands

The fixed command catalogue exposes:

```ts
conversations.models({ agentId }); // configured language models and default

conversations.send({
	conversationId,
	submissionId, // unique per intentional message; retain for retries
	agentId,
	message,
	mode: 'agent' | 'plan' | 'compact',
	priority: 'normal' | 'steer',
	modelId // optional registered model ID
});

conversations.editMessage({ conversationId, messageId, message, modelId });

conversations.control({ conversationId, action: 'stop' | 'resume', modelId }); // model applies to resume
```

A send does not schedule anything. It admits the message and answers it in the same invocation:
there is no work occurrence to mint, no directive to claim, and nothing for a host scheduler to
discover. The response returns when the turn settles, which is why `conversations.send` carries the
`agents.turn` budget rather than the ordinary command deadline.

That is also the whole of the durability trade. A turn does not survive its caller: closing the tab
or losing the connection aborts it, and there is no resume. What replaced the occurrence is that the
caller is present for the entire turn and answers everything waiting before it returns.

The composer lists the host-configured language models. Selection is validated before admission,
saved on the directive, and copied into the immutable run. Changing a queued turn's choice never
changes an active run. A removed model fails explicitly; it never falls back to another model.
Resume can select a recovery model, otherwise it retains the last directive's choice. Child Tasks
and automatic Plan continuation inherit the current run's model. A send that omits a model uses the host
default.

`conversations.editMessage` appends a revision of one of the subject's own user messages and queues the
Agent directive that continues from it. The original row is not edited or deleted; the new row
names it in `supersedes_id`. Only the author may revise, and only the newest revision of a message
may be revised again.

`conversationId` identifies the conversation. Its first send atomically creates the root, canonical
message, and directive. A later submission must match its immutable subject, agent and audience.
Human root conversations accept follow-ups after completion, failure, attention or stop; each gets
a new run while preserving prior turns. Delegated conversations retain terminal result semantics. New
Clients mint `submissionId` once per send so identical text can be sent intentionally again; retries
with that ID deduplicate, and reusing it for different content is refused. The runtime's own
callers — a revision, a resume, a subagent spawn — mint nothing and are identified by their content,
which is what makes them idempotent under replay.

### The message queue is the transcript

A message somebody is waiting for an answer to carries its own queue state — `queued` until a turn
answers it, then `consumed`, or `cancelled` if the conversation is stopped — together with the mode,
model and priority that turn should run under. Those describe *this message*, not a separate work
item about it. A message nobody is waiting on carries no queue state at all: an assistant reply, a
tool result, a system note.

**Priority decides when a queued message enters the transcript**, and that is the whole of what
`steer` means:

| Priority | Enters the transcript | Effect |
| --- | --- | --- |
| `steer` | at the next **step**, mid-turn | consumed before the next model call, keeping the running turn's model and capability snapshot |
| `normal` | at the end of the **turn** | answered by a new turn |

**One agent writing to another always steers.** A person chooses; an agent does not, because a
parent writes to a child precisely when the child is about to act on what it says, and a message
that waits for the child's current turn to finish arrives after the work it was meant to change.
The rule lives in `admit`, keyed on `author.kind === 'parent-agent'`, rather than at the three call
sites that admit on an agent's behalf — and it is why the `subagent` tool has a `message` action
and no `steer` action: with the priority fixed, they were one call under two names.

An ordinary queued input is excluded from the running turn — that is the input boundary. A `steer`
matching the turn's mode is consumed before the next model step, including when it arrives during a
final generation; delivery and its receipt commit together, and the transcript marks it as steering.
When no turn is running, `steer` retains queue priority.

`conversations.send` answers the message it carried and then drains whatever else is waiting, in the
same invocation. `execute` deliberately answers one message, so an envoy or a schedule runs exactly
the turn it came for; `answerQueued` is the loop over it, and it is what replaced the durable work
occurrence between turns. Its first turn is unconditional: driving it from the queue read would let a
caller who cannot see the row admit a message and then run nothing, which is a silent non-answer
rather than a visible refusal.

Stop is a write, not an interrupt. `conversations.control stop` sets the status; the turn in flight
re-reads it at its next boundary and settles there, and the queued messages plus the one the stopped
turn was answering are cancelled in the same write. Nothing reaches into a running invocation, so
nothing had to be built to let it. Explicit resume recalls the stopped objective and cancelled
inputs as context, while an ordinary follow-up does not; it is admitted only for a stopped or
attention conversation after subject, agent, model, capability and access checks run again.

Only the `subagent` tool creates a child conversation. The runtime stamps its parent and keeps
every descendant in the root conversation's workbench.

---

## Five durable collections

These ordinary Bolt system collections are the complete logical agent store:

| Collection             | Durable responsibility                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`         | Workbench, subject and agent ownership, audience, parent, lifecycle, active plan and turn. Its `status` is also the mutex                                                   |
| `turn`                 | One provider loop: the queued message it answers, mode, phase, input boundary, model, capability snapshot, status. An identifier and a usage owner, not a lifecycle          |
| `conversation_message` | One encoded Effect `Prompt.Message`, ordered by sequence, with author, semantic hash, optional turn, annotation — **and its queue state**: `state`, `mode`, `priority`, `model_id` |
| `plan`                 | Immutable plan revisions containing objective, approach, verification criteria, checkpoint sequence, and state                                                              |
| `turn_usage`           | One immutable usage and exact-charge observation per provider attempt, with replay-safe settlement identity                                                                 |

There is no sixth. `agent_inbox` was a table of directives *about* messages; its one real job is a
column on the message it was about.

`conversation.status` is the write fence. Taking the conversation is a conditional move to `running`
that installs the active turn atomically, and every later append, tool effect, usage observation and
settlement re-reads it, so a turn that no longer holds the conversation cannot write or spend — and
so `stop` only has to write that column.

Conversation ownership is explicit. `subject_id` names the signed-in person or Envoy principal; `agent_id`
names the selected agent; `audience` controls personal versus workbench visibility; `parent_id`
forms the bounded child tree. Transport delivery and receipt state remain in Envoy transport
collections rather than being copied into conversation rows.

---

## Durable Effect messages

`conversation_message.message` stores one encoded Effect `Prompt.Message`. Text, reasoning, file/image,
tool-call, and tool-result parts remain inside Effect's typed part union and codec. There is no
second parts store or provider-specific transcript shape.

**Reasoning is always captured.** The provider reasons whether or not anybody asked — GLM 5.3 Flash
refuses to disable it (`400 Reasoning is mandatory for this endpoint`) — so the workspace pays for
reasoning on every turn, and it is kept. `ReasoningPart` is already a member of Effect's
`AssistantMessagePart` and the column already accepts one, so nothing was added to make this work;
what was removed is the flag that threw the content away. The literal a model emits when nothing was
thought (`None.`) is stored too: it is what the model said, and a transcript that silently edits
that is not a transcript. Whether an empty part is *rendered* is the panel's decision, and a
whitespace-only part is not shown once it settles.

Uploads use conversation-scoped file descriptors, with at most eight attachments totaling 20 MiB
in the active context. Images travel in `imageAssets`; PDF and text documents travel in
`fileAssets`. The host resolves tenant storage, verifies sizes, and passes extracted document text
to the provider. Bytes never cross the guest invocation boundary. PDF extraction runs in a bounded
worker, preserves page markers and the original SHA-256, and refuses unreadable pages rather than
returning partial evidence. The standalone reader exports `extractDocumentText` for host adapters.
The embedder supplies the workspace file store and download URLs through `WorkspaceFilesHost`.

The ordering contract is strict:

1. append the complete assistant message containing a tool call;
2. check that the turn still holds the conversation;
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

Plan mode creates one `plan` revision containing the objective, implementation approach, and
verification criteria. It receives only the read-oriented planning capability set and does not
perform implementation writes. A newer Plan atomically supersedes the active revision while prior
revisions remain queryable.
Every revision reproduces the complete plan. Only the final response text becomes the plan body;
reasoning remains in its transcript. Queued inputs record when they were delivered, so a plan or
compaction written while they waited cannot hide them from their eventual turn.

After an Agent run implements an active Plan, the same conversation runtime enters its `verify` phase and
makes a separate tool-free structured-output call. A complete verdict verifies the Plan. An
incomplete verdict appends its gaps and admits a bounded successor Agent directive. The production
runtime permits three verification attempts before marking the plan stalled and the conversation attention.
Plan and Compact runs do not enter this phase.

Compact mode appends an annotated system message containing the summary, cutoff sequence, and
explicitly retained message IDs. The automatic checkpoint stores only the text parts of the summary
generation (a reasoning part or a tool call the model emits are dropped, and a checkpoint with no
prose carries a sentence saying so), and its summary instruction is the final user turn of that
request rather than a trailing system message, so a model does not resume the tool loop it was
asked to summarize. It never edits or deletes durable messages.

**Three things ask for a checkpoint, and the annotation records which.** A person runs `/compact`,
which is an ordinary `conversations.send` with `mode: "compact"` (`origin: "manual"`). The agent
calls the `compact` tool, giving a reason, when a phase of work is done and its intermediate steps
have stopped earning their place (`origin: "requested"`) — up to three times in a turn, after which
it is refused in a system message it can read. And the runtime checkpoints on its own when the
context nears the model's window (`origin: "automatic"`), once per turn: a turn still over the bound
after compacting has nothing left that a summary of a summary would shrink, so the second attempt
records a degraded note instead and the turn proceeds. Every path preserves the active Plan, current
instruction, decisions, constraints, receipts, unresolved work, and child outcomes.

**The bound is the model's own context window**, three quarters of it, not a fixed size. The window
is a required field on `ModelCatalogEntry` — a host registering a model knows it — and is stamped
onto the turn at claim, so a checkpoint can be read back against the bound that caused it. It used
to be 64 KiB of projected prompt bytes: one number for every model, in the wrong unit, compacting a
1M-token model at six percent of its capacity and a 32k model too late.

What is compared against it is the provider's own token count from the last call — `inputTokens +
outputTokens`, cached tokens included, since a cached token still occupies the window — or a
four-bytes-to-the-token estimate of the projection, whichever is larger. The measurement says what
the last call cost; the estimate covers everything appended since, and a conversation's first call
has only the estimate. The checkpoint generation runs on the turn's own model, so the cached prefix
it shares with the turn stays cached.

Prompt projection uses the current system contract, active Plan, newest applicable Compact
checkpoint and retained messages, messages after the checkpoint, and the run's immutable capability
snapshot. Full history remains available to ordinary queries and audit policy.

---

## Todo progress

`todo` is an Effect tool. One call replaces the ordered logical checklist with stable IDs and
`pending`, `doing`, or `done` states. Duplicate IDs, empty text, multiple doing items, and regression
of a completed ID fail validation.

The call and result are canonical `conversation_message` rows. The latest successful `todo` result in the
active run is the current projection; the last terminal run remains visible until another directive
starts. There is no Todo collection. Todo is progress evidence, while Plan verification remains the
completion authority.

---

## Child Tasks and barriers

The `subagent` tool supports spawn, read, message, await, stop, and resume inside one root
workbench. Its input schema is built per workspace when the run's capability snapshot is taken:
`agentId` is an enum of the spawnable agents, the web agent plus every declared envoy, so a spawn
naming any other agent fails to decode before it reaches the runtime. A call that does not decode,
for this tool or any platform tool, is answered with `InvalidToolInput { tool, path, message }`,
rendered to the model as `Invalid input for tool "subagent" at "agentId": ...`; `ToolNotAllowed`
is reserved for a tool or target the agent may not use. Child depth uses the host-stamped
invocation budget and is bounded by the platform limit. Cross-workbench and cross-tenant discovery
or messaging are refused.

**A parent runs its own children.** Nothing else would: the runtime has one driver of a turn — the
request that admitted the message — and a spawned child has no such request. The parent is that
driver, one level up, so a child that has not run is run at the barrier, and `subagent await` runs
it too. The child is a frame on the parent's stack; there is no state in which a conversation is
stopped and expecting something else to restart it, which is why there is no `waiting` status.

Every directly spawned child is a required join. Before a parent can settle, its child barrier is:

- run any child that has not settled, to a stop;
- `consume` when settled child results have not yet been appended as canonical tool results;
- `clear` only after every child is settled and consumed.

The `consume` nudge is bounded. It is the only pressure left once children run inline — a child
always settles, so nothing else can end the loop — and a model that will not take the hint would
otherwise spin. After two, the turn finishes; the child's answer is durable either way.

Nesting is bounded by the invocation budget, read from the conversation's own `parent_id` chain, so
nothing has to be threaded through the call. Messages entering a child from its caller use
`parent-agent` attribution, and therefore steer.

---

## Capabilities and tools

Platform tools, in the order the catalogue offers them: `todo`, `compact`, `describe_workspace`,
`list_skills`, `read_skill`, `search_task_history`, `use_image`, `read_collection`,
`write_collection`, and `subagent`. All but `compact` answer from within the tool call; `compact`
records the intent and the turn's own loop writes the checkpoint at its next step, because
compaction rewrites the projection the loop is about to send.

Each run stores an immutable snapshot of qualified Tool, Skill, and MCP capability IDs and content
digests. Implemented capabilities come from system, host, and tenant tiers, are filtered by the current
subject and mode, and are compiled into Effect `Tool` and `Toolkit` handlers. A capability body or
credential is never copied into the run snapshot.

Platform collection tools use the same policy engine and approval behavior as UI mutations.
Authored tools and MCP tools require an effective policy grant. For the web agent acting for a
person, the optional host facility answers `capability_catalog` with tool names, descriptions,
JSON input schemas and `readOnly` flags. An unbound host contributes no tools. A malformed bound
catalogue is an error. Plan receives only read-only host tools; Compact receives none. Machine and
envoy identities do not acquire personal workspace authoring through this catalogue.

Every Message generation sends the allowed tools in `output.tools`. Providers must forward these
schemas to their model API and return complete Effect tool-call messages without executing them.
Bolt executes each call through the same authorization boundary and appends its durable result
before the next generation. Tests must inspect the provider request as well as scripted results.

Colony supplies `workspace_files`, `workspace_read`, `workspace_edit` and `workspace_apply` against the same private
source store used by Studio. The trusted tenant/environment/person selects the draft; model input
cannot select another owner. Apply requires the commit observed while reading, accepts at most 32
text files / 1 MiB, and atomically refuses stale commits or excluded paths. Edit accepts at most 32
precise replacements / 1 MiB of replacement input; each search must match exactly once. It preserves
the rest of a large file and rejects the whole batch if any edit is ambiguous or stale. Edits remain drafts for
Studio diagnosis, preview and review. They do not publish or alter Live. Standalone hosts may supply
their own source capability implementation through the same protocol.

---

## Ordinary sync engine reads

Agent state has no special event stream or client queue. UI and Envoy consumers issue ordinary
declarative queries such as:

```ts
client.db.conversation.findMany({ where: { id: { eq: conversationId } } });
client.db.conversation_message.findMany({
	where: { conversation_id: { eq: conversationId } },
	orderBy: { sequence: 'asc' }
});
client.db.plan.findMany({
	where: { conversation_id: { eq: conversationId } },
	orderBy: { revision: 'desc' }
});
client.db.conversation.findMany({ where: { parent_id: { eq: conversationId } } });
```

A browser client's one physical multiplexed sync connection keeps every admitted query live
across tabs and workspaces. Agent mutations enter the same committed change batches and precise
prefix deltas as any other collection. Field masks hide capability snapshots, provider details, and
internal failures when the viewer lacks permission.

The conversation renders the current context below a two-tab Plan/Summary and Prior transcript
segment. Planning revisions stay visible while working, then join the saved prior transcript when
the complete replacement plan arrives. Goal progress, usage and child work are projections of the
same live queries. Child views use the same context segment. Composer uploads sit at the left;
model, mode, steering and send controls sit at the right. Access follows the requestor's policies.

Where a run's `model_id` differs from the previous run that persisted a message, the panel renders
a divider naming the new model before that run's first message (`modelChangeDividers` in
`src/client/ui/agent/transcript.ts`). It is read off the stored run rows, so it survives a reload;
a run that persisted no message carries no divider.

Typing `/` as the first character of the draft opens the command menu with `plan` and `compact`
(`src/client/ui/agent/composer-commands.ts`); selecting an entry leaves `/plan ` in the composer
and closes the menu. A `/` anywhere else in the draft is prose and opens nothing.

The transcript follows its tail (`src/client/ui/agent/transcript-follow.ts`). A reader within 32 px
of the end stays at the end as rows arrive, parts stream or the body resizes; a conversation switch
or an own send pins the view to the end; a reader who scrolled up is left alone until they return.
Rows persisted after an automatic checkpoint therefore appear without a reload. Every markdown
surface in the panel (assistant text, reasoning, plan body, summary) renders with HTML disabled:
the model's text is markdown, never HTML.

---

## Exact metering

Every language or embedding provider attempt receives a deterministic `call_id` before dispatch and
produces one `turn_usage` row. Plan creation, Plan verification, manual and automatic Compact,
ordinary Agent iterations, retries, fallbacks, embeddings, and child calls all follow this path.

The row records provider, model, operation, provider-authoritative integer usage units, and an exact
charge encoded as integer coefficient plus decimal scale. It also records whether the charge came
from the provider or a versioned price table. Currency is never accumulated with floating-point
arithmetic.

`settlement_id` is exactly `ai:${callId}` and is replay-safe. A complete observation starts pending
settlement; missing usage, charge, source, or pricing version marks the row attention. A settled row
is valid only when all four are present. Conversation totals are exact aggregations of visible usage rows or
the billing ledger and are converted to presentation decimals only at the UI boundary.

Provider calls and external tool effects run outside database transactions. The immutable usage row
and idempotent ledger settlement ensure a retry cannot silently double-charge or settle an estimate.
