# Supplying dependencies

Citations are `file:line` plus a quoted phrase, because this tree moves. If a line has drifted,
search for the phrase.

## The shape a service already has

Colony services are split into a contract module and a provider module, and the split exists so a
test can take the contract without dragging in the provider.

A contract module (`<name>.ts`) holds three things:

```ts
// norbital/apps/colony/src/lib/facilities/database.ts
export type Interface = Readonly<{                                   // :17
	readonly call: (
		scope: InvocationScope,
		metadata: FacilityCall,
		request: DatabaseRequest
	) => Effect.Effect<FacilityResult<DatabaseResponse>>;
}>;

export const Service = Context.Service<Interface>('@colony/DatabaseFacility');  // :25

export const layerTest = (handler?: QueryHandler) => /* … */;                   // :46
```

The provider module (`<name>.live.ts`) holds only the live `Layer` and re-exports the contract.
`src/lib/app.ts` is the sole composition root: it builds `layerTest` (`:102`) and `layerLive`
(`:152`), and nothing else in the tree may import a `.live.js`. That last rule is enforced by an
architecture test, not by convention — before the split, importing the contract and importing the
provider produced the same edge in the import graph and nothing could tell them apart.

The consequence for you: **your test imports the contract module and provides a layer. It never
imports the live module, and it never patches a module at runtime to get at a dependency.** If you
find yourself reaching for `vi.mock` to replace a service, the service is not injected properly and
that is the bug to fix.

`oss/packages/bolt` uses the same idea with tag-per-facility layers assembled in
`tests/support/bolt-test-layer.ts:445` — `Database.layer`, `AI.layer`, `Communication.layer`,
`Transport.layer` and the rest, merged and provided beneath `Identity`, `AccessControl`,
`Approvals` and `Collections`.

## `layerTest` is an implementation, not a spy

This is the part people get wrong. `DatabaseFacility.layerTest` is not a stub that records calls —
it is a working in-memory implementation of the same contract, including the idempotency the real
one has:

```ts
// norbital/apps/colony/src/lib/facilities/database.ts:46
const cached = (yield* Ref.get(completed)).get(effectKey);
if (cached !== undefined) return cached;
```

That matters because it is what lets a test assert *behaviour* rather than *calls*. When the
dependency behaves, the subject's real logic runs, and the assertion can be about the state that
resulted. When the dependency is a spy, the only thing left to assert is that the spy was touched —
which is how a suite ends up proving nothing but its own wiring.

So: when you need a new test dependency, write the smallest working implementation of the contract,
and put it beside the contract as `layerTest` so the next caller gets it too.

Every contract module offers three layers, and the third one matters as much as the first two:

| Layer               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `layer` / `layer*`  | The real thing. Lives in `.live.ts`, provided only by `app.ts` |
| `layerTest`         | A working in-memory implementation of the same contract     |
| `layerUnavailable`  | A binding that **fails loudly** when anything calls it       |

`layerUnavailable` is how you say "this service must not be reached on this path". Bind it instead
of a fake for every facility the behaviour under test has no business touching:

```
oss/packages/bolt/tests/support/bolt-test-layer.ts:359
	"Facilities the data path does not reach are bound as unavailable rather than faked, so a
	 service that starts calling one fails loudly in a test instead of silently succeeding
	 against a stub."
```

That is the whole doctrine in one sentence. A stub answers; an unavailable binding refuses. If the
subject grows a call to something it should never have called, the fake hides it and the
unavailable binding tells you.

## Do not hand-maintain a second list of the graph

A test helper that enumerates services separately from the layer that provides them will drift, and
the drift is silent because the test still passes:

```
oss/packages/bolt/tests/support/bolt-test-layer.ts:537
	"The hand-written version listed seven fewer services than the layer provides, so every dispatch
	 in a test was checked against a runtime that could not satisfy it."
```

Derive the list from the layer. If you cannot, the helper is a duplicate description of the system
and belongs in the same bin as an over-wide double.

## Building a runtime in a test

Merge the layers you need and hand them to a `ManagedRuntime`:

```ts
// norbital/apps/colony/tests/hosting/operations-authority.test.ts:53
const testRuntime = ManagedRuntime.make(Layer.mergeAll(layerTest(loader), controlStoreLayerTest));
```

Dispose it when the file is done (`afterAll(() => testRuntime.dispose())`). For Bolt, the harness
does this for you: `makeBoltTestRuntime` (`tests/support/bolt-test-layer.ts:362`) returns a
`{ runtime, database, dispose }` (`:519`, type at `:541`) with a real PGlite Postgres already
provisioned from the workspace definition you passed it — including the migration lineage, recorded
as run so a `migrate` in a test does not replay `CREATE TABLE` over existing tables.

Prefer `it.effect` / `it.live` from `@effect/vitest` when the whole test is an Effect and provide
the layer per test — that is the dominant pattern and it keeps each case's dependency set visible at
the case:

```ts
// norbital/apps/colony/tests/facilities/transport.test.ts:191
).pipe(
	Effect.provide(
		TransportFacility.layerTest((_scope, _metadata, request) =>
			Effect.sync(() => { if (request._tag === 'Open') opens += 1; /* … */ })
		)
	)
);
```

Note what that handler is for. `opens` is counted so the test can assert `expect(opens).toBe(1)`
after calling `transport.call` twice with the same metadata — the behaviour being pinned is
*idempotency*, and the counter is the only way to see it. That is a legitimate use of a counting
double: the count **is** the behaviour, not evidence of wiring.

Where several cases share a graph, build it in a local helper and provide it per case, as
`oss/packages/bolt/tests/approvals/approval-lock.test.ts:340` does with `testLayer(recorded)` — one
function that assembles workspace, access control, collections and approvals, and returns a
recording array the cases assert against.

For configuration, inject a `ConfigProvider` rather than setting environment variables:
`oss/packages/bolt-server/tests/facilities.test.ts:44` wraps
`ConfigProvider.layer(ConfigProvider.fromUnknown(values))` in a `withConfiguration` helper.

`ManagedRuntime.make` at module scope is for the one case where the subject is not an Effect and
closes over a runtime at import time — see the module-substitution section below. `it.scoped` is not
used anywhere in this repository. See [runners-and-harnesses.md](runners-and-harnesses.md) for
`it.effect` vs `it.live`.

## When a layer is the wrong tool: the narrow double

Not everything is a service. Authored template code receives an `api` object, and the right double
there is a hand-written object whose surface is exactly the calls the subject makes — and no more:

```
templates/hr-payroll/src/collections/payroll_runs/settlement-lock.test.ts:221
	"A database double whose surface is exactly the calls `clearRunResults` makes.
	 Narrow on purpose. A broader fake would be a second, silently divergent description of the
	 authoring api, and the one thing this has to be right about is which rows a release removes."
```

The reasoning generalises. **A double's cost scales with its surface, and its risk scales with its
surface squared** — every method you add is another place the double can quietly disagree with the
real thing, and a double that disagrees with reality is exactly the fixture problem: a green suite
proving a false premise. Keep it to what the subject calls.

And note what that double is used for. It records into a `deleted` array, and the assertion is on
the recorded *sequence and contents* — locks released before payslips, another run's claims
untouched (`:255`) — not on "delete was called". That is the difference between a double used to
observe behaviour and a mock used to observe wiring.

## Substituting a module: the last resort, and how to bound it

Sometimes the seam genuinely is a module import — a SvelteKit route handler closes over the app
runtime at import time. The authority suite does this, and the way it does it is the pattern to
copy:

```ts
// norbital/apps/colony/tests/hosting/operations-authority.test.ts:32-57
const { runtime } = vi.hoisted(() => ({ runtime: { current: undefined as unknown } }));

// "Only `runtime` is substituted: the handler's live graph would need Postgres, an isolate loader
//  and a gateway, none of which say anything about who may call the endpoint. Everything else —
//  including the `layerTest` this file builds its stand-in from — stays the real module."
vi.mock('$lib/app.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/lib/app.js')>()),
	get runtime() { return runtime.current; }
}));

// "Imported after the mock is registered, so the handler closes over the test runtime."
const { GET, POST } = await import('../../src/routes/api/operations/+server.js');
```

Three properties make this legitimate, and all three are required:

1. **`importOriginal` spread.** Everything not named stays real. A `vi.mock` factory that returns a
   fresh object silently replaces the whole module, and then the test is about the factory.
2. **One named substitution**, with a written justification for why the thing replaced cannot say
   anything about the property under test.
3. **The subject is imported afterwards**, dynamically, so the substitution is actually in effect.

If you cannot write justification (2) in a sentence, do not substitute the module.

## Constructing the input the subject actually reads

Build the minimum the subject consults, and say so. The same suite constructs a SvelteKit event out
of three fields:

```
:143  "The SvelteKit event the gate actually reads: the signed route, the session cookie a browser
       sends, and the `fetch` the credential is resolved through. Nothing else on the event is
       consulted, so constructing more of one would assert about the framework rather than about
       the gate."
```

There is a trap on the other side of this, and it is the reason this suite is in the skill at all.
Every case in an earlier version of this file was throwing `TypeError: Cannot read properties of
undefined` — the event carried no `cookies` and no `fetch`, so the handler died before it reached
the gate, and each case reported the refusal it expected. **A suite that passes because the subject
crashed is passing on nothing**, and it will keep doing so after somebody deletes the gate.

Guard against it the same way you guard any refusal test: include a case that must be *admitted*.

```
:307  it('accepts an administrator, and the profile it wrote is the profile stored', …)
      // "The gate has to still let the two people who administer this workspace through, or the
      //  tests above would pass just as well against a handler that refused everybody."
```

A refusal suite with no admission case is untestable by construction — it is satisfied by a
handler that refuses everything, including one that throws.

## Defaults, and the `undefined` trap

When a helper takes a defaulted parameter, passing `undefined` re-applies the default. If the case
you are writing is "no credential at all", `undefined` gives you a credential.

```
oss/packages/bolt — the plugin invocation helper carried this note verbatim:
	"`null`, not `undefined`: passing `undefined` for a defaulted parameter re-applies the default,
	 so the anonymous case would have silently run with a credential and every refusal below would
	 pass."
```

Use an explicit sentinel (`null`) for "absent", and default only the parameter's *present* values.

## Ambient environment is a dependency too

A test that reads `process.env` passes or fails depending on the machine. The Bolt harness takes the
vault key as an explicit option with `null` meaning "the host configured none", specifically so that
"no ambient environment can accidentally supply" it and a `BOLT_SECRETS_KEY` on a developer's laptop
cannot make a fail-closed test pass for the wrong reason
(`oss/packages/bolt/tests/support/bolt-test-layer.ts:380`). Do the same: inject configuration as a
`ConfigProvider` or an explicit record, never by reading the environment.
