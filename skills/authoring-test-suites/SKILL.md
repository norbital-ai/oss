---
name: authoring-test-suites
description: >-
  Choose, write and review meaningful tests for Bolt workspaces and Norbital packages. Use for
  behavioural coverage, native write-path proof, dependency injection, clocks, UI controls,
  transport tests, model syncs, queued writes and envoy turns, and pruning false
  confidence. Routes template, native-engine and Effect-service tests to their existing runners
  and harnesses.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Authoring test suites

A test should fail for a named production defect. Choose the smallest level that can observe the
behaviour, and assert its result. A green test that measures only its own fixture is not coverage.
For a simple reversible presentation edit, compilation and inspection may be enough; do not add
ceremonial tests that mirror the implementation.

Call automated behavior checks **edge case tests**. Cover current core mechanisms with small
synthetic fixtures; do not certify seeded legal/business values or retain checks whose only purpose
is proving a retired API or behavior is absent. Keep meaningful malformed-input, permission,
state, transaction and type-inference boundaries of the current API.

## The suite is mechanisms only

A committed test proves one core mechanism against a small synthetic input, once, in the package that
owns it. Templates do not re-test Bolt (envoy admission, search, approvals); Bolt does not re-test ui.

- **Cheap.** A file costs about 2 s of CPU at most and the realm about 60 s: small inputs, one
  mechanism each. A slow file is cut or rewritten, never given a longer timeout.
- **No timeouts, sleeps, spawns or builds.** No `timeout:` option, no `setTimeout`/sleep waits, no
  `spawn`/`exec` of vitest, tsgo or `bolt`, no build inside a test, no network beyond loopback. The kit
  hands tests a compiled workspace and a database checkpoint.
- **Probes are scratch.** Live models and vendors, real browsers against real sites, timing runs,
  visual checks and anything needing a key are probes: they live in the realm's `.tmp/`, are deleted
  when done and are never committed. There is no `test:integration` script, probe tier or
  skipped-by-default file.

### What is not a test

| Not a test                           | Example                                                                    | Instead                                                            |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| a specific UI regression             | a picker rAF stub, a one-off money input, ticket-numbered screen tests     | nothing; fix it                                                    |
| what the UI looks like               | copy text, class names, headings, badges, `data-look`, screenshots, markup | nothing                                                            |
| UI inside a template                 | mounting `.svelte` components under happy-dom in a template                | the ui package tests how the component is used (props → behaviour) |
| absence of an old feature            | "declared queries are gone", 404 for removed routes, a dropped table       | nothing; deleted code stays deleted                                |
| a source grep                        | no `Buffer`, no `console`, a SQL string not in source, regex over a module | a lint rule, or nothing                                            |
| an exports or help-text snapshot     | export lists, CLI help verbatim                                            | `publication:check` for exports; nothing for copy                  |
| translation coverage at runtime      | every key has `zh`                                                         | a type that requires `zh`                                          |
| declared config echoed back          | `t.manifest.*` / `toMatchObject` against the manifest                      | nothing; the compiler checks it                                    |
| a benchmark                          | CPU-time spins, a type check over many models, 10,001-row seeds            | a probe                                                            |
| a scenario or lifecycle walk-through | seed correctness matrices, layout sweeps, provision → deploy → cutover     | the mechanisms it crosses, one test each                           |

## Choose the observable boundary

| Behaviour                                                              | Evidence                                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure calculation, parser, decision or projection                       | unit test of the real function                                                                                                                                  |
| Service behaviour with injected facilities                             | real service with narrow ports or its existing Effect layers                                                                                                    |
| Grants, constraints, state/approval locks, relations and atomic writes | native engine or `TestWorkspace.layer` against PGlite                                                                                                           |
| HTTP/SSE/WebSocket framing, authorization and cancellation             | the actual handler or real host transport, according to the claim                                                                                               |
| Model syncs, queued writes and envoy turns                             | `TestWorkspace.layer` with `t.receive`, `t.fakes.links` and the stored rows ([worked-examples.md](references/worked-examples.md#integrations-syncs-and-envoys)) |
| Shared form/view behaviour                                             | mounted generic controls in the ui package, actual draft/outcome/capability behaviour                                                                           |
| Visual layout and an end-to-end task                                   | an uncommitted probe in `.tmp/`, never a test                                                                                                                   |

Do not boot the entire platform to test a parser. Do not replace the database with a double when
claiming database enforcement. A pure calculation test and a native write-path test can both be
needed: they observe different defects, not duplicate coverage.

## Drive current authoring contracts

Template behaviour uses `@norbital-ai/bolt/test`: `TestWorkspace.layer({ root })`, `yield* t.as(actor).act(...)` inside `it.effect`,
reads and queued runs through the existing test kit. Use the owning template's kit and synthetic
fixtures. Template suites run standalone without Colony; Colony suites test host behavior without
depending on template suites. One runner shares one worker budget across every suite.
Template tests seed from the template's own `test` pack, `seed/test/` ([worked example](references/worked-examples.md#the-test-seed-pack)):
small synthetic rows written for its mechanisms. `TestWorkspace.layer({ root })` loads it by default when the
directory exists; `seed: 'none'` or inline rows replace it. Tests never load the public `base` pack or the bank's
`sample`, and no bank or customer row is copied into `seed/test/`.
Seed mode restores rows without write callbacks or automations. Create synthetic executable
configuration through guarded create/update, including publication, rather than assuming restored
seed rows passed those guards.

Current member identities use `sys_user.kind`, `active` and boolean `admin`. Team definitions and
policy links are source under `src/access_control/`, with inline source approvals. Runtime member
affiliation follows that compiled contract; do not emulate it with runtime assignment objects.
Use actual identities and compiled source bindings when verifying scope and approval eligibility.

For a write, inspect the committed or pending-approval success and persisted records. Assert a
refusal through the typed failure channel (`Effect.flip` or `Effect.result`); do not inspect a
removed `kind: 'refused'` success value. Include one valid operation and one relevant refusal;
a refusal must leave the forbidden data unchanged. For a model reduction,
verify the parent value's validation, old-result preservation, references and state lock through
its actual model write path. A helper returning the expected value alone does not prove that
write path uses it.

## Dependencies and clocks

Use the dependency seam the subject already has. Pure value functions accept plain inputs;
native I/O services accept their declared services/layers. Do not add a parallel service hierarchy or
mock the whole module to avoid understanding its contract.

A working test dependency returns realistic results and records observable state. Make facilities
outside the intended path fail if reached. Keep ambient environment, clock, IDs and credentials
explicit. When module substitution is unavoidable, replace only the named seam and leave the
remaining module real.

`@effect/vitest`'s `it.effect` uses a TestClock: explicitly advance it for timed behaviour. Use
scoped `it.live` only for real loopback I/O, never to wait on wall-clock time. Load can make a run
slower, never red: a test whose result depends on timing is a defect, not something a timeout fixes.

## Assertions that distinguish behaviour

- Assert the returned value, changed row, emitted sequence or closed resource. A call count alone
  proves wiring unless the count itself is the behaviour, such as retry deduplication.
- Pair denial with an admitted case. A handler that throws or refuses everyone must fail the suite.
- Include beyond-page data for full counts, unread state, child edits and continuation. An unloaded
  child must survive an edit to a visible sibling.
- Use real readable/masked and writable/locked distinctions in shared UI tests (ui package only).
  Assert interaction and outcome, never wrapper counts, CSS classes or markup.
- Keep tests of public schema/decoder boundaries when runtime callers can supply malformed data;
  do not confuse them with redundant tests of a TypeScript type alone.

Where useful, reintroduce the defect in an isolated fixture and watch the assertion fail. State
known limits: a deterministic provider double proves the contract, not live vendor compatibility;
happy-dom does not prove pixels. Those claims belong to probes.

## Probes

A probe is uncommitted scratch in the realm's `.tmp/`, deleted when done. Use an actual standalone
artifact and synthetic data: find a record, perform the task, reload and inspect the persisted
result; check desktop and narrow, empty, loading and long-content states. A reproducible bug a probe
finds is fixed in source; add a test only when the fix is a mechanism a small synthetic input can prove.

## Review and delete

Delete tests whose behaviour is gone, whose only subject is dead code, whose assertions cannot
distinguish a defect, or that match a "What is not a test" row. Merge duplicate coverage. Do not delete a failing test merely to obtain a
green run or weaken it to match a cap. Explain what evidence is lost when pruning.

## Reference routing

| Task                                                         | Reference                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| Ports, layers, narrow doubles, module seams and environment  | [dependency-injection.md](references/dependency-injection.md)   |
| Runners, TestClock, native/template kits and test completion | [runners-and-harnesses.md](references/runners-and-harnesses.md) |
| Finding false confidence                                     | [false-confidence.md](references/false-confidence.md)           |
| Current examples of useful coverage                          | [worked-examples.md](references/worked-examples.md)             |

Read only the relevant reference. Check package scripts and declarations before using a remembered
harness. Trust process exit codes and never claim a passed gate from console text alone.
