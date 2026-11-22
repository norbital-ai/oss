# Runners and harnesses

Kit: `@norbital-ai/bolt-cli/test`; engine types: `@norbital-ai/bolt/engine`.

## Runners & time

- Realm root: `bun run test [paths…]`; inside a template: `bolt test`; UI controls: `oss/packages/ui` happy-dom; Chromium tests: `oss/packages/bolt` browser mode. Never add `.svelte` mounts, browser launchers or custom pools to templates (native-memory suites use `pool: 'forks'`).
- `it.effect` uses `TestClock` (`TestClock.adjust`); `it.live` only for real loopback signals.

## `TestWorkspace.layer({ root })`

- Compiles real source with PGlite, fake facilities, clock and `node:vm` guest runner. `const t = yield* TestWorkspace`: holders `t.admin`, `t.member(policies, { teams?, email? })`, `t.visitor(app)`, `t.sign_in(address)` → `yield* t.as(holder)`.
- Caller methods: `query({ <model>: { where?, fields?, <relation>?, aggregate?, limit? } })`, `history(model, id)`, `act({ '<model>.<verb>': [...] })` (`committed`/`pending_approval`, refusal fails `ActRefused`), `upload('<model>.<field>', { name, mime, bytes })`, `approvals.decide(id, { decision, reason? })`, `run(name, input, decoder)` (`JobResult` for jobs; output schema for calls), `sync_control(model, sync, input)`.
- Helpers: `runAutomation(t, caller.run(name, input, JobResult))` and `settledRun(t, id)` drain due work and assert terminal run state. Controls: `t.clock.set`/`advance`, `t.run_due()`, `t.settled()`, `t.db.rows`, `t.fakes` (`sent`, `files.blobs`, `ai`, `links`), `t.stored_query`, `t.body_acts(holder)`. Decode dynamic results with `Schema.decodeUnknownEffect` (or `Schema.toType(input_schema(...))` for revived decimals/dates; never cast).
- Tests in one file share a workspace sequentially — filter to rows created in each case and advance clock past prior cron slots. `seed/test/` loads automatically once per source hash (`seed: 'none'` or inline overrides).

## Syncs, envoys, AI & migrations

- Runtime accounts: create/seed unpaired `sys_integration`. Inbound: `t.receive(inst, msg)`, `t.event(inst, evt)`. Pairing: `TestWorkspace.layer({ providers: [fake] })` + `t.integrations.pair`/`may`, `t.syncs.test(inst)`.
- Syncs: `t.syncs.read('<m>.sync.<s>', { instance })` (script `t.fakes.links.answer`/`.page`), `t.syncs.write(...)` (commits rows directly through callbacks), `t.syncs.deliver()` (drains outbox → `t.fakes.links.sent`; inspect `$sync['<s>']`). File syncs: `upload('<m>.$import.<s>', file)` + `sync_control` + `t.run_due()`.
- AI/docs: `fakes: { ai: { cassette } }` (assert `t.fakes.ai.remaining()` = 0); supply `Convert` layer via `ports`.
- Migrations: test data steps on both valid and ambiguous rows so `-- check:` fires without writing a receipt; verify idempotency and exact totals. Stored queries: test matching/non-matching rows across >1 page and distinct policy holders.
