# Runners, clocks, and harnesses

## `it.effect` vs `it.live` — the trap that costs the most time

`it.effect` from `@effect/vitest` runs on a **TestClock**. Time does not pass unless the test moves
it. Any `Effect.sleep`, retry schedule, backoff, or timeout inside the code path **never
completes** — the test burns its full vitest timeout and then reports a generic timeout failure that
looks exactly like a slow network or a deadlock. Two full runs (60s and 180s) were once lost to
blaming database latency for this.

The rule:

- **The code path sleeps, retries, backs off, or waits on something real → `it.live`.**
- **The test wants to control time → `it.effect` plus explicit `TestClock.adjust`.**

Both are correct; the failure is using `it.effect` and then waiting for wall-clock time to pass.

Every `it.live` in this repository carries a written justification, and yours should too:

```
norbital/apps/colony/tests/facilities/database-fork.test.ts:100
	// `it.live`, not `it.effect`: the wait for a template to fall quiet sleeps, and `it.effect` runs
	// on a TestClock whose time only moves when a test moves it — the wait would never end.

norbital/apps/colony/tests/hosting/neon-database.test.ts:304
	// `it.live` for the reason the suites above give: `it.effect` runs on a TestClock, and a test that
	// ever waits on one there waits forever.
```

And the browser-capture suite named the reason this is worth a comment at all: under the test clock
the wait "would hang rather than fail, **which is the worst way for a test to be wrong**".

### Using the TestClock deliberately

When elapsed time _is_ the behaviour — a scheduler firing, a lease expiring, an idle isolate being
reclaimed, metered duration — `it.effect` plus `TestClock.adjust` is the right tool and is far
better than sleeping. It is deterministic, it is instant, and it can advance five hours.

```ts
// norbital/apps/colony/tests/hosting/source-workbench.test.ts:121
yield * TestClock.adjust('1 hour');
```

Import it from `effect/testing` (the v4 path), not `effect/TestClock`. Pair it with an injected
interval on the layer under test — Colony's scheduler suites provide `layerTest(loader, {
sweepInterval: '10 hours' })` and then adjust the clock past it — so the test controls both sides of
the timing and nothing depends on how busy the machine is.

`it.scoped` is not used in this repository. Effect is on `4.0.0-rc.*`; several v3 names are gone and
their absence surfaces as `never` somewhere unrelated rather than as an error at the call site, so
check the current API before reaching for a familiar helper.

## Which runner runs your file

| Package                      | Runner                                                              | Config                               |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| `oss/packages/bolt`          | vitest                                                              | `vitest.config.ts`                   |
| `oss/packages/bolt-server`   | vitest, defaults                                                    | none                                 |
| `oss/packages/bolt-protocol` | vitest, defaults                                                    | none                                 |
| `oss/packages/std`           | `node --test tests/*.test.ts`                                       | none                                 |
| `norbital/apps/colony`       | vitest                                                              | `test` block inside `vite.config.js` |
| `templates/*`                | `node --test --experimental-strip-types` over an explicit glob list | the `test` script in `package.json`  |

Note a live documentation drift: `norbital/.agents/context/AGENTS.md:115` documents
`pnpm --filter colony test:unit`, `test:e2e` and `test:e2e:authoring`, and says `pnpm test` runs
Playwright. **None of those scripts exist** — `norbital/apps/colony/package.json:15` has only
`"test": "vitest run"`, and there is no Playwright config in the repository. Read the manifest, not
the prose.

**The template case is the one that bites.** `templates/hr-payroll`'s `test` script names each
directory glob individually. A new `*.test.ts` in a directory that list does not name simply never
runs, and nothing reports that. Read the script before assuming your file is in the suite. Template
tests are also `// @ts-nocheck` at the top, because Node strips types rather than checking them —
so the compiler is not backing you up there, and the test has to be more careful, not less.

## Why the worker caps exist

Both vitest configs pin `maxWorkers: 4`, and both explain why in a comment worth internalising:

```
oss/packages/bolt/vitest.config.ts:22
	"Most of this suite provisions a real PGlite database per test file, and each one is a Postgres —
	 memory and CPU, not a mock. […] nine failures that change identity between runs and say nothing
	 about the code. A suite whose default run is flaky is worse than a slow one, because every real
	 regression then has to be argued with."

norbital/apps/colony/vite.config.js:232
	"A suite whose result depends on how busy the machine was is not green, it is lucky."
```

Do not raise a timeout to fix a flake. A flake is a finding: either the test depends on real time
(see above), or it contends for a real resource, or the code has a race. Raising the timeout hides
all three.

## Gating a test that needs real infrastructure

There is no `@integration` tag and no separate config. Integration tests live in the same tree and
gate themselves on an environment probe, so the default `pnpm test` is green on a laptop with
nothing provisioned:

```ts
// norbital/apps/colony/tests/hosting/neon-database.test.ts:60
describe.skipIf(!configured)('Neon database provider', () => {
	/* … */
});

// norbital/apps/colony/tests/facilities/database-fork.test.ts:78
describe.skipIf(configuredUrl === undefined)('Plain Postgres database provider', () => {
	/* … */
});
```

Two obligations come with `skipIf`:

1. **Give per-test timeouts explicitly** (vitest's third argument) rather than raising the global
   one — a real Neon branch operation gets `240_000`; nothing else should.
2. **Know that a skipped suite is not a passing suite.** A `skipIf` whose probe is subtly wrong
   skips silently forever, and the run stays green. If a gated suite matters, check it actually ran
   at least once in the environment that has the infrastructure.

## The in-memory Postgres harness

`oss/packages/bolt/tests/support/bolt-test-layer.ts` provisions a real PGlite Postgres per test file
from a workspace definition. Use it when the behaviour is genuinely the database's — constraints,
indexes, cascades, the migration lineage, `search`, pagination — because those cannot be observed
against a double.

```ts
harness = await makeBoltTestRuntime(); // :362
await harness.database.query(/* seed */);
const result = await harness.runtime.runPromise(/* … */);
afterEach(async () => {
	await harness?.dispose();
}); // :519
```

Two things it does that a hand-rolled setup would not:

- It runs the schema plan **and records the baseline in the migration ledger**, so the database is
  in the state a provisioned tenant is actually in — a `migrate` in a test does not find the
  baseline pending and replay `CREATE TABLE` over tables that exist.
- It calls `database.forget()` after setup, so the schema statements are not visible as behaviour
  under test. Setup should never be assertable.

Do not reach for this harness for a rule, a calculation, or a policy decision. A PGlite instance
per file is memory and CPU; that is why the worker cap exists, and a suite that provisions one to
check an `if` statement is paying a real cost for nothing.

## Timeouts inside a test

If you write your own wait, make it fail rather than resolve to a sentinel:

```
norbital/apps/colony/tests/e2e/transports.test.ts:11
	"`Effect.timeout` fails rather than resolving to a sentinel, so a test that hangs still fails
	 loudly here instead of waiting out vitest."
```

A test that times out at the vitest level tells you nothing about which step hung. A test that
fails its own bounded wait names the step.

## Verifying a run

Trust exit codes. Console output and task notifications have both reported success here on a gate
that had actually failed — a pipe swallowed the status. Check `$?`, not the last line of output.
