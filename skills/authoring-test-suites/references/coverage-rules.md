# Coverage rules

## Mechanisms only

- Committed tests prove core mechanisms with small synthetic inputs (no `timeout`, `setTimeout`, spawned CLI/vitest/tsgo or builds inside tests; no certifying seeded legal/business values; no live vendor/LLM/browser probes — probes stay uncommitted in `.tmp/`).
- **Not tests:** specific UI regressions (just fix), copy/classes/markup/screenshots, mounting `.svelte` in templates (UI package owns generic controls), absence of retired APIs, source greps, verbatim CLI help, runtime translation sweeps, echoed config, benchmarks, or giant seed matrices (test each crossed mechanism once).

## Boundaries & authoring

- Pure logic → unit test; services → injected narrow layers; grants/constraints/locks/relations/syncs/envoys → `TestWorkspace.layer({ root })` on PGlite with `yield* t.as(actor)` inside `it.effect`; HTTP/SSE/WS → actual handler; inference/docs → automation + AI cassettes + injected `Convert` layer.
- Assert refusals via `Effect.flip`/`Effect.result` and pair every denial with an admitted case. Create executable config via guarded writes (seeds bypass callbacks).
- Assert persisted state/returned values/order (not just call counts), include beyond-page data for counts/continuation, follow receipt IDs rather than scanning shared fake state, and advance `TestClock` explicitly (`it.live` only for real loopback I/O, never wall-clock waits).
- Prune tests for deleted behaviour, dead code, or duplicates; never delete a failing test to get green.
