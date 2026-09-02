# Legacy rule triage

Every rule in the legacy detector (`SCANNER_VERSION = 30`, 115 rules) with a disposition and a
reason. Nothing may stop being enforced without a row here.

`fires` counts findings across oss + norbital + templates + templates_private, all tiers, tests
included — 5246 findings, 33 of 115 rules firing at least once.

A zero is **not** grounds to write a rule off. A gate earns its keep by preventing a defect, not
by finding one today. Write-offs are justified only where the _syntax itself is extinct_, measured
separately: `$:`, `export let`, `on:` directives, `svelte/store`, async `onMount`, native
`<select>`/`<table>`/`role="tab"`, and `alert`/`confirm` each occur in **0 files** realm-wide.

## Totals

| Disposition | Count | Meaning                                                                           |
| ----------- | ----: | --------------------------------------------------------------------------------- |
| portable    |    87 | one file, no checker — the new runner already has this shape                      |
| cross-file  |    14 | needs whole-repo evidence. **These live in `static-scan.mjs`, not `analyze.mjs`** |
| write-off   |    11 | targets syntax this codebase no longer contains                                   |
| checker     |     1 | needs a `ts.Program` — ported; the type-aware tier now always runs                |
| engine      |     2 | not a rule; a property of the runner                                              |

## What survives the deletion, and where

Verified rather than assumed — both claims in the brief needed correcting.

**The graph tier is independent.** `analyze.mjs` runs with no receipt and produces
`duplicatePathways`, `overlappingPathways`, `functionalityClusters`, `pillars`, `colocation`,
`inlineCandidates`, `cycles` and `hotspots` from its own module graph. Duplication detection,
pillar colocation, and useless-indirection candidates therefore survive intact.

**The cross-file _rules_ do not.** All 14 live in `static-scan.mjs`; `analyze.mjs` emits none of
them. `FILE1` alone fires 288 times. Deleting static-scan without a whole-repo pass in the new
runner silently stops enforcing reachability, dead exports, duplicate bodies, redeclared schemas and
the uuid-exposure family. **This is a fifth work item the brief did not have.**

**Library reimplementation is covered and was two shapes short.** The legacy `EFF4` carried six
families — `Number.clamp`, `Array.chunksOf`, `Array.partition`, `Equivalence`, `Cache`,
`RateLimiter`. `overlaps.ts` covered the first four. `cache` and `rate-limit` are now added, each
with a fixture, so no family stops being enforced. `STD1` is a seven-entry owner registry and ports
as data.

**Write-offs are 11, not ~67.** The brief estimated most of the catalogue descends from the Svelte 4
migration. Measured, only the rules matching genuinely extinct syntax qualify. The `UI5`–`UI18`
layout family and the rune rules `V1`/`V7`/`V14`/`V15`/`V18` target the _current_ design system and
are portable.

## Rules

| Rule       | Sev   | Fires | Disposition    | Reason                                               | Summary                                                                            |
| ---------- | ----- | ----: | -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `A1`       | error |    15 | **portable**   | single file, no checker                              | discarded timer requires cleanup review                                            |
| `A5`       | hint  |     0 | **portable**   | single file, no checker                              | catch only rethrows                                                                |
| `A6`       | error |    35 | **portable**   | single file, no checker                              | await inside a synchronous loop                                                    |
| `AL1`      | hint  |     0 | **portable**   | single file, no checker                              | bare type alias                                                                    |
| `AL11`     | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | local Effect Schema redeclares an exported domain schema instead of importing it   |
| `AL2`      | hint  |     0 | **portable**   | single file, no checker                              | primitive type alias                                                               |
| `AL3`      | hint  |     0 | **portable**   | single file, no checker                              | loose-record type alias                                                            |
| `AL4`      | error |     0 | **portable**   | single file, no checker                              | hand-written type beside a matching Effect Schema                                  |
| `AL5`      | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | redeclared data shape; own one Effect Schema and derive                            |
| `AL6`      | error |     0 | **portable**   | single file, no checker                              | collection row shape redeclared instead of composed                                |
| `AL7`      | error |     0 | **portable**   | single file, no checker                              | durable or wire boundary object has no Effect Schema                               |
| `AL8`      | error |     1 | **portable**   | single file, no checker                              | inline message shape redeclares the canonical message type                         |
| `AL9`      | error |     5 | **portable**   | single file, no checker                              | large inline data parameter has no named schema-derived owner                      |
| `AR1`      | error |     0 | **portable**   | single file, no checker                              | copy-only object helper; use the source row or spread                              |
| `AR2`      | error |     0 | **portable**   | single file, no checker                              | whole-row select aliases columns under new keys                                    |
| `AR5`      | error |     0 | **portable**   | single file, no checker                              | large field-by-field data reconstruction                                           |
| `CLONE`    | error |     1 | **portable**   | single file, no checker                              | JSON stringify/parse clone                                                         |
| `COMPAT1`  | error |     0 | **portable**   | single file, no checker                              | explicit legacy or compatibility forwarding surface                                |
| `COMPLEX1` | error |     8 | **portable**   | single file, no checker                              | function control flow nests four or more levels                                    |
| `D1`       | error |    41 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | duplicate non-trivial function, method, or class body                              |
| `D2`       | error |     0 | **portable**   | single file, no checker                              | conditional has identical branches                                                 |
| `DDL1`     | error |    37 | **portable**   | single file, no checker                              | authored table, column, constraint, or index DDL bypasses the model compiler       |
| `E1`       | error |     0 | **portable**   | single file, no checker                              | environment-dependent behavior                                                     |
| `E2`       | hint  |     0 | **portable**   | single file, no checker                              | feature flag declared in source                                                    |
| `E3`       | error |     0 | **portable**   | single file, no checker                              | env get-or-throw or re-validation wrapper                                          |
| `EFF1`     | error |    70 | **portable**   | single file, no checker                              | native try/catch bypasses Effect error control                                     |
| `EFF2`     | error |   164 | **portable**   | single file, no checker                              | native Promise control bypasses Effect concurrency                                 |
| `EFF3`     | error |  3107 | **portable**   | single file, no checker                              | async/await appears in an Effect-owned module                                      |
| `EFF4`     | error |     0 | **portable**   | single file, no checker                              | local algorithm reimplements an Effect library primitive                           |
| `EFF5`     | error |    13 | **portable**   | single file, no checker                              | Effect workflow reads ambient time or randomness                                   |
| `EFF6`     | error |    11 | **portable**   | single file, no checker                              | throw escapes the typed Effect error channel                                       |
| `EFF7`     | error |   128 | **portable**   | single file, no checker                              | single-yield Effect.gen adds no composition                                        |
| `EQ1`      | error |     0 | **portable**   | single file, no checker                              | JSON serialization is used as equality                                             |
| `EXP1`     | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | exported declaration has no static consumer                                        |
| `FILE1`    | error |   288 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | production file is unreachable from a real entrypoint                              |
| `IMP1`     | error |   666 | **portable**   | single file, no checker                              | deep relative import bypasses a declared alias for the same target                 |
| `IO1`      | error |   109 | **portable**   | single file, no checker                              | runtime code performs blocking synchronous Node IO                                 |
| `LEGACY1`  | error |     0 | **portable**   | single file, no checker                              | authored declaration is explicitly deprecated                                      |
| `LEGACY2`  | error |     4 | **checker**    | ported; the type-aware tier now always runs          | compiler-resolved deprecated API is still used                                     |
| `LOG1`     | error |    13 | **portable**   | single file, no checker                              | runtime console call bypasses structured logging                                   |
| `MUT1`     | error |     0 | **portable**   | single file, no checker                              | generated mutation is wrapped by handwritten orchestration                         |
| `NONDET1`  | error |    68 | **portable**   | single file, no checker                              | ordinary Effect-owned module reads ambient time or randomness                      |
| `ORM1`     | error |     0 | **portable**   | single file, no checker                              | ORM column declares a second physical-name vocabulary                              |
| `P9`       | hint  |     0 | **portable**   | single file, no checker                              | export-star barrel                                                                 |
| `PERF1`    | error |     0 | **portable**   | single file, no checker                              | loop-invariant linear search is nested in another traversal                        |
| `PERF2`    | error |     1 | **portable**   | single file, no checker                              | Effect Schema decoder is rebuilt for every element                                 |
| `PERF3`    | error |     2 | **portable**   | single file, no checker                              | three or more eager collection traversals are chained                              |
| `PERF4`    | error |     1 | **portable**   | single file, no checker                              | filter materializes every match only to select the first                           |
| `Q1`       | error |     0 | **portable**   | single file, no checker                              | pass-through or get-or-throw wrapper function                                      |
| `Q3`       | error |     0 | **portable**   | single file, no checker                              | private one-use function is mechanically inlineable                                |
| `Q4`       | hint  |     0 | **portable**   | single file, no checker                              | private one-use expression may be clearer inline                                   |
| `Q5`       | error |     0 | **portable**   | single file, no checker                              | parameter typed as the undefined or void singleton                                 |
| `GUARD1`   | error |     0 | **portable**   | single file, no checker                              | hand-rolled typeof-object duck guard                                               |
| `REFLECT1` | error |     0 | **portable**   | single file, no checker                              | Reflect.get on Object() coercion                                                   |
| `STATE2`   | error |     0 | **portable**   | single file, no checker                              | module const Map/Set mutated from a function                                       |
| `STD2`     | error |     0 | **portable**   | single file, no checker                              | inline Error.message extraction                                                    |
| `STD3`     | error |     0 | **portable**   | single file, no checker                              | inline unknown-to-Error catch adapter                                              |
| `PARSE1`   | error |     0 | **portable**   | single file, no checker                              | ternary JSON.parse without decode                                                  |
| `VOID1`    | error |     0 | **portable**   | single file, no checker                              | discarded native Promise                                                           |
| `EFF8`     | error |     0 | **portable**   | single file, no checker                              | Effect.gen that only unwraps a service into json                                   |
| `EFF9`     | error |     0 | **portable**   | single file, no checker                              | Effect.promise drops rejection onto the defect channel                             |
| `EFF10`    | error |     0 | **portable**   | single file, no checker                              | SvelteKit error() throws inside Effect                                             |
| `SANDWICH1`| error |     0 | **portable**   | single file, no checker                              | Effect run to a Promise then lifted back into Effect                               |
| `QRY1`     | error |     0 | **portable**   | single file, no checker                              | manual query state/cache ownership bypasses the reactive client                    |
| `QRY2`     | error |     0 | **portable**   | single file, no checker                              | generated client query is driven imperatively                                      |
| `QRY3`     | error |     0 | **portable**   | single file, no checker                              | query parameters froze reactive input outside $derived                             |
| `R1`       | error |     0 | **portable**   | single file, no checker                              | any in a signature or annotation                                                   |
| `R3a`      | error |    13 | **portable**   | single file, no checker                              | cast to Record<string, unknown>                                                    |
| `R3b`      | error |    31 | **portable**   | single file, no checker                              | unapproved double cast                                                             |
| `R3e`      | error |     6 | **portable**   | single file, no checker                              | single cast to unknown                                                             |
| `R3f`      | error |     0 | **portable**   | single file, no checker                              | explicit cast to any                                                               |
| `R5b`      | error |     0 | **portable**   | single file, no checker                              | hand-rolled type predicate repairs data outside a discriminated union              |
| `R5d`      | hint  |     4 | **portable**   | single file, no checker                              | in-operator duck typing                                                            |
| `R6a`      | error |    12 | **portable**   | single file, no checker                              | JSON.parse followed by a cast                                                      |
| `R6b`      | error |    47 | **portable**   | single file, no checker                              | JSON.parse without visible validation                                              |
| `R7`       | error |     0 | **portable**   | single file, no checker                              | database typing collapsed to unknown                                               |
| `R8`       | error |     0 | **portable**   | single file, no checker                              | proven IO/domain value is manually duck-decoded instead of using its Effect Schema |
| `S1`       | error |     0 | **portable**   | single file, no checker                              | silent catch block                                                                 |
| `S3`       | hint  |     2 | **portable**   | single file, no checker                              | verbose null and undefined check                                                   |
| `S5`       | hint  |     0 | **portable**   | single file, no checker                              | Array.from(new Set(...))                                                           |
| `SCAN`     | error |     0 | **engine**     | parse failure; a property of the runner              | source could not be parsed                                                         |
| `SCHEMA1`  | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | Zod bypasses the required Effect Schema boundary                                   |
| `SQL1`     | error |   277 | **portable**   | single file, no checker                              | raw SQL string outside migration/schema/DDL infrastructure                         |
| `STATE1`   | error |    65 | **portable**   | single file, no checker                              | module-scoped mutable state hides shared lifetime                                  |
| `STD1`     | error |     0 | **portable**   | single file, no checker                              | local helper duplicates @norbital-ai/std                                           |
| `SUP1`     | error |     0 | **engine**     | allowance hygiene; belongs to the collector          | invalid, legacy, blanket, unexplained, or stale repository-health allowance        |
| `TRANS1`   | error |     0 | **portable**   | single file, no checker                              | executable code carries an explicit removal or migration marker                    |
| `TRANS2`   | error |     0 | **portable**   | single file, no checker                              | canonical data falls back to an explicit legacy field                              |
| `UI1`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | native select bypasses the shared UI controls                                      |
| `UI10`     | error |     0 | **portable**   | single file, no checker                              | layout/scroll classes on a layout primitive override its props                     |
| `UI11`     | error |     0 | **portable**   | single file, no checker                              | redundant wrapper element adds no layout or boundary                               |
| `UI12`     | error |     0 | **portable**   | single file, no checker                              | Tailwind arbitrary value built at runtime emits no CSS                             |
| `UI13`     | error |     0 | **portable**   | single file, no checker                              | sibling spacing written on the child instead of the parent gap                     |
| `UI14`     | error |     0 | **portable**   | single file, no checker                              | measure centred by hand instead of Center                                          |
| `UI15`     | error |     0 | **portable**   | single file, no checker                              | fixed layout dimension on a primitive instead of Bound size                        |
| `UI16`     | error |     0 | **portable**   | single file, no checker                              | nested scrollports trap wheel events (Scroll/matrix/form)                          |
| `UI17`     | error |     0 | **portable**   | single file, no checker                              | template exposes uuid/system id to operators                                       |
| `UI17a`    | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | collection with uuid columns has no +representation.svelte                         |
| `UI17b`    | error |     0 | **portable**   | single file, no checker                              | custom-type renderer exposes a uuid field to operators                             |
| `UI17c`    | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | recordLabel cannot resolve to a string                                             |
| `UI18`     | error |     0 | **portable**   | single file, no checker                              | client UI sends a raw transport command instead of using the generated API         |
| `UI2`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | hand-rolled tab semantics bypass shared Tabs                                       |
| `UI3`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | repeated native table bypasses a collection renderer                               |
| `UI4`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | browser-native dialog bypasses the application UI                                  |
| `UI5`      | error |     0 | **portable**   | single file, no checker                              | raw overflow scroll region bypasses the Scroll primitive                           |
| `UI6`      | error |     0 | **portable**   | single file, no checker                              | raw flex/grid container bypasses the layout primitives                             |
| `UI7`      | error |     0 | **portable**   | single file, no checker                              | sibling margin bypasses the parent gap contract                                    |
| `UI8`      | error |     0 | **portable**   | single file, no checker                              | literal app inset classes bypass the inset tokens                                  |
| `UI9`      | error |     0 | **portable**   | single file, no checker                              | hand-rolled height/overflow scroll chain bypasses Bound+Scroll                     |
| `V1`       | error |     0 | **portable**   | single file, no checker                              | $effect is last-resort external sync; prefer $derived or {@attach}                 |
| `V10`      | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | watch callbacks form a reactive cycle                                              |
| `V11`      | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | mounted flag mirrors lifecycle state                                               |
| `V12`      | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | onDestroy mutates component state                                                  |
| `V13`      | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | onMount resource has no lifecycle cleanup                                          |
| `V14`      | error |     0 | **portable**   | single file, no checker                              | plain let/var in a rune module should be $state                                    |
| `V15`      | error |     0 | **portable**   | single file, no checker                              | computed binding in a rune module should be $derived                               |
| `V16`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | Svelte 4 $: reactive statement                                                     |
| `V17`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | Svelte 4 export let; use $props()                                                  |
| `V18`      | error |     0 | **portable**   | single file, no checker                              | $derived aliases one identifier without deriving a value                           |
| `V19`      | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | conditional prop spread should pass the optional prop directly                     |
| `V3`       | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | Svelte 4 event directive                                                           |
| `V4`       | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | store imported in .svelte                                                          |
| `V5`       | error |     0 | **write-off**  | Svelte 4 syntax, 0 occurrences realm-wide            | async onMount cannot return cleanup                                                |
| `V6`       | error |     1 | **portable**   | fires; the write-off was wrong                       | async IIFE in lifecycle code                                                       |
| `V7`       | error |     0 | **portable**   | single file, no checker                              | async $effect                                                                      |
| `V8`       | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | component owns too many independent state cells                                    |
| `V9`       | error |     0 | **cross-file** | whole-repo evidence; in static-scan, NOT analyze.mjs | watch writes state read by its own source                                          |

## Corrections found during the port

Five claims in the table above turned out to be wrong, each caught by measurement rather than by
review. They are recorded here rather than silently edited, because the way each was missed is the
useful part.

**`V6` was written off as extinct, and it fires.** Its row said "0 occurrences realm-wide" beside a
`fires` count of 1. The write-off criterion was applied to the family (Svelte 4 lifecycle) instead
of to the rule, and the number sitting in the next column contradicted it. `AL8`, `AL9` and `PERF2`
were dropped from the port entirely and only reappeared when the like-for-like finding delta did not
balance. A rule is ported when a test asserts both halves of its behaviour; nothing weaker counts.

**Four rules were measuring something other than what they claimed.**

| Rule     | Reported | True | Why it was wrong                                                           |
| -------- | -------: | ---: | -------------------------------------------------------------------------- |
| `STATE1` |      224 |    0 | every finding was `let x = $state(...)`, the idiom Svelte _requires_       |
| `FILE1`  |      262 |    0 | the graph resolved only relative specifiers, so `#lib/*` was invisible     |
| `DDL1`   |       25 |    3 | matched the bare name `check`, catching every `Schema.Array(…).check(…)`   |
| `SQL1`   |      183 |    0 | reported bolt's own persistence layer for speaking SQL to its own database |

None of these were visible as failures. Each produced a confident, well-formatted finding at a real
line, and `STATE1` and `FILE1` were the two largest families in the realm — the report looked most
authoritative exactly where it was most wrong.

**Svelte components were parsed one `<script>` at a time.** The extractor took the first block only,
so in any component with `<script module>` above `<script>` the instance script — where the imports,
the state and the effects live — reached no rule at all. 65 components in `oss` alone are shaped that
way. There were two copies of this extraction, and they had drifted: one preserved line numbers and
one did not, so cross-file findings pointed at the wrong lines.

**Reachability knew one framework's conventions.** Entry discovery named SvelteKit's four `+page`
/`+layout` files, so bolt's `+definition`, `+teams`, `+env` and `+pipelines` looked like dead code —
215 files in `templates`. It also opened only a `package.json` sitting directly beside a scanned
file, which is why the doctor's own CLI entry was reported unreachable. Entry conventions are now
read from what a repository declares: its `exports`, `bin`, `imports` map, and the files its
`scripts` invoke.

## Dominance

Rules that report the same defect at the same site are collapsed, so one edit counts once. The
relation is declared on the dominating rule (`dominates: [...]`) rather than in a central table, so
a pack can subsume a rule it did not write. Measured across the realm:

| Dominating | Dominated | Why                                                               |
| ---------- | --------- | ----------------------------------------------------------------- |
| `A6`       | `EFF3`    | sequential `await` in a loop is a concurrency defect, not `await` |
| `EFF2`     | `EFF3`    | `await Promise.all(…)` is about the combinator                    |
| `UI6`      | `UI7`     | moving to a layout primitive removes the sibling margins with it  |

`R3b`/`R3e` looked like a fourth pair — all 27 `R3b` sites also reported `R3e` — but it was not one.
`a as unknown as T` parses as `(a as unknown) as T`, so `R3e` was matching the genuine inner node and
its pattern-level `not` never saw it. Dominance would have hidden that; the rule now states the
exclusion about its parent instead, and reports 3 rather than 30. Prefer fixing the rule: dominance
is for two true findings about one edit, not for one rule being wrong.

`EFF3` + `SQL1` co-occur 149 times and are deliberately _not_ collapsed: `await db.execute('SELECT
…')` is two independent defects that happen to share a line.
