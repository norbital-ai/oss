# Runners and harnesses

Read the owning package's scripts and config. A filename outside its include pattern is not a run. Kit contract: `@norbital-ai/bolt-cli/test`; engine types: `@norbital-ai/bolt/engine`.

## Runners

| Area | Entry |
| --- | --- |
| Everything | `bun run test [paths…]` from the realm root, one worker pool |
| Inside a template | `bolt test` |
| Shared controls | the ui package's mounted tests in happy-dom |
| Real Chromium platform tests | `oss/packages/bolt` Vitest browser mode |

Add no browser launcher or `.svelte` mounts to templates. Never give a suite its own pool.

## Effect time

- `it.effect` uses TestClock: advance with `TestClock.adjust`. `it.live` only when the path awaits real host signals.
- Use deterministic signals or an injected clock. Add a seam if time cannot be driven. Check installed Effect names: v3 names do not apply.

## The kit

- `TestWorkspace.layer({ root })` compiles real source and supplies the engine, fake facilities, clock and a `node:vm` guest runner; it owns database cleanup.
- `t.storedRead` supplies the native whole-row reader; `t.bodyActs(holder)` the native `many` writer. Keep declared types; never cast a fake `ctx`.
- Native engine tests use PGlite and maintained migration fixtures. Dispose resources.

## Test seed pack

- `seed/test/` mirrors public seeds: `<model>.json[.gz]`, identity rows as `sys_user.json`, optional assets. No seeder or bank.
- `bolt check` decodes it; the kit loads it by default, built once per source hash, never layering on `base`. `seed: 'none'` or inline rows replace it.
- Keep the few rows mechanisms need. No bank or customer row. Catalogue rows a test needs are synthetic here.

## Syncs and envoys

- Named instances are `connections`; seed unnamed ones as `sys_integration` rows or create them.
- Inbound conversation: `t.receive('<slot>', message)` ingests and waits for queued work.
- Remote reads: `t.syncs.read('<model>.sync.<sync>', { instance })`; set `t.fakes.links.answer` or `.page`. `answer(instance, op)` answers `{ status, body }`, `body` the decoded value `ctx.request` yields; `op` is the request as made. Assert rows, cursor and a repeated read.
- Queued writes: `t.syncs.deliver()` drains the outbox; sends appear in `t.fakes.links.sent`. Read the row's `$sync['<sync>']` status.
- File syncs: `t.as(member).start('<model>.sync.<sync>', input)` after `upload('<model>.$import.<sync>', file)`; `t.runDue()` executes. Decode the `sys_run` output; resolve that run's exact file through `sys_file` and `t.fakes.files.blobs`.
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
