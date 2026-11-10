# Automations and effects

Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').automation>[0]`, `import('@norbital-ai/bolt').Ai`, `EffectCtx`.

## Effects

- `effect: { created, updated, deleted }` on a model is work after a committed write, once per committed batch, as a durable run `<model>.effect.<verb>`: retried 3 times, listed in runs, never rate limited.
- `created` gets new rows, `deleted` stored rows, `updated` `[{ before, after }]` for writes that changed a stored field. Filter in code.
- It runs as the writer and holds no policy: rows are the root fields of the writer's output, and every read and write needs the writer's grants. Work needing other authority is an automation it schedules; `ctx.schedule` needs no start grant.
- Its writes run effects one level deeper; past 8 levels the run fails `depth`.
- Effects follow every commit, including provisional approval writes and their rollback. Work that must wait for approval uses the approval lifecycle or the outbox.

## Automations

- A job the reserved system identity runs with its declared `policies` (required, non-empty), on cron, webhook, manual start or `ctx.schedule`. Every run holds exactly those policies. Automations cannot approve; `ctx.approvals.withdraw(requestId, reason?)` takes back an open request the same automation asked for. A run has 10,000 crossings.
- `ctx.run.trigger` records `{ kind: 'person', actor, agent? }` or `{ kind: 'system', cause }` (cron, webhook, effect, schedule). It is never authority: `requestor.*` names the system identity, so a requestor-scoped grant matches nothing and a ref default does not apply.
- A rule about the starter is an explicit check of the trigger in the body. Refs the run writes are set explicitly.
- `capabilities.automations` grants manual starts only; code needs none.
- A row write runs its model's `effect`, never an automation.
- Each automation admits 30 manual starts per minute per starter. Beyond it answers `429 rateLimited`. Cron, webhook, effect runs and acts in a body are never rate limited. A start over HTTP also counts against the policy `act` limit.
- A safety-net cron depending only on workspace data declares `rest`: when a run writes nothing, no slot fires until the workspace is used or the rest passes. Never on a cron that finds work by time or reads what a connected link writes.
- A page starts a run with `ctx.run(name, input)`, which yields `id` and `automation` for run status. Output is readable on the run.
- Every startable automation appears in the Command Center with its typed form; a page form is optional.

## Reruns

A dropped run reruns from the start, up to 3 times; a retry also starts over. Nothing is replayed, and `ctx.ai.*`, `ctx.request` and `ctx.web.*` are asked and paid again. Every body must be safe twice:

- Upsert by a natural key, or pass `{ once: '<key>' }` to `ctx.act`.
- Check status before a send, and record it in the same write.
- Give `ctx.schedule` a `key`; key notices with `once`.

## Body rules

- A body receiving `ctx` is a generator. Yield its Effects directly; recover a specific failure with `Effect.catchTag`.
- A failed `yield*` ends the body; `try`/`catch` never sees it. One bad item in a loop ends the run unless that call has its own `Effect.catch`.
- Never wrap in `tryPromise` or run an Effect inside a body. Pure helpers stay plain. Guest helpers use `Effect.fnUntraced` or `Effect.fnUntracedEager`. Avoid traced workflows at module scope. Use explicit concurrency for batched crossings.
- Batch native read endpoints with `RequestResolver`; use `Cache` for shared lookups. A catalogue snapshot cache belongs to one operation; never refresh it halfway.
- Prove initialization by exercising the built artifact through the native host.

## Facilities

- `on` is a list of trigger literals: `{ cron, tz?, rest? }`, `{ webhook, verify: { scheme, secret } }`.
- Business I/O runs in automations: `ctx.request`, `ctx.send`, `ctx.web.read`, `ctx.files.*`, `ctx.geo.*`, `ctx.convert.*`, `ctx.ai.*`. Integration bodies call `ctx.request(op)` on their own instance.
- `ctx.convert.document` and `ctx.convert.ingest` are optional. Recover `Unavailable` only when absence is allowed; other failures propagate unless the workflow recovers them.
- Discover each member's input on `AutomationCtx` and `Ai`.

## AI

- `ctx.ai.sys_1.decide({ state, questions })` asks keyed questions over text-only state and returns typed answers. `ctx.ai.sys_2.infer` is the LLM. Neither falls back to the other.
- `sys_2.infer({ initial, output, … })` holds a complete answer in memory and exposes draft tools `read`, `find`, `edit`, `diff`, `submit`. Paths are JSON Pointers; a keyed list item is addressed by key, never index. Large reads are bounded: read child paths.
- Request `rules` (CEL over top-level properties) make an unfinished draft fail `invalid`.
- `tools: ['read', ...hostTools]` reads records as the run's policies across turns; bound it with `steps`. The draft reader is then `read_answer`.
- Transient provider failures retry inside the invocation, keeping the transcript and edited answer.
- Infer results are proposals. Store them for native form review before a separate confirmed apply; a write still runs through grants, checks and approvals. A person confirms anything changing money or access.
- Use the public `Ai` signature; test with scripted output, never a live model.
