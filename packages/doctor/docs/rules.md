# Static Quality Rule Catalogue

Severity is two-valued: `error` is debt to repair, `hint` is inventory to read. There is no
middle tier — a finding nobody is accountable for accumulates, and a gate that tolerates a growing
pile of them is not a gate.

Confidence describes how strongly the syntax implies a problem, not whether the matched code is
important. `hint` rules are intentionally absent from the default decision brief, and a pack
document's `confidence` field defaults to `high`.

Every row below is a YAML pack rule and the id, summary, and severity are the document's own. The
packs ship with `@norbital-ai/doctor` (`boundaries`, `structure`, `graph`, `stringly`, `overlaps`),
`@norbital-ai/doctor-effect` (`effect`, `ceremony`), and `@norbital-ai/doctor-norbital`
(`platform`, `svelte`, `reactive`, `capability`). `LEGACY2` is the one built-in rule, owned by the
type-aware tier.

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

Sub-rules such as `R3a` and `R3b` are included by their displayed family. The receipt aggregates
each finding once in every bucket it carries; multi-tag findings therefore intentionally contribute
to more than one principle total.

## Type boundaries

| Rule     | Level | Detects                                                          |
| -------- | ----- | ---------------------------------------------------------------- |
| CLONE    | error | JSON stringify/parse clone                                       |
| COERCE1  | error | `Number()` decodes IO instead of a schema                        |
| EFF11    | error | Effect error channel erased to `unknown`                         |
| GUARD1   | error | hand-rolled object duck guard reconstructs a record              |
| GUARD2   | error | runtime `typeof` discriminant instead of a schema decode         |
| PARSE1   | error | `JSON.parse` in a ternary branch skips the decode boundary       |
| R1       | error | `any` in a signature or annotation                               |
| R3a      | error | cast to `Record<string, unknown>`                                |
| R3b      | error | unapproved double cast                                           |
| R3e      | error | single cast to `unknown`                                         |
| R3f      | error | explicit cast to `any`                                           |
| R5d      | hint  | `in`-operator duck typing                                        |
| R6a      | error | `JSON.parse` followed by a cast                                  |
| R6b      | error | `JSON.parse` without visible validation                          |
| REFLECT1 | error | `Reflect.get` reads a coerced object instead of a decoded boundary |
| SCHEMA1  | error | Zod bypasses the required Effect Schema boundary                 |
| STD2     | error | error message is extracted inline instead of `getErrorMessage`   |
| STD3     | error | unknown catch value is normalized to `Error` inline              |

GUARD2 carries the no-runtime-type-checking law: if code must ask `typeof` what a value is, the
type system broke at the boundary that handed the value over, so the repair is a schema decode
(`Schema.is` / a domain schema), not a sharper discriminant. Ambient receivers — `globalThis`,
`process`, `import.meta`, `window`, `document`, `module` — are environment detection, not value
type checking, and stay quiet. GUARD1 dominates GUARD2 where the object-record conjunction matches
both, because one `decodeUnknownOption` repair clears both claims.

## Structure

| Rule     | Level | Detects                                                                                        |
| -------- | ----- | ---------------------------------------------------------------------------------------------- |
| A1       | error | discarded timer requires cleanup review                                                        |
| A5       | hint  | catch only rethrows                                                                            |
| A6       | error | await inside a synchronous loop                                                                |
| AL1      | hint  | bare type alias                                                                                |
| AL2      | hint  | primitive type alias                                                                           |
| AL3      | hint  | loose-record type alias                                                                        |
| AL8      | error | inline message shape redeclares the canonical message type                                     |
| AL9      | error | large inline data parameter has no named schema-derived owner                                  |
| BOOT1    | error | environment file is loaded after configuration is captured                                     |
| COMPLEX1 | error | function control flow nests four or more levels                                                |
| CONV1    | error | the agent's durable model is a conversation, not a task                                        |
| D2       | error | conditional has identical branches                                                             |
| E1       | error | environment-dependent behavior                                                                 |
| EFF10    | error | SvelteKit `error()` throws from the middle of `Effect.gen`                                     |
| EFF8     | error | `Effect.gen` only unwraps a service and maps `json`                                            |
| EFF9     | error | `Effect.promise` drops rejection onto the defect channel                                       |
| ERR1     | error | caught value is stringified into a new `Error`, so its type and stack are destroyed            |
| ERR2     | error | catch arm builds a new `Error` without preserving the caught failure as its `cause`            |
| FETCH1   | error | raw `fetch` bypasses the typed HTTP client                                                     |
| IDENT1   | error | match handler returns its success value unchanged                                              |
| IMP1     | error | deep relative import bypasses a declared alias for the same target                             |
| MOD1     | error | module imports or re-exports itself                                                            |
| NODE1    | error | source reimplements Node built-in environment parsing                                          |
| NODE2    | error | unpruned recursive directory walk reimplements `node:fs`                                       |
| NODE3    | error | command entrypoint reimplements `node:util` `parseArgs`                                        |
| NODE4    | error | glob entrypoint uses substring matching instead of `node:fs` `glob`                            |
| OPS1     | error | operational health or admission state is hard-coded                                            |
| P9       | hint  | export-star barrel                                                                             |
| PERF2    | error | Effect Schema decoder is rebuilt for every element                                             |
| PERF3    | error | three or more eager collection traversals are chained                                          |
| PERF4    | error | `filter` materializes every match only to select the first                                     |
| POLICY1  | error | policy or admission service ignores the identity it is meant to isolate                        |
| Q1       | error | callback-named function forwards every parameter unchanged                                     |
| Q3       | error | private function has one same-file direct call and forwards its parameters unchanged           |
| Q4       | hint  | private function has one same-file direct call and a small mutation-free single expression     |
| Q5       | error | parameter is typed as `undefined` or `void`                                                    |
| RET1     | hint  | implementation return type is written instead of inferred                                      |
| S1       | error | silent catch block                                                                             |
| S3       | hint  | verbose null and undefined check                                                               |
| S5       | hint  | `Array.from(new Set(...))`                                                                     |
| SANDWICH1| error | Effect is run to a Promise and lifted back into Effect                                         |
| STATE2   | error | module `const` collection is mutated from a function                                           |
| STATE3   | error | module `let` binding is mutated from a function                                                |
| SWALLOW1 | error | `Effect.catch` handler discards the failure with an empty body                                  |
| SWALLOW2 | error | `Effect.catch` handler returns an empty value, so corruption is indistinguishable from a legitimate empty result |
| V6       | error | async IIFE in lifecycle code                                                                   |
| VOID1    | error | native Promise is discarded with `void`                                                        |

Q1, Q5, GUARD1, and REFLECT1 are YAML `rule` matchers. Q3/Q4 are YAML rules that match a
forwarder or small expression and require exactly one same-file call of that name. Q1 is the
callback-shaped transparent forwarder, including exported aliases. Q3 is the private one-use
forwarder and dominates Q1 at the same site. Q4 is the private one-use expression that is not a
forwarder. Exported/API functions, callbacks passed as values, recursive functions, branching
bodies, async/generator/generic boundaries, and mutable expressions are excluded from Q3/Q4. Q5
is a singleton `undefined`/`void` parameter type, not a union with `undefined`. The health report
retains Q1/Q3/Q4 per pillar so indirection density can be compared without turning ambiguous style
into a gate.

PERF4 requires a side-effect-free predicate so replacing the materialization with `find` preserves
behavior. These rules do not infer cost from a method name alone.

The error-channel rules are one law at three depths. SWALLOW2 fires only on an *empty* recovered
value — `[]`, `{}`, `null`, `undefined`, `''` — where corruption and a legitimately empty result are
indistinguishable; an honest absent marker (`succeedNone`, `Option.none`) and a real fallback value
stay quiet. ERR1 fires on `new Error(String(cause))` and exempts the `instanceof` ternary that STD3
already diagnoses. ERR2 follows a caught value statically through both arm hosts (`Effect.catch`
calls and `catch:` properties) and stays quiet the moment the arm's Error carries that value as its
`cause`, in property or shorthand form; an arm that omits the binding entirely is always reported.
ERR1 dominates ERR2 where one arm matches both, because one `{ cause }` repair clears both claims.

STATE3 pairs with STATE1 and STATE2 to close the hidden-state family: STATE1 owns module `let` in
Effect-importing modules, STATE2 owns module `const` collections, and STATE3 owns module `let`
mutated from a function elsewhere. Function-local `let`, `??=` memo assignments, and plain reads
stay quiet. The first bound top-level `let` names the binding the mutation must target, the same
single-coupling limitation STATE2 carries.

## Repository graph

| Rule  | Level | Detects                                                        |
| ----- | ----- | -------------------------------------------------------------- |
| D1    | error | duplicate non-trivial function, method, or class body          |
| EXP1  | error | exported declaration has no static consumer                    |
| FILE1 | error | production file is unreachable from a real entrypoint          |

D1 compares only named code entities: functions, assigned functions, methods,
constructors/accessors, and classes. It requires at least four body lines and 24 syntax tokens and
compares changed/path-scoped entities with all production files. Exact duplicated classes own the
diagnosis and suppress their duplicated members. Repeated inline statements and anonymous callback
bodies are not candidates.

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

## Stringly-typed identifiers

| Rule | Level | Detects                                                                |
| ---- | ----- | ---------------------------------------------------------------------- |
| STR1 | error | branches on an open-domain identifier compared to a source literal     |
| STR2 | error | tests an open-domain identifier against a literal allowlist            |
| STR3 | error | dispatches on an open-domain identifier                                |

## Library overlaps

| Rule               | Level | Detects                                                                      |
| ------------------ | ----- | ---------------------------------------------------------------------------- |
| OVERLAP_CACHE      | error | has/get/set memo around a computation reimplements a library cache            |
| OVERLAP_CHUNK      | error | sliding slice loop reimplements a library chunk                              |
| OVERLAP_CLAMP      | error | nested `Math.min`/`Math.max` reimplements a library clamp                    |
| OVERLAP_DEEP_EQUAL | error | `JSON.stringify` comparison reimplements a library deep equal                |
| OVERLAP_GROUP_BY   | error | reduce into keyed buckets reimplements a library `groupBy`                   |
| OVERLAP_PARTITION  | error | a predicate filtered twice reimplements a library partition                  |
| OVERLAP_RATE_LIMIT | error | timestamp compared against now before doing work reimplements a rate limiter |
| OVERLAP_SUM        | error | reduce with addition reimplements a library sum                              |
| OVERLAP_UNIQUE     | error | `Set` round-trip reimplements a library unique                               |

Overlap detectors are ordinary `rule` documents under `packs/overlaps/`; there is no separate
detector form.

## Effect ownership

| Rule    | Level | Detects                                                        |
| ------- | ----- | -------------------------------------------------------------- |
| EFF1    | error | native `try`/`catch` bypasses Effect error control             |
| EFF2    | error | native Promise control bypasses Effect concurrency             |
| EFF3    | error | `async`/`await` appears in an Effect-owned module              |
| EFF5    | error | Effect workflow reads ambient time or randomness               |
| EFF6    | error | `throw` escapes the typed Effect error channel                 |
| EFF7    | error | single-yield `Effect.gen` adds no composition                  |
| EQ1     | error | `JSON` serialization is used as equality                       |
| IO1     | error | runtime code performs blocking synchronous Node IO             |
| LOG1    | error | runtime `console` call bypasses structured logging             |
| NONDET1 | error | ordinary Effect-owned module reads ambient time or randomness  |
| STATE1  | error | module-scoped mutable state hides shared lifetime              |

## Effect ceremony

| Rule      | Level | Detects                                                                 |
| --------- | ----- | ----------------------------------------------------------------------- |
| CEREMONY1 | error | an Effect runtime is started to evaluate a total synchronous expression |
| CEREMONY2 | error | an Effect is run for its side effect and its failure channel discarded  |
| CEREMONY3 | error | a component runs an Effect synchronously during render                  |
| CEREMONY4 | error | a Result is constructed for a value that cannot fail                    |
| CEREMONY5 | error | one collection is filtered twice where a single partition would do      |

## Platform

| Rule    | Level | Detects                                                                          |
| ------- | ----- | -------------------------------------------------------------------------------- |
| COMPAT1 | error | explicit legacy or compatibility forwarding surface                              |
| DDL1    | error | authored table, column, constraint, or index DDL bypasses the model compiler     |
| E2      | hint  | feature flag declared in source                                                  |
| E3      | error | env get-or-throw or re-validation wrapper                                        |
| LEGACY1 | error | authored declaration is explicitly deprecated                                    |
| LEGACY2 | error | compiler-resolved deprecated API is still used (type-aware tier)                 |
| LIVE1   | error | handwritten polling bypasses the live sync engine                                |
| LIVE2   | error | server-sent events are used outside the sync engine                              |
| ORM1    | error | ORM column declares a second physical-name vocabulary                            |
| QRY2    | error | live query is refreshed manually instead of updating through sync                |
| QRY3    | error | query parameters froze reactive input outside `$derived`                         |
| QRY4    | error | public query contract exposes manual refresh                                     |
| ROOT1   | error | legacy tenant substrate root override bypasses the canonical one-root contract   |
| SQL1    | error | raw SQL outside transaction ownership or schema bootstrap DDL                    |
| TRANS1  | error | executable code carries an explicit removal or migration marker                  |
| TRANS2  | error | canonical data falls back to an explicit legacy field                            |
| UI18    | error | client UI sends a raw transport command instead of using the generated API       |

COMPAT1 requires both explicit legacy intent (path or declaration marker) and structural forwarding:
a re-export, alias, or unchanged-parameter call. Ordinary public aliases, adapters that transform
data, and package barrels are valid.

LEGACY1 is authored intent, while LEGACY2 is compiler evidence. LEGACY2 is produced from TypeScript
suggestion diagnostics only at actual uses, not from API-name lists or import declarations. TRANS1
requires a concrete removal/migration phrase attached to executable code; ordinary TODOs do not
match. TRANS2 requires two static fields and an explicit legacy marker in the fallback field name.

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

LIVE1 reports explicit poll owners, timers whose callback asks for status/data, and loops that combine
a wait with a read. Ordinary clocks and data-processing loops are negative fixtures. LIVE2 reserves
`EventSource` and SSE media/protocol declarations for the exact client sync-stream owner,
`packages/bolt/src/client/sync/sse-driver.ts`.

SQL1 recognizes transaction ownership structurally: a literal beneath a `Transaction.statements`
property, a helper that returns only a Transaction request, or a direct call to the branded
`transactionSql` imported from Bolt's persistence owner. A same-named local/lookalike helper is still
raw SQL. Model/compiler tagged expressions and the policy compiler's explicit `policySql` input are the DDL
bootstrap exceptions; ordinary runtime tagged SQL is not.

## Svelte

| Rule | Level | Detects                                                                        |
| ---- | ----- | ------------------------------------------------------------------------------ |
| V1   | error | `$effect` is last-resort external sync; prefer `$derived` or `{@attach}`       |
| V7   | error | async `$effect`                                                                |
| V14  | error | plain `let`/`var` in a rune module should be `$state`                          |
| V15  | error | computed binding in a rune module should be `$derived`                         |
| V18  | error | `$derived` aliases one identifier without deriving a value                     |
| V20  | error | `$effect` delegates to a named function, so its dependencies are invisible     |

V1 requires a pure local-state write whose right side reads local reactive values; browser APIs,
resources, callbacks, and cleanup paths are excluded. V14/V15 only inspect top-level
bindings in `.svelte` instance scripts. Function-local `let`, `{@const}`, factories, `new`, and
`.svelte.ts` module caches are ordinary bindings. A component-local generation token used only by a
prefix increment and identity comparisons with captured locals is imperative concurrency
bookkeeping, not render state; any other read or write remains V14. A `const` literal is left alone.
V15 requires a pure computed expression that reads other locals.

Packages that publish Svelte components and declare Svelte as a peer dependency are reusable
component libraries. The `UI*` consumer-composition rules do not apply inside those primitive
implementations; general syntax, boundary, Effect, and Tailwind runtime-value rules still apply.

### Effects must show what they depend on

`V20`. An `$effect` whose entire body is a call to a named function — `$effect(() => reveal())` or
`$effect(reveal)` — publishes nothing about what re-runs it.

`REACT5`. The same law applies when the effect itself manufactures or suppresses its dependency set:
`untrack` among the effect's statements, a whole-body `untrack`, or a dependency-only read —
`void key;` / a bare `value;` statement — declares a dependency while everything else in the effect
reads invisibly. A reader at the effect can no longer answer "what re-runs this?" without tracing the
suppressed reads. Write the reads at the effect, or move one-way state sync into `watch` from
`runed`. A `void` discard of a binding declared earlier in the same effect block — `const timer = …;
void timer;` — is a discarded handle, not a hidden dependency, and stays quiet.

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

## Layout law

Composition and scroll ownership rules from the authoring skill's layout guides. The layout primitives
are `Stack`, `Inline`, `Cluster`, `Grid`, `Columns`, `Split`, `Cover`, `Bound`, `Scroll`, plus the
`INSET_CLASS`/`INSET_X_CLASS`/`INSET_MX_CLASS` tokens, all from `@norbital-ai/ui/layout`. A raw element
must never hand-roll what a primitive owns: sibling rhythm (gap), scroll regions (Bound+Scroll), the app
inset (tokens), or height contracts (Bound sizes).

| Rule | Level | Detects                                                        |
| ---- | ----- | -------------------------------------------------------------- |
| UI5  | error | raw overflow scroll region bypasses the `Scroll` primitive      |
| UI6  | error | raw flex/grid container bypasses the layout primitives          |
| UI7  | error | sibling margin bypasses the parent gap contract                 |
| UI8  | error | literal app inset classes bypass the inset tokens               |
| UI12 | error | Tailwind arbitrary value built at runtime emits no CSS          |
| UI15 | error | fixed pane height on a primitive instead of `Bound` size        |
| UI17 | error | template exposes uuid/system id to operators                    |
| UI19 | error | raw positioning class bypasses the layout primitives            |
| UI21 | error | viewport or arbitrary height class bypasses `Bound`             |
| UI22 | error | raw `overflow-hidden` bypasses `Bound` clipping                 |
| UI23 | error | inline style carries layout that belongs on a primitive         |
| UI24 | error | stylesheet layout declaration bypasses the layout primitives    |
| UI25 | error | class string composed in the script is unreachable as tokens    |

UI5–UI8, UI19, UI21, and UI22 match static `class` tokens on plain elements; UI6, UI19, UI21 and
UI22 carry `**/packages/ui/src/**` in `ignore` so primitive implementations are exempt. UI7 matches
`space-y-*`/`space-x-*` and `mt-*`/`mb-*`/`ml-*`/`mr-*` from `2` through `19`, so the sanctioned
caption nudge (`mt-0.5`/`mt-1`) and `ml-auto` alignment stay quiet.

UI23 and UI24 carry the same law into a static `style="…"` attribute and stylesheet declarations:
`display: flex|grid` and `position: absolute|fixed|sticky` on a raw element belong on a primitive.
UI25 flags a `class={…}` expression composed in the script, whose tokens a static class scan cannot
see.

UI17 enforces [controller-surfaces.md](../../../../agent-skills/authoring-tenant-workspace/references/controller-surfaces.md)
rule 2 for authored `.svelte` templates (not `packages/ui` internals).

## Reactive ownership

| Rule   | Level | Detects                                                                         |
| ------ | ----- | ------------------------------------------------------------------------------- |
| REACT1 | error | a timer drives query refresh; the client already owns the subscription           |
| REACT2 | error | generated query is refreshed imperatively instead of re-deriving                 |
| REACT3 | error | hand-rolled memo of completed work duplicates the client cache                   |
| REACT4 | error | component branches on the runtime environment instead of a lifecycle boundary    |
| REACT5 | error | an `$effect` hides its dependency set behind `untrack` or a dependency-only read |

## Generated-client capability

| Rule        | Level | Detects                                                              |
| ----------- | ----- | -------------------------------------------------------------------- |
| CAP_MUTATION| error | a scope rebuilds mutation lifecycle the generated client already provides |
| CAP_QUERY   | error | a scope rebuilds query ownership the generated client already provides    |
| HOOK_REACH  | hint  | a collection hook reads, writes or nests as the workspace            |

`CAP_QUERY` and `CAP_MUTATION` own the generated-client capability boundary: a scope that combines
refresh timers, loading/saving state, progress collections, `.current` reads, or try/catch
orchestration around generated client calls is rebuilding a lifecycle the client already provides.
The repair is to render the generated object's own state. `HOOK_REACH` flags a collection hook that
reads, writes, or nests as the workspace.
