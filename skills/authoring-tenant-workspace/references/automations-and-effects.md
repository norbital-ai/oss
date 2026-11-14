# Automations and effects

Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').automation>[0]`, `import('@norbital-ai/bolt').AutomationCtx['ai']`, `EffectCtx`.

## Effects

- Put `effect(changes, ctx)` inside the model's `create`, `update` or `delete` block. It runs after commit as a durable `<model>.effect.<verb>` run, listed in runs and bounded by the effect retry policy.
- Every change has `before`, `set`, `after` and `changed(...fields)`. Create has no before row; delete has no after row. Update effects run only when stored values change. Filter the batch in code.
- It runs as the writer and holds no policy: rows are the root fields of the writer's output, and every read and write needs the writer's grants. Work needing other authority is an automation it schedules; `ctx.schedule` needs no start grant.
- Its writes run effects one level deeper; past 8 levels the run fails `depth`.
- Write effects held by an approval retain the frozen changes and writer; final approval releases them atomically and rejection discards them. Approval lifecycle events reach the same verb's effect with an empty change list and `ctx.event.kind === 'approval'`. Custom approval notifications use `ctx.notify` there; built-in inbox notices already exist.

## Automations

- An automation runs as the reserved system identity with its declared `policies` (required, non-empty). A `mode: 'job'` automation is durable and may start from cron, a person or `ctx.schedule`; `mode: 'call'` returns its output in the calling request. Every run holds exactly those policies and takes no approval decision, not even withdrawing a request it raised. A run has 10,000 crossings.
- `ctx.trigger` records the run's starter and, for a job, its run `id`. It is never authority: `actor.*` names the system identity, so an actor-scoped grant matches nothing and a ref default does not apply. Server code starts runs only with `ctx.schedule`; a `mode: 'call'` automation is a page's request/response.
- A rule about the starter is an explicit check of the trigger in the body. Refs the run writes are set explicitly.
- `capabilities.automations` grants manual starts only; code needs none.
- Records the body acts on are `input: { <name>: { kind: 'rows', of: '<model>' } }`. A caller sends ids; the body receives complete rows read under the run's policies, and an unreadable id refuses the start. Pass each row as the write `target` (it carries its revision): never query the ids again or hand-build `{ id, revision }`.
- Say no with `return yield* ctx.refuse('<message key>', { row?, field?, values? })`. The message is a catalogue key; `row` indexes the input list; a message with `{placeholders}` takes exactly those `values` (typed, required). `ctx.refuse` is the only refusal: never construct a `Refusal` or build text.
- A row write runs its model's `effect`; a row carried by another model's callback (`with`, `on_approved`) runs no effect, emits no write event and wakes no `ctx.wait`. An automation may also listen to a model's committed writes, template or system (`sys_user`, `sys_invitation`): `on: [{ model: 'sys_user', verbs: ['create', 'update'] }]`. Each committed statement queues one run per automation and verb with `ctx.trigger = { kind: 'system', cause: 'event', model, verb, records }`; the run takes no input, holds its `policies` (the writer needs none) and reads the rows it needs. A write held for approval emits when its approval commits it; a rejected or withdrawn one emits nothing. Runs chain at most 8 deep, identity writes included.
- Each automation admits 30 manual starts per minute per starter. Beyond it answers `429 rate_limited`. Cron, event and effect runs and acts in a body are never rate limited. A start over HTTP also counts against the policy `act` limit.
- A safety-net cron depending only on workspace data declares `rest`: when a run writes nothing, no slot fires until the workspace is used or the rest passes. Never on a cron that finds work by time or reads what a connected link writes.
- Server `ctx.schedule(name, input, { at?, key? })` queues a job and returns its `id` and `automation`. A page's `ctx.run` job handle exposes `.id`, `.ids` and `.automation`; yielding it confirms queue admission, not completion, and a refusal fails `ActRefused`. A page call yields its declared output.
- Every startable automation appears in the Command Center with its typed form; a page form is optional.

## Reruns

A dropped run reruns from the start, up to 3 times; a retry also starts over. Nothing is replayed, and `ctx.ai.*`, `ctx.request` and `ctx.web.*` are asked and paid again. Every body must be safe twice:

- Supply a stable domain key through the act's `{ key }` option when that write must deduplicate. Separate acts already committed may repeat when the body starts over; there is no positional replay or `once` option on acts.
- `ctx.send` durably queues a message and returns its id, even while its account awaits pairing. Save that id; waiting messages persist across host restart and spend no provider attempts until connected. Queue admission is not provider delivery: derive a business report's Sent state/timestamp from actual `sys_message` status/timeline and `sent_at` under an explicit output grant, never from the call's success or an in-app notification. A retry may queue a second send, and an interrupted provider call may have an uncertain outcome. Model the delivery state before promising exactly-once external work.
- Give `ctx.schedule` a `key`; key notices with `once`.

## Body rules

- A body receiving `ctx` is a generator. Yield its Effects directly; recover a specific failure with `Effect.catchTag`.
- A failed `yield*` ends the body; `try`/`catch` never sees it. One bad item in a loop ends the run unless that call has its own `Effect.catch`.
- Never wrap in `tryPromise` or run an Effect inside a body. Pure helpers stay plain. Guest helpers use `Effect.fnUntraced` or `Effect.fnUntracedEager`. Avoid traced workflows at module scope. Use explicit concurrency for batched crossings.
- Batch native read endpoints with `RequestResolver`; use `Cache` for shared lookups. A catalogue snapshot cache belongs to one operation; never refresh it halfway.
- Prove initialization by exercising the built artifact through the native host.

## Facilities

- `on` lists cron literals `{ cron, tz?, rest? }` and write listeners `{ model, verbs }`. Incoming webhooks belong to integration definitions (`webhook.handle` or sync deliveries), never automation triggers.
- A job waits with `ctx.wait({ until })`, `ctx.wait({ model, where?, verbs?, until? })` or `ctx.wait({ approval, until? })`: it holds no lane while waiting and resumes by rerunning from the start, earlier calls answered as before. Never hand-roll a state field and `schedule` chain for a multi-step process.
- Code before a wait makes the same calls on every resumption; a changed body fails a waiting run.
- Business I/O runs in automations: `ctx.request`, `ctx.send`, `ctx.web.read`, `ctx.files.*`, `ctx.geo.*`, `ctx.convert.*`, `ctx.ai.*`. Integration bodies call `ctx.request(op)` on their own instance.
- `ctx.convert.record(model, id, { to: 'pdf' })` prints a record's own view as the run's identity and answers its bytes, unstored; attach them to `ctx.send` or `ctx.notify` (which answers `{ messages }`). A PDF of a record is this, never a hand-built document.
- `ctx.convert.document`, `ctx.convert.record` and `ctx.convert.ingest` are optional. Recover `Unavailable` only when absence is allowed; other failures propagate unless the workflow recovers them.
- Discover each member's input on `AutomationCtx` and `Ai`.

## Browser work

- `ctx.browser` is the run's own tab, with no person's cookies. It closes when the run's scope ends, including failure or interruption.
- `navigate` and `snapshot` return a typed snapshot with URL, title, text and host metadata. Use refs from the current snapshot in typed `act` steps; `evaluate` returns JSON, `download(url, { for })` stores supported media, and `close` closes the tab early.
- Use `ctx.web.read(url)` when readable page text needs no interaction. This run browser is separate from the user's root-web `page` tool and the agent's fleet browser.
- Host browser failures propagate through the typed facility failure channel. Source wiring or a fake does not prove a host can drive the target site.

## AI

- `ctx.ai.sys_1.decide({ state, questions })` asks keyed questions over text-only state and returns typed answers. `ctx.ai.sys_2.infer` is the LLM. Neither falls back to the other.
- `sys_2.infer({ initial, output, … })` holds a complete answer in memory and exposes draft tools `read`, `find`, `edit`, `diff`, `submit`. Paths are JSON Pointers; a keyed list item is addressed by key, never index. Large reads are bounded: read child paths.
- Request `rules` (CEL over top-level properties) make an unfinished draft fail `invalid`.
- `tools: ['read', ...host_tools]` reads records as the run's policies across turns; bound it with `steps`. The draft reader is then `read_answer`.
- Transient provider failures retry inside the invocation, keeping the transcript and edited answer.
- Infer results are proposals. Store them for native form review before a separate confirmed apply; a write still runs through grants, checks and approvals. A person confirms anything changing money or access.
- Use the public `Ai` signature; test with scripted output, never a live model.
