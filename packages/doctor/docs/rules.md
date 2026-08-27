# Static Quality Rule Catalogue

Severity is two-valued: `error` is debt to repair, `hint` is inventory to read. There is no
middle tier — a finding nobody is accountable for accumulates, and a gate that tolerates a growing
pile of them is not a gate.

Confidence describes how strongly the syntax implies a problem, not whether the matched code is
important. `hint` rules are intentionally absent from the default decision brief.

## Principle buckets

Every finding carries one or more deterministic principle tags. TSV and JSON emit them in canonical
order: `simplicity`, `straightforwardness`, `modularity`, `testability`, `efficiency`,
`type-safety`, `colocation`, `no-bloat`.

| Principle           | Major rule families                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| simplicity          | Schema/type ownership, reconstruction, duplication, indirection, Effect reuse, complexity, dead code, Svelte/UI structure                |
| straightforwardness | Boundary decoding, Effect control/failures/time/logging/IO, configuration, reactive ownership, aliases, Svelte/UI behavior, parse errors |
| modularity          | Hidden module state, duplicate/dead owners, raw-client/query ownership, one-off/proxy units                                              |
| testability         | Typed boundaries, Effect control/failures/time/logging/IO, hidden lifetime, lifecycle ownership, scan completeness                       |
| efficiency          | Repeated traversals/decoders, blocking IO, Promise control, Effect primitive reuse, equality work                                        |
| type-safety         | Schema/data ownership, IO decoding, assertions/guards, raw client boundaries, typed Effect failures                                      |
| colocation          | Duplicate/dead owners, one-off/proxy units, canonical library ownership, alias use                                                       |
| no-bloat            | Redundant shapes, reconstruction, duplication, one-off/proxy units, dead code, repeated work, identity reactivity                        |

Sub-rules such as `R3a` and `UI17c` are included by their displayed family. The receipt aggregates
each finding once in every bucket it carries; multi-tag findings therefore intentionally contribute
to more than one principle total.

## Type boundaries

| Rule    | Level | Confidence | Detects                                                                                       | Preferred action                                                                             |
| ------- | ----- | ---------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| R1      | error | high       | `any` in a value signature or annotation                                                      | Use the domain type or boundary `unknown`.                                                   |
| R3a     | error | high       | Cast to `Record<string, unknown>`                                                             | Preserve or validate the actual shape.                                                       |
| R3b     | error | high       | `as unknown as`                                                                               | Remove it or document a true non-data framework boundary.                                    |
| R3e     | error | medium     | Single cast to `unknown`                                                                      | Accept `unknown` at the boundary instead.                                                    |
| R3f     | error | high       | Explicit cast to `any`                                                                        | Replace it with a real type.                                                                 |
| R5b     | error | high       | Predicate manually reconstructs a type from an explicitly `unknown` parameter                 | Decode with Effect Schema; typed collection refinements and discriminated unions are exempt. |
| R5d     | hint  | medium     | Chained `in` guard                                                                            | Prefer one schema validation.                                                                |
| R6a     | error | high       | Cast directly around `JSON.parse`                                                             | Parse through a schema.                                                                      |
| R6b     | error | medium     | `JSON.parse` without an enclosing parse/safeParse                                             | Validate the parsed value.                                                                   |
| R7      | error | high       | Rows or generic result collapsed to `unknown`                                                 | Preserve the adapter generic.                                                                |
| R8      | error | high       | Proven Response/RPC-shaped command output or broad domain JSON value is manually duck-decoded | Decode once with its domain Effect Schema.                                                   |
| SCHEMA1 | error | high       | Runtime Zod import/require or direct package declaration                                      | Remove Zod; use Effect Schema.                                                               |
| CLONE   | error | high       | `JSON.parse(JSON.stringify(...))`                                                             | Use the established clone utility.                                                           |

## Structure

| Rule     | Level | Confidence | Detects                                                                                                         | Preferred action                                                                    |
| -------- | ----- | ---------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| AL1      | hint  | high       | Bare named type alias                                                                                           | Use the original type.                                                              |
| AL2      | hint  | high       | Primitive type alias                                                                                            | Remove it unless it is a real brand.                                                |
| AL3      | hint  | high       | Alias for `Record<string, unknown>`                                                                             | Model the real shape.                                                               |
| AL4      | error | high       | Object/union type whose name matches a same-file Effect Schema                                                  | Derive with `typeof SchemaOwner.Type` or `Schema.Schema.Type`.                      |
| AL5      | error | high       | Exported object (≥3 fields) or string union duplicated                                                          | One Effect Schema owner; derive or re-export it.                                    |
| AL6      | error | high       | Collection-shaped object type restates/re-keys a row                                                            | Compose from the schema-owned row with `Pick`/`Omit`/indexed access.                |
| AL7      | error | high       | Exported durable/wire/receipt object (≥3 fields) has no matching Effect Schema                                  | Define the boundary schema and derive the type.                                     |
| AL8      | error | high       | Function parameter contains an inline `{ role, content/parts }` message shape                                   | Accept the canonical schema-inferred message type or compose from it.               |
| AL9      | error | medium     | Function parameter contains an inline data object with four or more fields                                      | Accept a schema-inferred type or compose the parameter from its owner.              |
| AL11     | error | high       | Local schema repeats an exported domain schema's fields and primitive families                                  | Import and compose the canonical schema owner.                                      |
| AR1      | error | high       | Function only copies source properties into a new object                                                        | Use the row directly or spread it where an actual override is needed.               |
| AR2      | error | high       | Whole-row select aliases columns, usually for a later remap                                                     | Select the table/row shape and keep its canonical keys.                             |
| AR5      | error | high       | Returned object re-lists at least six of six/eight fields from one or two inputs                                | Preserve the typed object/projection, spread it, or fix the upstream schema/client. |
| SQL1     | error | high       | Raw SQL outside transaction requests/control or narrowly identifiable schema-bootstrap DDL                      | Use the typed collection/query builder; keep only transaction/bootstrap SQL.        |
| DDL1     | error | high       | Authored table/index or table-column/constraint definition bypasses the model compiler                          | Declare the model once and let the compiler emit its physical schema.               |
| S1       | error | high       | Empty catch without an ignore rationale                                                                         | Handle or log the failure.                                                          |
| S3       | hint  | high       | Same expression checked against null and undefined                                                              | Use `value != null`.                                                                |
| S5       | hint  | high       | `Array.from(new Set(...))`                                                                                      | Use `[...new Set(...)]`.                                                            |
| D1       | error | high       | Exact non-trivial named function, method, constructor/accessor, or class body duplicated                        | Keep one entity owner and import, call, or extend it.                               |
| COMPAT1  | error | high       | Explicit deprecated/legacy/backward-compat forwarding declaration or re-export surface                          | Migrate consumers and delete the compatibility surface.                             |
| LEGACY1  | error | high       | Authored declaration carries `@deprecated`                                                                      | Remove the legacy owner after migrating its consumers.                              |
| LEGACY2  | error | high       | TypeScript resolves an actual use to a deprecated API                                                           | Use the supported API; import-site diagnostics alone are deduplicated.              |
| TRANS1   | error | high       | Executable code is attached to an explicit remove-after-migration/temporary-until marker                        | Complete the transition and delete the scaffold.                                    |
| TRANS2   | error | high       | Canonical field read falls back to an explicitly `legacy`/`compat`/`deprecated` field                           | Migrate stored data and keep one canonical field.                                   |
| D2       | error | high       | Identical `if`/`else` or ternary branches                                                                       | Remove the meaningless condition or consolidate the shared logic.                   |
| Q1       | error | high       | Callback-named function forwards every parameter unchanged to one callback                                      | Call the callback directly.                                                         |
| Q3       | error | high       | Private function has one same-file direct call and forwards its parameters unchanged                            | Call the forwarded owner directly.                                                  |
| Q4       | hint  | medium     | Private function has one same-file direct call and a small mutation-free single expression                      | Review whether its name earns the indirection; inline when it does not.             |
| QRY1     | error | high       | A generated query is mirrored or adapted by a handwritten query state machine                                   | Render `.current`/`.loading`/`.error`; the sync engine owns freshness.              |
| QRY2     | error | high       | A live query is manually refreshed or refetched                                                                 | Delete the refresh path; mutations and the sync engine update the query.            |
| QRY3     | error | high       | A derived query receives a plain binding that froze a reactive parameter at initialization                      | Derive the parameter binding or construct the parameters inside the query owner.    |
| QRY4     | error | high       | A query interface/class exposes a public `refresh`/`refetch` member                                             | Remove the member; keep sync re-execution private to the engine.                    |
| LIVE1    | error | high       | A named/timer/loop polling mechanism repeatedly waits and reads                                                 | Read the live collection once and let sync update it.                               |
| LIVE2    | error | high       | `EventSource`, `text/event-stream`, or `sse` is used outside the sync stream                                    | Remove the stream or route live collection data through the sync engine.            |
| MUT1     | error | high       | A generated mutation is wrapped by local Effect/Promise, refresh, or lifecycle orchestration                    | Invoke the generated mutation directly and render its owned lifecycle state.        |
| ORM1     | error | high       | A Drizzle column supplies a second physical-name string, whether repeated or remapped                           | Keep one vocabulary: use the canonical property and omit the optional name.         |
| PERF1    | error | high       | Potentially unbounded invariant collection is linearly searched inside another traversal                        | Build one `Map`/`Set` index before traversing.                                      |
| PERF2    | error | high       | Effect Schema predicate/decoder factory rebuilt inside a traversal                                              | Hoist the decoder once outside the callback.                                        |
| PERF3    | error | high       | Three or more consecutive eager `filter`/`map`/`flatMap` traversals                                             | Fuse the work into one pass or a canonical `filterMap`/indexed owner.               |
| PERF4    | error | high       | Pure `filter` materializes all matches only to read index zero/`at(0)`/`shift()`                                | Use `find`; effectful predicates are deliberately excluded.                         |
| EQ1      | error | high       | `JSON.stringify` used on both sides of equality                                                                 | Use domain `Equivalence` or a canonical comparison.                                 |
| STATE1   | error | high       | Top-level mutable binding/collection is mutated from a non-IIFE function                                        | Move lifetime into a factory, scoped service, or instance owner.                    |
| MOD1     | error | high       | Relative static import/export, dynamic import, import-equals, or `require` resolves to its own module           | Import the namespace at the consumer or use the module's named exports directly.    |
| POLICY1  | error | high       | Policy/admission identity parameter has no decision/call use, directly or through a local alias                 | Use the identity in the policy or remove it from the contract.                      |
| OPS1     | error | high       | Operational owner hard-codes `health/status: 'ready'` or `accepting: true, outstanding: 0`                      | Derive readiness and admission from observed dependency or capacity state.          |
| NODE1    | error | high       | Named callable combines line splitting, assignment parsing, and output construction for `.env` text             | Import `parseEnv` from `node:util`.                                                 |
| NODE2    | error | high       | Direct or mutual recursion reaches non-recursive `readdir`/`readdirSync` without a control-flow prune           | Use Node's recursive directory read; retain walkers that actually prevent descent.  |
| NODE3    | error | high       | CLI entrypoint manually searches `process.argv` for a long or short option, including beside `parseArgs`        | Declare the command grammar once with `node:util.parseArgs`.                        |
| NODE4    | error | high       | A glob-labelled entrypoint applies `includes`/`indexOf`/`search` to a pattern, even beside native glob          | Use `node:fs`/`node:fs/promises` `glob` and preserve real glob semantics.           |
| BOOT1    | error | high       | Executed module initialization captures `process.env` before a direct or local-wrapper `loadEnvFile` call fires | Load the environment before capturing configuration.                                |
| COMPLEX1 | error | high       | Function control flow reaches four nested decision/loop levels                                                  | Use guard clauses or move a coherent policy into its owner.                         |
| FILE1    | error | high       | Production source unreachable from package, framework, compiler, script, config, or worker roots                | Delete it or connect it to a real entrypoint.                                       |
| EXP1     | error | high       | A closed package export map proves an exported declaration has no production or test consumer                   | Remove `export`/the declaration or consume it from a real entrypoint.               |
| IMP1     | error | high       | Relative import climbs at least two parent directories and resolves to a declared alias target                  | Use the declared alias for the deep traversal.                                      |
| SUP1     | error | high       | A health allowance is blanket, legacy, unknown, unexplained, or no longer suppresses a finding                  | Remove stale markers or use one exact, reasoned `repository-health:allow <rule>`.   |
| P9       | hint  | high       | Export-star declaration                                                                                         | Export concrete symbols from owners.                                                |

## Pillar targeting for simplification rules

These rules name the intended region and target flow so a finding says which mental model it is
protecting, not merely which syntax matched.

`MOD1` deliberately permits a Svelte component's default self-import because that name is an
executable recursive render edge; namespace and named self-imports still report. `POLICY1` does not
accept `void`, logging (including wrapped values), metrics, or a standalone property read as policy
use; it follows simple local aliases. `OPS1` excludes test
and fixture files; production readiness can remain simple, but the `ready` value must be derived
from an observed condition. `NODE2` recognises an exclusion only when its branch returns, throws,
continues, or guards the recursive call. Merely mentioning “ignore” does not exempt the walker.
`NODE3` and `NODE4` inspect the handwritten path even when the same file also imports the Node
owner. `BOOT1` follows calls to local bootstrap wrappers in module execution order and treats both
`process.env.KEY` and capturing `process.env` itself as configuration reads.

| Rule    | Intended region                                                                | Target flow                                                                 |
| ------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| MOD1    | Service modules and package entrypoints                                        | Consumer import → canonical module owner                                    |
| POLICY1 | Capacity, routing, authorization, permission, quota, and billing-gate services | Tenant/principal identity → policy decision → isolated admission            |
| OPS1    | Health/readiness routes, operations snapshots, tenant matrices, and status UI  | Runtime/dependency observation → truthful operator or orchestrator response |
| NODE1   | Node configuration/bootstrap scripts                                           | `.env` text → Node's standards-complete parser → validated configuration    |
| NODE2   | Node filesystem discovery, compiler asset collection, and sandbox file tools   | Root directory → platform recursive enumeration → domain filtering          |
| NODE3   | Node CLI and repository automation entrypoints                                 | Process arguments → declared option grammar → command                       |
| NODE4   | Sandbox and compiler file-search tools                                         | Confined root + glob pattern → Node glob expansion → matched files          |
| BOOT1   | Node server/bootstrap entrypoints                                              | Environment file load → configuration capture → service startup             |

## Async and configuration

| Rule    | Level | Confidence | Detects                                                                                           | Preferred action                                                                           |
| ------- | ----- | ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A1      | error | medium     | Discarded timer call                                                                              | Verify cleanup and ownership.                                                              |
| A5      | hint  | high       | Catch block whose only statement rethrows                                                         | Remove it or add context.                                                                  |
| A6      | error | medium     | Await in a non-`for await` loop body                                                              | Confirm sequencing is required; batch independent work.                                    |
| E1      | error | high       | Direct DEV/PROD/MODE or NODE_ENV behavior branch                                                  | Centralize environment policy.                                                             |
| E2      | hint  | high       | ENABLE/DISABLE/USE/SKIP flag declaration                                                          | Use canonical configuration.                                                               |
| E3      | error | high       | Get-or-throw or re-check of a schema-owned env var                                                | Read `$env/static/private` or `$env/dynamic/private`. Constraints live in `env.schema.ts`. |
| EFF1    | error | high       | Native `try`/`catch` in production                                                                | Model failure with Effect.                                                                 |
| EFF2    | error | high       | `new Promise`, Promise types/statics/chains                                                       | Use Effect constructors, schedules, races, and traversal.                                  |
| EFF3    | error | high       | Native `async` or `await` in production                                                           | Keep control flow in Effect; adapt only at the mechanically required edge.                 |
| EFF4    | error | high       | Local RateLimiter, Cache, clamp, partition, chunks, or equivalence algorithm duplicates Effect v4 | Use the catalogued Effect primitive.                                                       |
| EFF5    | error | high       | Effect workflow reads ambient time or randomness                                                  | Inject it or use Effect Clock/Random.                                                      |
| EFF6    | error | high       | `throw` inside typed Effect composition                                                           | Fail through the typed Effect error channel.                                               |
| EFF7    | error | high       | `Effect.gen` contains only one direct yield                                                       | Use the yielded Effect directly.                                                           |
| NONDET1 | error | high       | Ordinary function in an Effect-owned runtime module reads ambient time/randomness                 | Inject the value/clock/random source; UI components and parameter defaults are exempt.     |
| LOG1    | error | high       | Runtime global `console` call outside a catch/CLI                                                 | Use Effect logging or an injected structured logger.                                       |
| IO1     | error | high       | Runtime synchronous Node filesystem/process IO                                                    | Use Effect platform FileSystem/Command.                                                    |

EFF4 uses `references/effect-v4-public-api.json`, generated from the pinned Effect package. Names
never prove a finding. RateLimiter needs window/counter/threshold state; Cache binds get, set, and
expiry/in-flight evidence to the same map; clamp requires the exact nested min/max shape; partition
requires complementary filters or two unchanged push buckets; equivalence requires size/key parity
plus a pure same-index/key comparison; chunking requires the exact zero-based size stride and
`slice(index, index + size)` push. Importing the matched primitive exempts the file.

## Canonical reuse

| Rule | Level | Confidence | Detects                                                    | Preferred action                                       |
| ---- | ----- | ---------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| STD1 | error | medium     | Local function shadows a curated `@norbital-ai/std` helper | Import the shared helper or justify the local variant. |

STD1 intentionally covers only stable helpers the package actually publishes: `deepDiff` and
`safeParse` from `@norbital-ai/std/json`; `getErrorMessage` from `@norbital-ai/std/error`; `humanize`
and `textSearchMatches` from `@norbital-ai/std/string`; and `treeFind` and `treeFlatten` from
`@norbital-ai/std/tree`. It does not match imports or similarly named values that are not functions.
Each helper's exact source module inside the package named `@norbital-ai/std` is its canonical owner,
not a shadow; same-named implementations elsewhere in that package or in consumers still match.
Domain-specific date, finance, and Reckon APIs remain public but are deliberately outside this
name-only shadow check.

## Svelte

| Rule | Level | Confidence | Detects                                                                  | Preferred action                                                             |
| ---- | ----- | ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| V1   | error | high       | `$effect` only derives local `$state` through a pure expression          | Replace it with `$derived`; external synchronization and cleanup are exempt. |
| V14  | error | high       | Top-level `let`/`var` in `.svelte` / `.svelte.ts` that is not a rune     | Use `$state(...)`.                                                           |
| V15  | error | high       | Top-level computed binding that is not `$derived`                        | Use `$derived(...)` or `$derived.by(...)`.                                   |
| V16  | error | high       | Svelte 4 `$:` reactive statement                                         | Use `$derived` or `{@attach}`.                                               |
| V17  | error | high       | Svelte 4 `export let`                                                    | Use `$props()`.                                                              |
| V19  | error | high       | Optional component prop is wrapped in an empty-object conditional spread | Pass the possibly-undefined prop directly.                                   |
| V18  | error | high       | `$derived(identifier)` only aliases an existing reactive value           | Read the source directly.                                                    |
| V3   | error | high       | Svelte 4 `on:` directive                                                 | Use the Svelte 5 event property.                                             |
| V4   | error | high       | `svelte/store` import in a component                                     | Use runes.                                                                   |
| V5   | error | high       | Async `onMount` callback                                                 | Start async work inside a synchronous callback.                              |
| V6   | error | high       | Void async IIFE in lifecycle code                                        | Give the operation cancellation and ownership.                               |
| V7   | error | high       | Async `$effect` callback                                                 | Keep the effect synchronous.                                                 |
| V8   | error | medium     | More than eight independently declared `$state` cells                    | Group cohesive state or move a responsibility to its owner.                  |
| V9   | error | high       | `watch`/`watch.pre` callback writes its own reactive source              | Derive the value or make the update direction explicit.                      |
| V10  | error | high       | Two watches write into one another's reactive sources                    | Replace the feedback loop with one owner and one update path.                |
| V11  | error | medium     | False `$state` mounted flag set true by `onMount`                        | Model the browser-only capability or defer the actual operation.             |
| V12  | error | medium     | `onDestroy` callback mutates component `$state`                          | Tear down external resources without publishing dead state.                  |
| V13  | error | high       | Mount acquires a timer/listener/observer with no cleanup path            | Return cleanup from `onMount` or use `onDestroy`.                            |
| SCAN | error | high       | Source parser failure                                                    | Fix syntax or scanner configuration before trusting the report.              |

V8 counts separate top-level component variables and reactive class fields; one cohesive
`$state({ ... })` object is one cell. V9 and V10 follow statically named state/member paths and do
not guess about longer dynamic dependency graphs. V13 accepts either cleanup returned directly by
`onMount` or an explicit `onDestroy` owner in the same component. V1 requires a pure local-state
write whose right side reads local reactive values; browser APIs, resources, callbacks, and cleanup
paths are excluded. V14/V15 only inspect top-level
bindings in `.svelte` instance scripts. Function-local `let`, `{@const}`, factories, `new`, and
`.svelte.ts` module caches are ordinary bindings. A component-local generation token used only by a
prefix increment and identity comparisons with captured locals is imperative concurrency
bookkeeping, not render state; any other read or write remains V14. A `const` literal is left alone. V15 requires a
pure computed expression that reads other locals. V16/V17 are leftover Svelte 4 syntax. A matching `*Schema` plus a hand-written
`type Foo` / `interface Foo` is AL4; two exported types with the same structural fingerprint (three
or more fields, or a string-literal union) are AL5.

Packages that publish Svelte components and declare Svelte as a peer dependency are reusable
component libraries. UI1-UI17 consumer-composition rules do not apply inside those primitive
implementations; general syntax, boundary, Effect, and Tailwind runtime-value rules still apply.

### Effects must show what they depend on

`V20`. An `$effect` whose entire body is a call to a named function — `$effect(() => reveal())` or
`$effect(reveal)` — publishes nothing about what re-runs it.

The reactivity is not the problem. Svelte tracks reads made synchronously inside a called function,
measured against 5.56 rather than assumed: an effect calling `reveal()` re-runs when `reveal` reads
changed state. The problem is that an effect's dependencies are _whatever it read on its last run_,
so a guarded function subscribes to a different set depending on which branch it took:

```js
function reveal() {
	if (state.mode !== 'keyboard') return; // while this fails, the effect depends on `mode` alone
	const target = state.target; // …and on `target` only once it passes
	scrollTo(indexOf(state.items, target)); // …and on `items` only once `target` is set
}
$effect(() => reveal()); // none of which is visible here
```

Write the reads at the effect, or inline the body. A reader should be able to answer "what re-runs
this?" without opening another function and tracing its early returns.

## Shared UI

| Rule | Level | Confidence | Detects                                                     | Preferred action                                                   |
| ---- | ----- | ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| UI1  | error | high       | Native `<select>` outside the shared UI implementation      | Use `Combobox` or the shared `Select` primitives.                  |
| UI2  | error | high       | Manual `tablist`/tab-button semantics                       | Use `Tabs` from `@norbital-ai/ui/tabs`.                            |
| UI3  | error | medium     | Native `<table>` containing a Svelte `{#each}` block        | Use `CollectionTable` or the appropriate specialized renderer.     |
| UI4  | error | high       | `alert`, `confirm`, or `prompt`, including `window.*` forms | Use the application dialog, alert-dialog, sheet, or toast surface. |

UI1–UI3 exempt the public UI package source, where native elements are implementation details. UI2 does
not flag semantic navigation; it requires explicit tab semantics. UI3 does not flag static tables.

## Layout law

Composition and scroll ownership rules from the authoring skill's layout guides. The layout primitives
are `Stack`, `Inline`, `Cluster`, `Grid`, `Columns`, `Split`, `Cover`, `Bound`, `Scroll`, plus the
`INSET_CLASS`/`INSET_X_CLASS`/`INSET_MX_CLASS` tokens, all from `@norbital-ai/ui/layout`. A raw element
must never hand-roll what a primitive owns: sibling rhythm (gap), scroll regions (Bound+Scroll), the app
inset (tokens), or height contracts (Bound sizes).

| Rule | Level | Confidence | Detects                                                                                                                               | Preferred action                                           |
| ---- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| UI5  | error | high       | Raw `overflow-(?:[xy]-)?(?:auto\|scroll)` scroll region on an element                                                                 | Use `Scroll axis=… name=…` (with `Bound` if bounded)       |
| UI6  | error | high       | Raw `flex`/`grid` container arranging siblings (`gap-`, `space-`, …)                                                                  | Use `Stack`/`Inline`/`Cluster`/`Grid`/`Columns`            |
| UI7  | error | medium     | Sibling margin: `space-y-*`/`space-x-*` or `mt-2+`/`mb-*`/`ml-*`/`mr-*`                                                               | Parent owns the gap via a primitive `gap`                  |
| UI8  | error | high       | Literal app inset classes (`px-4 py-2 sm:px-6` etc.)                                                                                  | Use the `inset` prop or the exported INSET tokens          |
| UI9  | error | medium     | Hand-rolled scroll shell: `overflow` + `flex` + `h-full`/`flex-1` chain                                                               | Use an explicit `Bound` + `Scroll` pair                    |
| UI10 | error | high       | Layout classes on a primitive that owns the prop: `items-*`, `justify-*`, `self-*`, `place-*`, `flex-1`, `grow`, `shrink-0`, `h-full` | Compose with `align`/`justify`/`grow`/`fill`/`size`        |
| UI11 | error | medium     | Redundant wrapper element adding no layout or boundary                                                                                | Remove it, or give it a primitive's job                    |
| UI12 | error | high       | Tailwind arbitrary value interpolated at runtime: `` `[prop:${value}]` ``                                                             | Put the value in `style`, or enumerate literal classes     |
| UI13 | error | high       | Sibling spacing written on a child of a gap-owning primitive                                                                          | Parent owns the gap; never `mb-*`/`space-y-*` on kids      |
| UI14 | error | high       | Measure centred by hand (`mx-auto` + `max-w-*`)                                                                                       | Use `Center measure=…`                                     |
| UI15 | error | medium     | Fixed layout dimension on a primitive (`h-[…]`, `h-dvh`, …)                                                                           | Use `Bound size=` or intrinsic height                      |
| UI16 | error | high       | Nested vertical scrollports: `Scroll` wrapping a form/table/tabs/matrix, or `MatrixRenderer` without explicit `bounded`               | One scroll owner per axis; `bounded={false}` in forms      |
| UI17 | error | high       | Template renders a uuid/system id or declares a framework field in table/form composition                                             | Automatic relationship labels; never declare system fields |

Three uuid surfaces never appear as a component node, so UI17 cannot see them: they are UI17a
(collection with no representation), UI17b (custom-type renderer) and UI17c (`recordLabel`), all
errors, detailed below.

UI5–UI9 scan static `class="…"` values on plain elements. Audited exemptions: controls (`button`,
`label`, `a`, `input`, `select`, `textarea`), fixed-size icon chips, table internals, media clipping
(`img`, `video`, `progress`), and text truncation utilities. UI7 deliberately ignores the sanctioned
caption nudge (`mt-0.5`/`mt-1` under a heading) and `ml-auto` alignment; it flags anything at or above
`mt-2`, all `mb-*`, and every `ml-*`/`mr-*`. Static `class={…}` expressions are invisible to the scan —
audit them by hand.

UI16 walks the Svelte component tree. A `Scroll` that nests `CollectionForm`, `CollectionTable`,
`CollectionKanban`, `Tabs` with visible content, another `Scroll`, a `*Form` wrapper, or a bounded
`MatrixRenderer` is a scroll trap. `Tabs showContent={false}` is chrome-only and is not a scroll
owner. Separately, every `MatrixRenderer` call site must set `bounded={false}` (yield to the
parent form/sheet scroll) or `bounded={true}` (deliberate local height) — the default is the trap.

UI5–UI9 also read a static `style="…"` attribute: `display: flex|grid`, `grid-template-*` on a raw
element, and `overflow: auto|scroll` are the same law as the class forms. Layout primitives may
set those styles themselves (Cover rows, Grid tracks).

| Rule  | Level | Confidence | Detects                                                                                                                                                                | Preferred action                                                                             |
| ----- | ----- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| UI17  | error | high       | Template paints a system uuid or declares `<Column>` / `<Field>` for `id`, timestamps, row version, system period, or approval id                                      | Omit framework fields; automatic relationship renderer resolves authored FKs                 |
| UI17a | error | high       | `src/collections/*/+model.ts` declaring a `uuid()`/`file()` column with no sibling `+representation.svelte`                                                            | Author the representation; configure contextual `relationOptions` only when needed           |
| UI17b | error | high       | `src/custom-types/*/+renderer.svelte` binding an Effect Schema UUID field to a raw `<Input>`, interpolating it into display text, or editing the whole variant as JSON | Inline a `Combobox` over the target collection                                               |
| UI17c | error | high       | `recordLabel` naming a `uuid()`/`file()` id, a `custom()`/`json()` object, or a name that is not a column                                                              | Name a column that holds text; never a SQL label column                                      |
| UI18  | error | high       | Client Svelte feature calls raw `transport.command`/`command`                                                                                                          | Reads use typed reactive db/system collections; imperative work uses generated `api.invoke`. |

UI17 enforces [controller-surfaces.md](../../../../oss/skills/authoring-tenant-workspace/references/controller-surfaces.md)
rule 2 for authored `.svelte` templates (not `packages/ui` internals).

UI17a–c cover uuid surfaces that reach an operator without appearing as a standard field control.
Collection create/edit requires an explicit `+representation.svelte`; there is no schema-enumerated
form fallback. A `custom()` column is one JSONB value, so the ids inside it are typed into hand-rolled
controls by the custom-type renderer rather than into a `Field`. And `recordLabel` is a string array in
`+model.ts`: a label whose every term comes back empty falls back to joining every scalar column —
which is how a record-detail title comes to be a row of uuids. All three are errors because each
paints an id the operator cannot act on and none can be found by reading the template.

UI17c flags only terms with no text in them: a `uuid()`/`file()` id, a `custom()`/`json()` object, or
a name that is not a column at all. Type is not a fault — `resolveRecordLabel` in
`@norbital-ai/std/collection` evaluates the compiled label term by term, renders a `Date` as ISO,
stringifies numbers and booleans, and leaves a null term out so the survivors still join. So
`recordLabel: ['work_date', 'state']` is correct as written. Do **not** answer this rule with a
`generatedAlwaysAs` label column: it duplicates that coercion, and the `to_char(...)` such a column
needs is STABLE, so PostgreSQL refuses it with `generation expression is not immutable` and the
template stops migrating. Name a column that holds text.

D1 compares only named code entities: functions, assigned functions, methods,
constructors/accessors, and classes. It requires at least four body lines and 24 syntax tokens and
compares changed/path-scoped entities with all production files. Exact duplicated classes own the
diagnosis and suppress their duplicated members. Repeated inline statements and anonymous callback
bodies are not candidates.

COMPAT1 requires both explicit legacy intent (path or declaration marker) and structural forwarding:
a re-export, alias, or unchanged-parameter call. Ordinary public aliases, adapters that transform
data, and package barrels are valid.

LEGACY1 is authored intent, while LEGACY2 is compiler evidence. LEGACY2 is produced from TypeScript
suggestion diagnostics only at actual uses, not from API-name lists or import declarations. TRANS1
requires a concrete removal/migration phrase attached to executable code; ordinary TODOs do not
match. TRANS2 requires two static fields and an explicit legacy marker in the fallback field name.

PERF1 excludes inline or bound fixed collections of four or fewer items and receivers derived in the
outer callback. PERF4 requires a side-effect-free predicate so replacing the materialization with
`find` preserves behavior. These rules do not infer cost from a method name alone.

Q3/Q4 do not infer uselessness from length alone. Exported/API functions, callbacks passed as values,
recursive functions, branching bodies, async/generator/generic boundaries, and mutable expressions
are excluded. Q3 is the high-confidence transparent case. Q4 keeps small expressions as review-only
inventory because a semantic name can still earn that abstraction. The health report retains both
per pillar so indirection density can be compared without turning ambiguous style into a gate.

QRY1 has two mechanically bounded proofs of a handwritten query owner. The legacy-independent proof
requires one lexical owner to combine storage, loading, and at least two cache/facade lifecycle
signals. The generated-operation proof starts from a query bound by `$derived`: copying its
`.current`/`.loading`/`.error` state into `$state` from `$effect`, or adapting its `refresh()` through
Effect/Promise, fails. Direct rendering, derived projections, and passing the query object onward
remain clean. Manual refresh is independently forbidden by QRY2.

QRY2 reports `refresh`/`refetch` on a query-named receiver or a binding initialized from a generated
collection/facade query. It is lifecycle-independent: a click handler is no more entitled to bypass
sync than an effect or timer. QRY4 closes the API side of the same boundary by rejecting refresh
members on query interfaces and classes, so a package cannot make the forbidden operation available
without a finding even before a caller appears.

QRY3 resolves lexical bindings and follows `$state`, `$props`, and `$derived` dependencies through
plain object/scalar initializers. It reports only a plain binding outside the query owner that
transitively read a reactive value before the query's `$derived` ran. Inline parameters, direct
reactive bindings, `$derived` parameter objects, bindings recomputed inside the same `$derived.by`,
static constants, and synchronous parameter factory functions invoked inside `$derived` are clean.
This is scope-aware initialization semantics, not a name heuristic.

MUT1 follows direct and locally aliased generated collection writes and `api.*.mutate` calls inside
Svelte rune modules. The mutation itself is the lifecycle owner. Wrapping it in
`Effect.tryPromise`/`Effect.runPromise`, native
`try`/`catch`/`finally`, Promise catch/finally chains, manually refreshing a live query, or toggling a
local lifecycle state machine fails as one dominant finding for the enclosing function. A direct
generated call and an existing mutation object's `.mutate(...)` remain clean. Busy/error names are
supporting evidence only; the primary evidence is handwritten orchestration around a proven
generated mutation.

LIVE1 reports explicit poll owners, timers whose callback asks for status/data, and loops that combine
a wait with a read. Ordinary clocks and data-processing loops are negative fixtures. LIVE2 reserves
`EventSource` and SSE media/protocol declarations for the two exact sync-stream owners: the host sync
route and the client replica subscriber.

SQL1 recognizes transaction ownership structurally: a literal beneath a `Transaction.statements`
property, a helper that returns only a Transaction request, or a direct call to the branded
`transactionSql` imported from Bolt's persistence owner. A same-named local/lookalike helper is still
raw SQL. Model/compiler tagged expressions and the policy compiler's keyed `$sql` input are the DDL
bootstrap exceptions; ordinary runtime tagged SQL is not.

SUP1 accepts only an exact known rule on the same line or immediately before the suppressed syntax,
followed by `--` and a concrete domain reason. Rule identifiers are token-matched (`UI1` cannot
suppress `UI10`). Blanket ignores, former-scanner markers, unknown rules, unexplained allowances,
and allowances for which the underlying detector no longer fires are errors. A separate tool's own
suppression vocabulary is outside this rule.
