# Agents

A Bolt agent holds a **conversation**, coordinated by Effect v4. PostgreSQL holds the complete
conversation state; Effect AI owns prompts, model calls, typed tools, response parts, structured
output, retries, scopes, and interruption. Web and Envoy callers use the same send and control
commands.

The conversation owns its message queue, Plan and transcript. The existing \`bolt_task\` queue owns
execution: a browser admission creates a durable continuation, and the host runs it with a renewable
lease. Closing the browser does not stop it. A restarted host reclaims expired work; an unscheduled
admission is repaired during host recovery. There is no separate agent scheduler.

Source: `src/runtime/agents/agents.ts`, `src/runtime/agents/capability-catalog.ts`,
and `src/runtime/envoys/envoys.ts`.

How subjects and collection visibility are resolved: [access](../access/README.md). A gated write
returns the ordinary collection-mutation approval state: [approvals](../access/approvals.md).

---

## Runtime shape

```text
conversations.send
     │  admit one queued conversation_message; persist its execution authority
     │  enqueue conversations.answer; return the admission
     ▼
host task queue (renewable lease)
     ▼
take the conversation
     │  status idle→running is the mutex; mint a turn + snapshot capabilities
     │  the queued message it answers is marked consumed in the same write
     ▼
Effect Prompt → language model → complete assistant message
     │                              │
     │                              └─ tool calls commit before effects begin
     ▼
Effect Toolkit handlers run together → complete tool-result messages in call order
     │
     ├─ Plan verification phase
     ├─ uncollected background jobs — refused an ending, once
     └─ exact provider observation per call
     ▼
settle the turn and the conversation
     │
     └─ another message still queued? answer it in a new turn, same invocation
```

Every model iteration loads durable rows, projects an Effect `Prompt`, calls the selected Effect
model, folds response parts into one complete assistant message, and commits that message before
executing any tool call. A step's calls run together through the evaluated Effect `Toolkit`; each result
is encoded as a typed tool-result part and committed before the next model iteration.

Every write goes to the collection it belongs to — a message to `conversation_message`, a turn to
`turn`, a plan to `plan`, a provider call to `turn_usage` — and never as a relation nested under the
conversation row. Nesting makes a mutate a _replacement_, so the write has to name every sibling it
is not changing, which costs a read of the whole conversation before every write.

Rows that change together are still written together. A mutate is one transaction and publishes one
commit, and its roots may name different collections — so starting a turn creates the run, marks the
message it answers answered and moves the conversation to `running` in **one** statement, and
settling it writes the run and the conversation in one more. A whole turn is four commits. The
conversation row is written only when the conversation itself changes: recording a provider call,
delivering steering and recalling a cancelled message all leave it alone. The turn also holds its
transcript in memory for its duration and records each row as it writes it, so a streamed part reads
nothing at all.

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

Send and message revision return after admission and durable scheduling. Resume preserves the prior
turn's mode and selected model and schedules its continuation. The internal `conversations.answer`
route accepts only a matching live task claim. It resolves the original user from current membership;
changed or removed authority prevents model calls and surfaces an error. No session credential is
stored in the task payload.

A driver owns the root turn and its synchronous children. Its lease renews while it works. Competing
queued work waits without consuming failure retries. On restart, only the reclaimed driver's turns
are fenced and recovered. Missing tool receipts become explicit unknown outcomes, never evidence
that a mutation did not happen. The root resumes from its transcript; interrupted children are
marked failed for the parent to assess. Stop remains terminal until a person resumes or sends new
instructions. Permanent provider failures still require attention after provider retries are exhausted.

The composer lists the host-configured language models. Selection is validated before admission,
saved on the message, and copied into the immutable run. Changing a queued turn's choice never
changes an active run. A removed model fails explicitly; it never falls back to another model.
Resume can select a recovery model, otherwise it retains the last turn's choice. Child
conversations and automatic Plan continuation inherit the current run's model. A send that omits a
model uses the host default.

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
model and priority that turn should run under. Those describe _this message_, not a separate work
item about it. A message nobody is waiting on carries no queue state at all: an assistant reply, a
tool result, a system note.

**Priority decides when a queued message enters the transcript**, and that is the whole of what
`steer` means:

| Priority | Enters the transcript          | Effect                                                                                        |
| -------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `steer`  | at the next **step**, mid-turn | consumed before the next model call, keeping the running turn's model and capability snapshot |
| `normal` | at the end of the **turn**     | answered by a new turn                                                                        |

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

## Envoys

A transport chat is one conversation: one direct message and one group channel each map to exactly
one `conversation`, for as long as the workspace lives. The host authenticates the wire and posts
each inbound message to `envoys.receive`, which buffers it and wakes a claimed `envoys.drain`
occurrence immediately — there is no batch window. The drain admits every addressed message as a
`steer`, with its `submissionId` derived from the transport message id so a redelivery is the same
message, then runs turns on the chat's conversation until nothing is left queued. A drain that
finds another turn still working defers its own claim instead of polling.

A message written mid-turn is consumed before the next model step; one written while the assistant
is idle starts the next turn on the same transcript. Because the conversation is the chat's and not
one sender's, every member the host verifies acts under the envoy's declared policies — the first
sender's id stays the durable owner, and admission and execution both accept any subject holding
exactly those policies.

### The channel replica

`bolt_envoy_messages` is the chat as the channel showed it: every inbound message and every
outbound send, both directions, in `(sent_at, id)` order. It is a replica, not a drain buffer — a
row is appended once and keyed by the provider's own message identity, so a redelivery, a webhook
retry, or a sync overlap is a no-op. `origin` records where a row came from (`live`, `sync`,
`backfill`, `send`); media bytes are materialized into conversation assets at ingest, and a
descriptor whose bytes the provider could not hand over is still listed. A provider-reported edit
updates the replica row and sets `edited_at`; an admitted transcript row is never rewritten.

Addressed rows also queue as work. Ambient rows never do: they sit in the replica for
`read_messages` to serve.

### `read_messages` and the unread preempt

`read_messages` is a platform tool, declared only for an envoy agent. It returns the conversation's
unread ambient messages oldest first, marks them read by the tool call's own effect id (so a crash
between marking and answering replays the same batch), and reports where the replica begins — its
floor timestamps and how many synced rows predate the first live arrival. The result carries the
honest caveat: content is what the channel last reported, a sender may have edited or deleted a
message since, and messages from before the replica's floor cannot be retrieved.

On every provider iteration an envoy conversation appends a trailing system note with the unread
count, so the model knows to look before answering. The note rides after the transcript, never at
the head, so the cached prompt prefix is untouched when the count changes.

Assistant text parts are delivered as they close. Everything before the final part is posted to the
transport as a short update the moment it is written; the final part is the turn's answer, sent
when the turn settles, and each send's provider receipt (message id and rendered body) becomes the
outbound half of the replica. The host renders the model's markdown into the channel's own
formatting from one AST — WhatsApp markup, Telegram HTML, or plain text. Tool calls and reasoning
never leave the workspace: they stay in `conversation_message` rows, which the web variant of the
transcript renders.

### History floors

A channel can only show what it has seen, and the replica says so. WhatsApp's `syncFullHistory`
backfill lands as `origin=sync`, pre-read rows that never wake a turn; its floor is the pairing
moment, and rows that predate the first live arrival are counted in the horizon report. A
transport with no history API simply starts at its first live message.

Which channels exist is the host's contract, not the runtime's: a transport either holds an
outbound connection (WhatsApp over Baileys) or accepts verified webhooks (Telegram), and both
paths arrive as the same `envoys.receive` delivery — already authenticated by the host and
carrying no claimed authority.

---

## Five durable collections

These ordinary Bolt system collections are the complete logical agent store:

| Collection             | Durable responsibility                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`         | Workbench, subject and agent ownership, audience, parent, lifecycle, active plan and turn. Its `status` is also the mutex                                                          |
| `turn`                 | One provider loop: the queued message it answers, mode, phase, input boundary, model, capability snapshot, status. An identifier and a usage owner, not a lifecycle                |
| `conversation_message` | One encoded Effect `Prompt.Message`, ordered by sequence, with author, semantic hash, optional turn, annotation — **and its queue state**: `state`, `mode`, `priority`, `model_id` |
| `plan`                 | Immutable plan revisions containing objective, approach, verification criteria, checkpoint sequence, and state                                                                     |
| `turn_usage`           | One immutable usage and exact-charge observation per provider attempt, with replay-safe settlement identity                                                                        |

There is no sixth. `agent_inbox` was a table of directives _about_ messages; its one real job is a
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
that is not a transcript. Whether an empty part is _rendered_ is the panel's decision, and a
whitespace-only part is not shown once it settles.

Uploads use conversation-scoped file descriptors, with at most eight attachments totaling 20 MiB
in the active context. Every attachment is a stored object: the message that carried it lists its
descriptor — name, type, size and key — as text, and nothing attaches to a request because a message
carried it. The model reads a stored file through `use_image`, the one reader tool; the host resolves
tenant storage, verifies sizes, and hands the provider an image, or a document's extracted text, and
only the newest that fit one turn ride it. A descriptor the reader refuses, or an object the host
cannot read — an undecodable image, an unsupported document, a stored row that changed or vanished —
is left unread and named to the model in the prompt, never failed: no attachment can leave a
conversation unable to answer. Bytes never cross the guest invocation boundary. PDF extraction runs
in a bounded worker, preserves page markers and the original SHA-256, and refuses unreadable pages
rather than returning partial evidence. The standalone reader exports `extractDocumentText` for host
adapters. The embedder supplies the workspace file store and download URLs through
`WorkspaceFilesHost`.

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

Planning is root-only. Its only mutation capability is `update_plan`: create or replace the
Markdown body, or apply an exact single-match text patch against `expectedRevision`. Each accepted
change creates an immutable body revision and atomically supersedes its predecessor. Ordinary
assistant replies remain discussion and do not replace the Plan. Plan mode permits `update_plan`,
`describe_workspace`, `list_skills`, `read_skill`, `read_collection`, `list_personal_skills`,
`read_personal_skill`, `workspace_read`, `workspace_review` and `agent_output_read`. Validation,
execution, delegation, implementation and web tools are excluded even if marked read-only.

During planning, discussion stays visible as a normal conversation. A collapsed draft Plan floats
above the queue and composer and can be expanded for review. Execute plan seals that revision and
records the context cutoff in the same transaction that claims the execution input. Only then does
the UI archive prior discussion under the Plan's Summary/Transcript tabs. Execution receives the
Plan, platform instructions and newly delivered messages; pre-finalization discussion is not replayed.
Queued inputs use their delivery position, so they remain visible to the run that consumes them.

A draft locks the conversation in planning. Changing the composer mode cannot start execution:
`conversations.send` requires an explicit `planAction: { action: "execute", planId }` for the current
revision, emitted by the Plan button. Revision pauses the executor at a tool boundary and parks
queued execution inputs until the revised draft is explicitly executed. Delete removes the active
Plan and returns to ordinary Agent mode; deleting during execution also stops that turn and cancels
its queued inputs. Both revision and deletion preserve any existing archive cutoff instead of
reintroducing old planning discussion. Their admission and claim writes fence the conversation row
version so stale transitions cannot overwrite a concurrent deletion.

Each natural completion of execution enters `verify`. A separate reviewer call receives the Plan
and projected evidence, excluding the executor's role instructions and hidden reasoning. It uses the
selected model and session, with its own metered call ID. Success requires complete=true and no gaps.
An incomplete verdict privately queues actionable gaps for another execution turn; there is no
fixed verification-cycle cap. Transient provider retries remain bounded. Explicit Stop fences a late
verdict and does not auto-resume. Plan and Compact turns never invoke the verifier. Routine system
messages stay hidden; errors are surfaced.

Compact mode appends an annotated agent message containing the summary, cutoff sequence, and
explicitly retained message IDs. Only text parts become the checkpoint. Every checkpoint uses one Markdown table:

| Section         | Summary                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Goal            | Objective, constraints and decisions in one or two sentences; do not repeat completed instructions. |
| Progress        | Completed work, verified checks, exact commits and acceptance evidence.                             |
| What we learned | Findings, failure causes and relevant context.                                                      |
| What's left     | Unfinished work, blockers, questions and the next action, including a final response still owed.    |

Empty, malformed or truncated summaries are rejected without replacing context. Manual, automatic
and requested compaction share the same implementation: at most 800 words with a 4,096-token
allowance, then one corrective attempt
at 8,192 tokens. Each attempt is metered separately. The summary instruction is the final user turn
of the request so a model does not resume the tool loop it was asked to summarize. A separate system
message marks a completed checkpoint request fulfilled before ordinary work resumes. Durable
messages are never edited or deleted by compaction.

The generation carries `purpose: "compaction"` on the same model and session. Tool schemas remain
present on the normal summary path to preserve the request prefix; the host disables tool selection
and optional DeepSeek reasoning for this purpose. An oversized legacy transcript is folded in bounded
fragments with a rolling summary and no tools. Only a complete fold replaces the prior checkpoint. Reasoning-mode or context changes can still cause a cache miss.

**Three things ask for a checkpoint.** A person sends `/compact` (`origin: "manual"`), an agent
calls `compact` after completing a phase (`origin: "requested"`, at most three times per turn), or
the runtime crosses its working-context bound (`origin: "automatic"`). All modes use automatic
compaction, including planning and verification. The soft threshold is the smaller of 200,000
estimated tokens and 90% of the model's declared window less the reply allowance. A separate conservative UTF-8/JSON byte
budget accounts for tool schemas, chat overhead and the full requested reply allowance. It checks
ordinary calls, each compaction fragment/retry and verifier calls before dispatch. The working
projection is checked again after compaction; retained instructions or a Plan that still cannot fit
fail closed, preserving the transcript. There is no "continue over budget" path.

Colony additionally checks the resolved prompt, including extracted document text and binary assets,
before sending HTTP to the provider. Document compression cannot bypass the descriptor-level check.
These guards deliberately overcount rather than equating four bytes with one exact token. They are
not a provider tokenizer: the catalog's context window and the provider's reported usage remain the
sources for capacity and actual token counts. An oversized immutable attachment needs a smaller
selection or a larger context window; repeatedly summarizing the same history cannot fix it.

The conversation ID travels as `AIRequest.Generate.sessionId` through normal generation,
compaction, verification, and later turns. Hosts can use that stable identity for provider cache
routing without putting changing per-call IDs into the cache key. Required reasoning metadata
remains in the canonical provider messages.

Prompt projection uses the current system contract, active Plan, newest applicable Compact
checkpoint and retained messages, messages after the checkpoint, and the run's immutable capability
snapshot. Full history remains available to ordinary queries and audit policy.

---

## Todo progress

`todo` is an Effect tool. One call replaces the ordered logical checklist with stable IDs and
`pending`, `doing`, or `done` states. Duplicate IDs, empty text, multiple doing items, and regression
of a completed ID fail validation.

The call and result are canonical `conversation_message` rows, and a `set` writes the replacement list
to `conversation.todos`, which the panel reads directly as the current projection. There is no Todo
collection. Todo is progress evidence, while Plan verification remains the completion authority.

---

## Child conversations

The `subagent` tool supports spawn, read, message, await, stop, and resume inside one root
workbench. Its input schema is built per workspace when the run's capability snapshot is taken:
`agentId` is an enum of the spawnable agents, the web agent plus every declared envoy, so a spawn
naming any other agent fails to decode before it reaches the runtime. A call that does not decode,
for this tool or any platform tool, is answered with `InvalidToolInput { tool, path, message }`,
rendered to the model as `Invalid input for tool "subagent" at "agentId": ...`; `ToolNotAllowed`
is reserved for a tool or target the agent may not use. Child depth uses the host-stamped
invocation budget and is bounded by the platform limit. `read` and `message` also reach any other
conversation of the same person; `await` stays in the tree, `stop`/`resume` act on a direct child,
and cross-tenant access is refused.

**A child is a task of its own.** A spawn admits the child's directive and enqueues its answer as a
durable `conversations.answer` task under the message's own claim — exactly what a person's send
or an agent's message to a sibling does — and the task driver runs children as it runs roots. The
parent's turn goes on, and may finish, with children still running. When a child settles, done or
failed, it writes `[Agent conversation <id>] <status>: <answer>` into the parent conversation and
enqueues the parent's answer: a steer the parent takes at its next step if it is mid-turn, the
input of its next turn if it is idle. A parent that wants the answer sooner waits for it
(`subagent await` or `wait`, both bounded); one that does not is woken by it.

A child recovers under its own claim at lease expiry, as any task does; a parent's interruption
says nothing about it. Nesting is bounded by the invocation budget, read from the conversation's
own `parent_id` chain, so nothing has to be threaded through the call. Messages entering a child
from its caller use `parent-agent` attribution, and therefore steer.

## Nothing waits forever

A host tool call answers inline while it is quick; past thirty seconds it goes on as a **job** of
the turn — ended at ten minutes — and the model has its id at once. `wait` is the one way to wait:
at most ten minutes a call, on named jobs and conversations or on everything the turn started,
returning the moment one settles with its result, the moment the person writes (a steer, which the
composer sends by default while the agent works), or at the bound with what is still running —
and the model is back in charge, to answer or wait again. A turn is refused its ending, twice,
while a job of its is uncollected; a job left after that is interrupted with the turn.

---

## Capabilities and tools

Platform tools, in the order the catalogue offers them: `wait`, `todo`, `compact`, `describe_workspace`,
`list_skills`, `read_skill`, `search_task_history`, `read_messages`, `use_image`, `read_collection`,
`write_collection`, and `subagent`. `read_messages` is declared only for an envoy agent, where a
chat replica exists to read; every other agent gets it off its list. All but `compact` answer from
within the tool call; `compact` records the intent and the turn's own loop writes the checkpoint at
its next step, because compaction rewrites the projection the loop is about to send.

Each run stores an immutable snapshot of qualified Tool, Skill, and MCP capability IDs and content
digests. Implemented capabilities come from system, host, and tenant tiers, are filtered by the current
subject and mode, and are compiled into Effect `Tool` and `Toolkit` handlers. A capability body or
credential is never copied into the run snapshot.

Platform collection tools use the same policy engine and approval behavior as UI mutations.
Authored tools and MCP tools require an effective policy grant. For the web agent acting for a
person, the optional host facility answers `capability_catalog` with tool names, descriptions,
JSON input schemas and `readOnly` flags. An unbound host contributes no tools. A malformed bound
catalogue is an error. Plan receives only explicitly allowed source and web reads; readOnly alone does not admit a tool. Compact receives none. Machine and
envoy identities do not acquire personal workspace authoring through this catalogue.

Every Message generation sends the allowed tools in `output.tools`. Providers must forward these
schemas to their model API and return complete Effect tool-call messages without executing them.
Bolt executes each call through the same authorization boundary and appends its durable result
before the next generation. Tests must inspect the provider request as well as scripted results.

Colony supplies `workspace_read`, `workspace_edit`, `workspace_apply`, `workspace_format`,
`workspace_validate`, `workspace_review`, `sandbox_bash` and `agent_output_read` against the same private
source store used by Studio. The trusted tenant/environment/person selects the draft; model input
cannot select another owner. Apply requires the commit observed while reading, accepts at most 32
text files / 1 MiB, and atomically refuses stale commits or excluded paths. Each search must match exactly once unless `replaceAll` is set; edit accepts at most 32
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

The conversation groups earlier messages inside a bounded Plan or Compaction segment with Summary
and Transcript tabs. The card discloses messages retained alongside the summary in the model context;
they remain inside Transcript rather than being repeated below the card. Queued and late-consumed
inputs stay in the continuing conversation. Planning discussion stays visible until the user starts execution; draft edits alone do not archive it. Goal progress, usage and child work are projections of the
same live queries. Child views use the same context segment. Composer uploads sit at the left;
model, mode, steering and send controls sit at the right. Access follows the requestor's policies.

Pending inputs appear in a compact queue above the composer. Dragging changes their execution
order, Steer now promotes an input for delivery at the current turn's next boundary without
interrupting the provider call, and Remove excludes it from execution. Queue changes are
author-scoped and checked against row versions. Queue positions live in input annotations;
transcript sequences and message contents remain unchanged. Removed inputs are distinct from
stop-cancelled inputs and are never recalled by Resume. Delivered inputs enter the model prompt at
their consumption point rather than their earlier submission position.

Where a run's `model_id` differs from the previous run that persisted a message, the panel renders
a divider naming the new model before that run's first message (`modelChangeDividers` in
`src/client/ui/agent/transcript.ts`). It is read off the stored run rows, so it survives a reload;
a run that persisted no message carries no divider.

Typing `/` as the first character of the draft opens the command menu with `plan`, `compact` and `export`
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

Every language or embedding provider attempt receives a deterministic `call_id` before dispatch.
A returned observation produces a `turn_usage` row; interrupted calls can be billed before their
final observation arrives, so running and interrupted-model totals are shown as partial.
Plan creation, Plan verification, manual and automatic Compact,
ordinary Agent iterations, retries, fallbacks, embeddings, and child calls all follow this path.

The row records provider, model, operation, provider-authoritative integer usage units, and an exact
charge encoded as integer coefficient plus decimal scale. It also records whether the charge came
from the provider or a versioned price table. Currency is never accumulated with floating-point
arithmetic.

`settlement_id` is exactly `ai:${callId}` and is replay-safe. A complete observation starts pending
settlement; missing usage, charge, source, or pricing version marks the row attention. A settled row
is valid only when all four are present. Conversation totals are exact aggregations of visible usage rows or
the billing ledger and are converted to presentation decimals only at the UI boundary.

Runs have no fixed tool-call count or USD 5 stop. Cost is a visible gauge, not permission to stop
productive work. After three identical consecutive failed tool attempts, the runtime appends
recovery guidance and keeps working. Completion, explicit stop, authorization and actual failures
still settle the turn normally. History reads paginate by sequence, so conversations beyond 500
messages retain their newest evidence and allocate new message sequences correctly. The browser
wait timeout does not cancel the detached host run.

The inline composer disclosure shows rounded context usage, cost and input/output tokens, including child turns
and pending settlement receipts. It exposes cache reads and reasoning separately without counting
them twice; missing receipts are labelled partial. Tool counts are collapsed inside the disclosure.

Provider calls and external tool effects run outside database transactions. The immutable usage row
and idempotent ledger settlement ensure a retry cannot silently double-charge or settle an estimate.

Conversation titles use the first sentence of the first user message, trimmed to 80 characters,
without a separate model call. Internal child-agent routing prefixes are excluded. Upgrading an existing database adds the nullable title column idempotently. Framework model
columns participate in the compiler's schema fingerprint, so a package upgrade cannot bypass the
host migration gate merely because the authored collection lineage is unchanged.
