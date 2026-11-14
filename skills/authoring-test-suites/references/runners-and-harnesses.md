# Runners and harnesses

Read the owning package's scripts and config. A filename outside its include pattern is not a run. Kit contract: `@norbital-ai/bolt-cli/test`; engine types: `@norbital-ai/bolt/engine`.

## Runners

| Area | Entry |
| --- | --- |
| Everything | `bun run test [paths…]` from the realm root, one worker pool |
| Inside a template | `bolt test` |
| Shared controls | the ui package's mounted tests in happy-dom |
| Real Chromium platform tests | `oss/packages/bolt` Vitest browser mode |

Add no browser launcher or `.svelte` mounts to templates. Never give a suite its own pool. Suites that hold native memory
(PGlite, browsers) run with Vitest `pool: 'forks'`: the threads pool keeps native memory in the main process.

## Effect time

- `it.effect` uses TestClock: advance with `TestClock.adjust`. `it.live` only when the path awaits real host signals.
- Use deterministic signals or an injected clock. Add a seam if time cannot be driven. Check installed Effect names: v3 names do not apply.

## The kit

- `TestWorkspace.layer({ root })` compiles real source and supplies the engine, fake facilities, clock and a `node:vm` guest runner; it owns database cleanup.
- One file's tests share one workspace, in order: rows stay from test to test, so filter to the rows a test made. A cron slot that wrote runs once per file: start each test's clock past the last one's.
- A model `effect`, a job automation and a schedule queue a run: `t.run_due()` runs it and answers the failed ones; `t.settled()` only waits. Use `caller.run(name, input, JobResult)` for a job receipt, then inspect that run's completion separately. Import the real `JobResult` schema from `@norbital-ai/bolt-cli/test`.
- A call automation returns its native output immediately, without a run row. `caller.run(name, input, outputSchema)` requires its actual result decoder; the decoder determines the result type and a mismatch fails with `SchemaError`. Pass job options after the decoder. There is no arbitrary result type argument or omitted-decoder fallback.
- `query`, `history` and `act` return schemas derived from the running manifest. `t.stored_query` supplies the native whole-row reader; `yield* t.body_acts(holder)` the native atomic act-map writer. Their dynamic fields are not an unrelated authored type. Decode the page or fields a test uses with `Schema.decodeUnknownEffect`; for already-revived decimal/date values, use the native type schema (`Schema.toType(input_schema(...))`). Preserve native values rather than serializing them through JSON. Never cast a fake `ctx` or fabricate a generic schema predicate.
- Native engine tests use PGlite and maintained migration fixtures. Dispose resources.

## Test seed pack

- `seed/test/` mirrors public seeds: `<model>.json[.gz]`, identity rows as `sys_user.json`, optional assets. No seeder or bank.
- `bolt check` decodes it; the kit loads it by default, built once per source hash, never layering on `base`. `seed: 'none'` or inline rows replace it.
- Keep the few rows mechanisms need. No bank or customer row. Catalogue rows a test needs are synthetic here.

## Syncs and envoys

- Create runtime accounts as `sys_integration` rows or seed unpaired rows. No source connection slot names an account.
- Inbound conversation: `t.receive('<instance id>', message)` ingests and waits for queued work; a message that does not decode fails it.
- Other driver events: `t.event('<instance id>', { kind: 'delivery', provider_id, report })` (also `clear`, `presence`, `outbound_ref`).
- Pairing: `TestWorkspace.layer({ providers: [fake] })`, then `t.integrations.pair(instance, input)` runs the fake provider's `pair` (it writes the credential and `status`); `t.integrations.may(holder, instance)` answers who may manage the instance. `t.syncs.test(instance)` runs the definition's `test` body.
- Remote reads: `t.syncs.read('<model>.sync.<sync>', { instance })`; set `t.fakes.links.answer` or `.page`. `answer(instance, op)` answers `{ status, body }`, `body` the decoded value `ctx.request` yields; `op` is the request as made. Assert rows, cursor and a repeated read.
- Sync pages without the read body: `t.syncs.write('<model>.sync.<sync>', rows, { instance? })` commits rows as `read` answers them (`$id`, `$version`, `$deleted`, fields) exactly as a read page: the model's callbacks judge them, its sync alone may write it. A refused page fails with `ActRefused`.
- Queued writes: `t.syncs.deliver()` drains the outbox; sends appear in `t.fakes.links.sent`. Read the row's `$sync['<sync>']` status.
- File syncs: `(yield* t.as(member)).sync_control('<model>', '<sync>', input)` after `upload('<model>.$import.<sync>', file)`; `t.run_due()` executes. Decode the `sys_run` output; resolve that run's exact file through `sys_file` and `t.fakes.files.blobs`. An automation's `file` input: `upload('<automation>.$input.<input>', file)`, then pass its `FileRef` to `run`. Manual remote refresh uses the same native control with `{}`, a read grant and `capabilities.syncs: ['model.sync_name']`; `ctx.run` and `ctx.schedule` accept only automations.
- Read a run through `t.db.rows`; `Sql` is a plain `{ text, params }` value.
- Templates do not retest envoy admission or transport.

## Inference and documents

- `fakes: { ai: { cassette } }` scripts ordered `AiResponse`s. Inspect `t.fakes.ai.requests` and `remaining()`: an unspent cassette proves inference never ran.
- Supply a complete `Convert` layer through `ports`. Upload through the real caller, drive the automation, and inspect its proposal and unchanged rows. Pair with malformed, unreadable and refusal paths.
- `Effect.catch` recovers typed failures; `try/catch` around `yield*` does not. Never cast a fixture.

## Migrations

- `bolt build` compares replay with source; hosts apply the verified history. Regenerate fixtures with their maintained command, outside tests.
- Empty replay does not prove a data transformation: include a valid and an ambiguous row so a `-- check:` query reports a violation; the refusal must keep rows and write no receipt. Retry the identical SQL. Compare IDs, references and exact totals.

## Stored queries

Include rows that match and do not, and more than a page. Assert exact ordered IDs and termination. Verify policy through the native caller path with distinct holders, every page, and a no-grant refusal.

## Completion

- Live dependencies are probes, never described as proven by a fake.
- Retest when source changes or a real failure justifies it. Preserve the command's status through pipes.
