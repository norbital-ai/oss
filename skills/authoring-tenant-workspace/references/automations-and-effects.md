# Automations and effects

Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').automation>[0]`, `AutomationCtx['ai']`, `EffectCtx`.

## Effects & automations

- **Model `effect(changes, ctx)`** inside `create`/`update`/`delete`: runs post-commit as durable `<model>.effect.<verb>` as the writer (no policies; schedule an automation via `ctx.schedule` when different authority is needed; max depth 8). Approval lifecycle (`request`, `resubmit`, final `approve`/`supersede`) calls the verb's effect with empty changes and `ctx.event.kind === 'approval'`. Carried `with`/`on_approved` rows run no effects or write triggers.
- **Automations:** run as reserved system identity with required non-empty `policies` (`actor.*` matches nothing; check `ctx.trigger` explicitly for starter rules; set refs explicitly; 10,000 crossings; never decide approvals). `mode: 'job'` (default, durable) vs `mode: 'call'` (synchronous RPC returning typed output). Manual starts require `capabilities.automations` (30/min per starter → `429`); code uses `ctx.schedule(name, input, { at?, key? })`.
- Record inputs use `{ kind: 'rows', of: '<model>' }` (callers pass IDs; body gets default root fields + `revision` under run's policies; query related rows explicitly and include `revision` for separate update/delete targets).
- Refusals: `return yield* ctx.refuse('<catalogue key>', { row?, field?, values? })` only.
- **Triggers & scale-to-zero:** `on` takes `{ cron, tz?, rest? }` and write listeners `{ model, verbs }` (template or system models like `sys_user`; webhooks belong on integrations). Prefer write triggers and `ctx.wait({ until | model | approval })` over polling crons; declare `rest` (e.g. `rest: '24h'`) on every workspace-data safety-net cron so idle Neon tenants suspend (never put `rest` on wall-time or external-poll crons).
- **Built-in retention (`bolt.prune`):** runs daily ≥03:00 on wake to prune read notices (>30d), finished runs/settled outbox (>90d) and expired sessions/challenges/invitations (configurable in `sys_config` `retention`). Never author system cleanup automations.

## Reruns & Effect body rules

- Dropped/retried runs restart from line 1 (up to 3×; external/AI calls run again): key idempotent acts with `{ key }`, `ctx.schedule` with `key`, notices with `once`. `ctx.send` returns a durable message ID (queue admission ≠ delivery; derive Sent state from `sys_message` status/`sent_at`).
- Bodies are `function*` yielding `ctx` Effects; recover failures with `Effect.catch`/`catchTag` (never `try/catch` around `yield*` or `tryPromise`). Guest helpers use `Effect.fnUntraced`/`fnUntracedEager`; batch reads with `RequestResolver`/`Cache`.
- Code before `ctx.wait(...)` must make deterministic identical calls on resumption.

## Facilities, browser & AI

- File inputs (`<automation>.$input.<name>`) copy to a model field via `ctx.files.put(yield* ctx.files.get(input), { for: 'model.field', name, mime })` (4 MiB limit; larger files upload directly to the model field).
- Record PDFs use `ctx.convert.record(model, id, { to: 'pdf' })` (attach to `ctx.send`/`ctx.notify`). `ctx.convert.*` are optional (recover `Unavailable` only when absence is permitted).
- `ctx.browser` is an isolated run tab (closed on scope exit; use `ctx.web.read` for static text).
- **AI (lower spend, higher accuracy):** `ctx.ai.sys_1.decide({ state, questions })` for cheap, fast independent fixed-set judgements (classification, triage, routing, binary predicates, 1–10 ordinal scoring; 3 s wall, fail-closed, inline PNG/JPEG up to 16 images / 20 MiB — never stored `FileRef`s or recursive/free-form generation); `ctx.ai.sys_2.infer({ initial, output: { json_schema, rules? }, tools?, steps })` for structured drafting, query/AST generation, and multi-step tool use (built-in `refuse({ message })` fails `invalid` cleanly instead of guessing). Design for minimum expenditure and maximum accuracy: do deterministic pre-filtering, parsing and dedupe in code before AI; keep `system` + shared rubric prefixes static for prompt-cache reuse; consolidate related per-entity outputs (e.g. multi-section research, scoring, proposals and drafts) into **one** structured `infer` call instead of chaining cold calls that miss cache and repeat billable `web_search` loops; bound `steps` tightly; stamp completion and share one entity `ctx.schedule` dedupe key so sweeps never re-run completed records unless explicitly forced for one specific entity; store infer results as proposals for human confirmation before changing money/access; test with scripted cassettes.
