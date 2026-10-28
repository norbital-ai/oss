# Runners, clocks and harnesses

Read the owning package's scripts and test configuration. A filename outside its include pattern
is not a run, and a skipped infrastructure case is not a passing proof.

## Current runners

| Area                         | Entry point                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Everything                   | `bun run test [paths...]` from the realm root: one pool of `cores - 1`, every suite |
| Inside a template            | `bolt test`                                                                         |
| Shared control behavior      | the owning ui package's mounted interaction tests in happy-dom                      |
| Real Chromium platform tests | `oss/packages/bolt` Vitest browser mode, one shared headless browser                |

Do not add a browser launcher or `.svelte` mounts to templates. Happy-dom verifies mounted
interactions, not layout pixels. Visual and task checks are probes in `.tmp/`. Keep each file
cheap (about 2 s of CPU) and the realm about 60 s; the runner prints each suite's wall and CPU. Never
give one suite its own pool or a longer timeout.

## Effect time

`it.effect` from `@effect/vitest` uses TestClock. Advance it explicitly with `TestClock.adjust`
from `effect/testing` when elapsed time is part of the behaviour. Use `it.live` if the actual path
must await native timers or another real host signal. Mixing wall-clock waiting with an unadvanced
TestClock produces a failure unrelated to the claimed rule.

`norbital/apps/colony/tests/billing-gate.test.ts` demonstrates a cache deadline with explicit
TestClock advancement. Check the installed Effect version before copying testing APIs; v3 names
are not interchangeable with the current v4 API.

Use deterministic signals or an injected clock; never sleep and never set a `timeout:` option. Do not
fix races, cold module acquisition or resource contention with time.

## Native and template data paths

Use `TestWorkspace.layer({ root })` from `@norbital-ai/bolt/test` for authored workspace behaviour. It
compiles the real source and supplies the existing engine, fake facilities and clock. Reuse the
owning template's kit rather than reconstructing a second runtime.

For domain helpers that normally receive transform reads, `t.storedRead` supplies the workspace's
native unmasked stored reader. `t.bodyActs(holderOrAuthority)` supplies an automation's
native `many` writer under that authority. Both use the real engine and its codecs; preserve the
helper's declared reader/writer types instead of casting a fake `ctx` or reimplementing queries.
Checked `mode: 'declared'` reads expose `ReadFailed`; ordinary stored reads retain the transform
contract in which engine and decode faults are defects.

```ts
import { Effect } from 'effect';
import { TestWorkspace, expect, layer } from '@norbital-ai/bolt/test';

layer(TestWorkspace.layer({ root }))('authored rules', (it) => {
	it.effect('creates an allowed record', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const answer = yield* t.as(t.admin).act('orders.create', [{ notes: 'Example' }]);
			expect(answer.kind).toBe('committed');
		})
	);
});
```

Native engine tests use the existing PGlite adapter and maintained migration fixtures when
proving grants, constraints, cascades or atomic writes. Reuse current manifests such as
`oss/packages/bolt/tests/write-fixture.ts`. Dispose the database and all provider resources.
Templates maintain numbered SQL, `snapshot.json`, `migrations.lock.json` and `physical.json` under
`migrations/`. Normal `bolt build` independently compares complete SQL replay with the declared
source; host tests apply that verified history and check its physical prefix under the SQL lock.
Keep applied files immutable and add forward migrations for native definition upgrades. Regenerate
host fixtures through their maintained build/capture command rather than editing artifact hashes;
the command runs outside the test, which only reads the committed fixture.

Use the owning template's current authored cases, such as roster import and source-team
values. Tests use synthetic data; private bank content does not belong in committed fixtures
or transcripts.

## Completion

Live dependencies (Postgres, vendor OAuth, SQL Server, live models) are probes, never committed and
never described as proven by a fake. Retest when source changes, a real failure or an unresolved
concern justifies it; do not repeat successful broad runs mechanically.

Trust the process exit code. If output is piped, preserve the command's status; a final console
message alone does not prove the gate passed.
