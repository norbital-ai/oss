# Coverage rules

## The suite is mechanisms only

- A committed test proves one core mechanism against a small synthetic input.
- No `timeout:` option, `setTimeout` wait, `spawn`/`exec` of vitest, tsgo or `bolt`, or build inside a test. The kit hands tests a compiled workspace and a database checkpoint.
- Live models and vendors, real browsers on real sites, timing runs, visual checks and anything needing a key are probes. There is no `test:integration` script, probe tier or skipped-by-default file.
- Do not certify seeded legal or business values. Do not keep checks proving a retired API is absent.
- A simple reversible presentation edit may need only compilation and inspection.

## What is not a test

| Not a test | Instead |
| --- | --- |
| a specific UI regression | fix it |
| copy, class names, headings, badges, markup, screenshots | nothing |
| mounting `.svelte` in a template | ui package tests how the component is used |
| absence of an old feature | nothing; deleted code stays deleted |
| a source grep | a lint rule, or nothing |
| export lists, CLI help verbatim | `publication:check`, or nothing |
| translation coverage at runtime | a type requiring the locale |
| declared config echoed back | nothing; the compiler checks it |
| a benchmark | a probe |
| a scenario walk-through, seed matrix, layout sweep | the mechanisms it crosses, one test each |

## Observable boundary

| Behaviour | Evidence |
| --- | --- |
| Pure calculation, parser, decision, projection | unit test of the real function |
| Service with injected facilities | real service with narrow ports or its layers |
| Grants, constraints, state and approval locks, relations, atomic writes | native engine or `TestWorkspace.layer` on PGlite |
| HTTP, SSE, WebSocket framing, authorization, cancellation | the actual handler or host transport |
| Model syncs, queued writes, envoy turns | `TestWorkspace.layer` and stored rows |
| Inference and document logic | real automation with AI cassettes and an injected `Convert` layer |
| Shared form and view behaviour | mounted generic controls in the ui package |
| Visual layout, end-to-end task | a probe |

- Do not boot the platform to test a parser. Do not double the database when claiming database enforcement.
- A pure test and a write-path test can both be needed: they observe different defects. A helper returning the right value does not prove the write path uses it.

## Authoring contract

- Template tests use the bolt-cli test kit: `TestWorkspace.layer({ root })`, `yield* t.as(actor)` inside `it.effect`. Suites run standalone without Colony.
- Identities use `sys_user.kind`, `active`, boolean `admin`. Teams and policy links are source; never emulate them with runtime assignments.
- Assert a refusal through the failure channel (`Effect.flip` or `Effect.result`).
- Seed mode bypasses callbacks: create executable configuration through guarded writes, including publication.
- For a model reduction, verify the parent value's validation, old-result preservation, references and lock through its write path.

## Assertions

- Assert the returned value, changed row, emitted sequence or closed resource. A call count alone proves wiring, unless the count is the behaviour.
- Pair denial with an admitted case. A handler refusing everyone must fail.
- Include beyond-page data for counts, unread state, child edits and continuation.
- Follow the exact run, record or file identity in a receipt; searching shared fake state can match an earlier operation.
- In shared UI tests assert interaction and outcome, never wrapper counts, classes or markup.
- Keep tests of public decoder boundaries where callers can send malformed data.
- Where useful, reintroduce the defect in an isolated fixture and watch it fail.
- State known limits: a provider double proves the contract, not vendor compatibility; happy-dom does not prove pixels.

## Dependencies and clocks

- Use the seam the subject already has. See [dependency-injection.md](dependency-injection.md).
- `it.effect` uses TestClock: advance it explicitly. `it.live` is for real loopback I/O, never to wait on wall time.
- A test whose result depends on timing is a defect.

## Probes

Uncommitted, in the realm's `.tmp/`. Use a standalone artifact and synthetic data: find a record, perform the task, reload, inspect the result; check desktop, narrow, empty, loading and long content. A reproducible bug is fixed in source; add a test only if a small input can prove the mechanism.

## Review and delete

Delete tests whose behaviour is gone, whose subject is dead code, whose assertions cannot distinguish a defect, or that match a "not a test" row. Merge duplicates. Never delete a failing test to get green. State what evidence is lost when pruning.
