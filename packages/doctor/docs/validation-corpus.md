# Static-quality validation corpus — 2026-08-22

The hardening pass reviewed 1,656 distinct production-file snapshots. Populations were disjoint and
complete within their declared roots at sampling time; tests, dependencies, generated output, build
output, `.yalc`, and Norbital-generated state were excluded. Concurrent consolidation later removed
15 eligible files. The final consolidated assessment independently scanned the complete current
population: 1,641 production files (248 Norbital, 865 OSS, 424 public templates, 104 private
templates).

| Population                                                     | Files | Manifest SHA-256                                                                                          |
| -------------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------- |
| `bolt-protocol`, `bolt-server`, `bolt`, `std` production roots |   220 | `a03404f7d4aea9027b4c813fb2e7a166bdbbb5b20dfd0a2316b7de5276e49df6`                                        |
| `@norbital-ai/ui` production root                              |   658 | complete 160/498 partition; complement `19019e1d2b542faf10441d36109e2fda40fea75d43dd1353571be2984a867c80` |
| application/template authored production roots                 |   778 | `477ab92a589184c9d57e560e76955a68e1ce7e99860fd53ade392d193fa9a1f5`                                        |

Application/template validation was a disjoint 300/478 partition (intersection 0, missing 0,
extra 0). UI validation was a disjoint 160/498 partition (intersection 0, missing 0, extra 0).

Only syntax with a mechanically bounded positive and negative set became an actionable rule.
Rejected as ambiguous: file/function length, mandatory comments, blanket `$effect`, one/two-stage
filter-map chains, nested lookup whose receiver ownership is not invariant, boolean parameters, nullable
returns, nested ternaries, non-null assertions, and module state without a proven top-level binding
plus non-IIFE mutation. Three-stage eager chains and proven hidden module lifetime are bounded rules.
One-use functions are considered only when private and directly called once in the same file.
Unchanged-parameter forwarders are actionable; small mutation-free expressions remain review-only
because a semantic name may still justify them.

Mutation ownership requires one function to contain a direct or locally aliased generated
collection write or `api.*.mutate` plus proven handwritten orchestration: an Effect/Promise wrapper, native
try/catch/finally, a manual live-query refresh, or a lifecycle state transition in both directions.
Generated mutation factories, an existing mutation object's `.mutate(...)`, and direct writes with
no replacement orchestration are negative fixtures. Busy/error names strengthen evidence but are
not the rule boundary. ORM naming requires a named `drizzle-orm/pg-core` column builder used as a
table property with a literal physical name; omitted names, local lookalikes, table/index names, and
dynamic keys are negative fixtures. A remapped property is positive because it creates a second
database vocabulary.

Query ownership signals are grouped by lexical owner, so statement-planning arrays in one function
cannot combine with pending state or query facades elsewhere in the file. Generated query adapters
also require a proven `$derived` query binding plus either an Effect/Promise-wrapped `refresh()` or
an `$effect` that copies `.current`/`.loading`/`.error` into `$state`. Direct rendering, derived
projections, and passing the query object remain negative fixtures; every direct refresh is a QRY2
positive. DDL1 covers schema definition only; raw data maintenance such as `TRUNCATE` is SQL1. Static and
dynamic Vite query imports plus `new URL(..., import.meta.url)` are graph edges. EXP1 requires a
package `exports` map and counts conventional test imports as consumers; open deep-import surfaces
are not complete enough to prove an export dead.

Legacy rules require authored `@deprecated`, compiler diagnostics, explicit removal language, or an
explicit legacy-field fallback. Performance rules require invariant receiver ownership, pure
first-match predicates, or an exact library-algorithm shape. Generic TODOs, import-site deprecation
notices, callback-derived collections, small fixed collections, and effectful predicates are
negative fixtures.

Dominance prevents duplicate diagnoses only when one repair removes the other finding: manual
decoder, dead/unused owner, raw typed-client bypass, async-control, mutation lifecycle,
callback-proxy, and specific layout diagnoses suppress their dependent symptoms. Distinct defects
remain visible. EFF4 emits at most one family finding at a source line. Every accepted family has
adversarial fixtures in `scripts/static-scan.test.mjs`.

AL11 compares named Effect `Schema.Struct` declarations by field names and primitive families, then
requires an exported owner plus a matching domain token from the declaration or path. A local money
wire schema therefore cannot restate an exported money schema with weaker `Number`/`String`
validators. Unrelated equal-shaped schemas, one-field schemas, and schemas that compose an owner's
`.fields` are negative fixtures. Generic shape words such as `range` do not establish shared domain
ownership by themselves.

The 2026-08-22 detector-reliability audit reran the static scanner and entity-overlap pass across
1,658 current eligible production files in Norbital, OSS, public templates, and private templates.
It retired blanket optional-property spread and blanket hand-written internal-data-type diagnoses:
syntax alone cannot prove that exact optional omission or a presentation/service type belongs at an
IO boundary. The narrower Svelte-component rule reports only conditional empty-object spreads used
to avoid passing an `undefined` prop; ordinary object construction remains clean. Targeted schema/IO
ownership rules remain actionable. R5b now requires an explicit
`unknown` parameter, IMP1 requires traversal through at least two parent directories, and R8 treats
`.json()` as IO only when its receiver is a lexically resolved `Response`; command calls require a
literal route-shaped command name rather than an arbitrary method named `command`. Exact duplicate hashes
preserve literals while near-overlap shingles continue to normalize literal kinds. Svelte duplicate
collection now uses the same named function/method/class entity boundary as TypeScript.

Scanner v16 also distinguishes Effect's documented recursive-schema bridge from a duplicate type
owner: an interface is allowed only when it closes its own recursive field through an exact
`Schema.suspend((): Schema.Codec<Self> => SelfSchema)` reference. An ordinary matching interface
beside a Schema remains `AL4`.

Scanner v17 retires blanket broad-destructuring diagnosis. Destructuring a cohesive options or
render context does not reconstruct data and can be clearer than repeated property access. Exact
field-by-field return/reconstruction rules remain actionable; unused bindings belong to the
compiler/linter.

Scanner v18 resolves the nearest package's Node `imports` aliases directly, including wildcard
targets, before falling back to TypeScript resolution. Package-private `#lib/*` imports therefore
participate in dead-file, unused-export, coupling, and test-reach evidence.

Scanner v19 recognizes SvelteKit 3's generated `src/params.ts` registry entry as framework-owned,
alongside the former `src/params/*.ts` matcher files. A `params.ts` outside a package `src` root is
still analyzed through ordinary reachability.

Scanner v20 separates clipping from scrolling. `overflow-hidden`/`overflow-clip` may define a
rounded or media boundary and do not trigger the scroll-shell or primitive scroll-override rules;
only `overflow-auto`/`overflow-scroll` establish a scroll region.

Scanner v21 excludes Svelte's `.svelte-check` cache and treats only proven execution surfaces as
graph roots: package-script file arguments, Wrangler's configured `main`, `bolt.host.ts`, and the
collection compiler's `+representation.svelte`. Arbitrary similarly named files stay unreachable.

Scanner v22 also follows source-file commands in `.github/workflows/*.yml`; CI and release programs
are execution roots even when they are deliberately absent from a package export map.

Scanner v23 makes allowances auditable. Only an exact, known, reasoned
`repository-health:allow <rule>` beside a finding can suppress it; token-prefix collisions, blanket
ignores, former-scanner markers, unknown rule ids, missing reasons, and stale allowances are
positive fixtures. Used exact allowances and unrelated tools' own suppression comments are
negative fixtures. It also completes the v20 clipping boundary: `overflow-hidden` and
`overflow-clip` never establish a scroll region, while `overflow-auto` and `overflow-scroll` do.
The collection compiler's root `src/+env.ts` declaration is a proven entry surface like
`src/+seed.ts`.

Scanner v24 makes reactive query ownership explicit. Every proven generated client read in a Svelte
rune module must be lexically inside `$derived` or `$derived.by`, including static/no-argument
queries. Parameter analysis distinguishes an inline reactive read from a plain object or scalar
that captured `$state`/`$props` before the derived owner ran, follows transitive plain bindings, and
accepts derived parameter bindings, lexically shadowed names, local bindings recomputed inside the
same `$derived.by`, and synchronous factories called inside the owner. A local object that reaches
an outer frozen binding remains a positive fixture. Generated writes, Effect services outside
Svelte, SQL/database-driver queries, and static parameter constants are negative fixtures.

Scanner v25 proves declarative operation ownership rather than accepting a rune anywhere in the
ancestor chain. A query must belong to a module/component rune binding; a `$derived` nested inside a
refresh/helper function remains an imperative positive fixture. Generated mutation wrappers are
also positive fixtures when a proven collection write or `api.*.mutate` is adapted through Effect/Promise,
native try/catch/finally, manual live-query refresh, or a duplicate lifecycle transition. Direct
generated mutation calls and existing mutation-object `.mutate(...)` calls remain negative.

Scanner v26 separates a mechanically proven component-local async generation token from render
state. A plain binding is excluded from V14 only when every value reference is either a prefix
increment or an identity comparison with a captured local. A rendered counter and every other read,
write, arithmetic use, or escape remain positive fixtures.

Scanner v27 keeps exact allowances for type-aware rules valid during the default fast tier. A
`LEGACY2` allowance cannot be proven stale when the TypeScript program did not run; the same
allowance is still required to suppress the resolved deprecated use when `--type-aware` is enabled.

Scanner v28 limits A5 to a direct rethrow of the catch binding. A catch whose sole statement throws
a new contextual error is a negative fixture because it adds information rather than merely
round-tripping the same failure.

Scanner v29 retires R5c's blanket multi-property equality diagnosis. Conjoined property comparisons
are ordinary typed business predicates (discriminants, byte signatures, composite identity and
state transitions), not evidence that unknown input is being reconstructed. Trust-crossing manual
shape recovery remains covered by R5b, R5d and R8.

Scanner v30 retires the syntax-only R3c and P1 findings. A named assertion alone cannot prove that
data crossed trust, and a physical line threshold cannot prove that a module owns more than one
responsibility. Proven unsafe assertion forms remain covered by R3a, R3b, R3e, R3f, R6 and R8;
module size remains explicit in assessment metrics and hotspot tables so responsibility-based
splits can be reviewed with cohesion and complexity evidence rather than a blanket cutoff.

Scanner v31 makes the live-data and SQL boundaries structural. SQL1 permits only transaction control,
the policy compiler's keyed `$sql` predicate input, and narrowly identifiable schema-bootstrap DDL
including model/compiler tagged expressions; `ON CONFLICT` DML, comparison stubs, runtime persistence
directories and replica directories are no longer exemptions. QRY2
forbids manual live-query refresh in every lifecycle, QRY4 forbids exposing that member on a query
contract, LIVE1 detects named/timer/loop polling, and LIVE2 reserves SSE for the sync stream.
Transaction SQL is accepted only when the AST places it under a Transaction request/return or passes
it directly to the branded `transactionSql` imported from Bolt's persistence owner; local lookalikes
are positive fixtures.

The STD1 owner boundary is package-and-module exact: the seven curated helpers are negative fixtures
only in their published source modules inside the package named `@norbital-ai/std`; same-named
consumer implementations and misplaced implementations inside that package remain positive fixtures.
