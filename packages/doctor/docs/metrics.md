# Repository-health metrics

The analyzer emits report schema 9 and analyzer version 10. It sorts roots, files, graph edges,
concepts, services, and findings and emits no timestamp. A repeated scan of the same canonical roots
and bytes is byte-stable apart from an explicitly chosen output path. Scanner receipts are schema 6
with scanner version 32.

## Per-root metrics table

Every audit writes `metrics.tsv` beside the catalogue: one row per function-like, per class, and
per file, with cyclomatic, nesting, cognitive complexity, Halstead volume, Maintainability Index,
CRAP (empty where no coverage map was supplied — absence is not zero), and LCOM for classes.
Column order is positional contract; output is byte-stable across identical trees.

- **Cognitive Complexity** follows SonarSource-style weighting: +1 per branching construct and
  logical-operator sequence, with nesting increments for structures inside control flow. It
  measures human reading cost where cyclomatic measures path count.
- **Maintainability Index** = clamp to [0,100] of `(171 − 5.2·ln HV − 0.23·V(G) − 16.2·ln LOC) ×
  100 / 171`, from AST-derived Halstead volume; empty bodies score 100.
- **CRAP** = `V(G)² (1 − cov)³ + cov` per declaration when an istanbul-format coverage map is
  supplied (`--coverage <path>` or auto-detected `coverage-final.json`); without coverage the
  cell stays empty rather than pretending cov = 0.
- **LCOM (Henderson-Sellers)** per class from `this.`-referenced instance fields; null when a
  class has at most one method or no measurable state.
- **Suppression density** counts `repository-health:allow`, `eslint-disable*`, `@ts-ignore`,
  `@ts-expect-error`, `noqa`, `nosonar` per KLOC in the summary.
- **Assertion density** summarises test sources: assertions per test function, with
  zero-assertion tests named.

The table is additive evidence and feeds no composite weight by itself; changing a composite is a
reviewed decision, not a side effect of adding a measurement.

## Inventory and LOC

The structural inventory includes `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, and
`.svelte`, excluding declaration files and compound `.generated`/`.gen` filenames. It does not walk
directories reserved for dependencies, generated/build output, agents, caches, migrations,
releases, test reports, or vendored code. These exclusions are name-based.

- **Physical LOC** is every physical line except a trailing empty record.
- **Code LOC** is a line with a non-trivia token. JS/TS uses the TypeScript compiler scanner;
  mixed code/comment lines count once as code. Svelte whole-file LOC uses a deterministic lexical
  classifier, while its script AST provides graph/function evidence. Exotic raw-text or nested
  language constructs can require manual review.
- **Comment LOC** contains comment-only lines and never satisfies an executable-code reduction.
- Production, configured tests, and unconfigured test candidates are separate. Total code LOC
  includes all three; testability uses configured tests only.

Distributions report count, mean, population standard deviation, coefficient of variation, Gini,
median, p90, p95, and maximum. Percentiles use nearest-rank selection.

## Ownership and services

A package is the nearest ancestor with `package.json`. Its identity includes selected-root ID,
declared name, and package path, preventing equal root/package names from colliding. Overlapping
roots are rejected. A concept is the first two directories below the first `src/` segment, or the
first directory when there is no `src/`, qualified by package identity. This is a repeatable path
proxy, not proof of a domain boundary.

A **pillar** is the first owned directory below `src`, qualified by package identity; root modules
form `root`. Pillars collect related child concepts without guessing from comments or embeddings.
Each reports LOC, services, functions, cycles, static findings, internal/inbound/outbound edges,
cohesion, complexity density, physical import locality, same-file named calls, and bounded inline
candidates.

Services are compiler-AST declarations using `Effect`, `Context`, or `ServiceMap` `Service`, `Tag`,
or `GenericTag` forms. Exported and package-local declarations count. Aliased or dynamic service
factories may require review.

## Dependency graph and coupling

The graph includes imports, re-exports, literal dynamic imports, literal CommonJS `require`, and
`new URL(literal, import.meta.url)`. Resolution covers relative paths, package imports, nearest
ancestor `tsconfig`/`jsconfig` paths, Svelte `$lib`, and workspace package exports. Vite query/hash
suffixes are removed. Conditional targets are a conservative union, and build/dist exports project
to source when present. This can overstate a runtime-specific cycle. Unresolved internal specifiers
are reported. Type-only edges remain in architecture coupling/cycles; test reach follows value
edges only. Dynamic loaders and framework-generated aliases are outside this graph.

Let `E` be internal production edges, `X` cross-concept edges, `N` production modules, `C` modules
in multi-module or self-loop strongly connected components, `F95` p95 fan-out, and `H` the incoming
edge share held by the highest-fan-in 10% of modules. Coupling is lower-is-better:

```text
100 × (0.40 × X/max(E,1)
     + 0.30 × C/max(N,1)
     + 0.20 × min(1, F95/sqrt(max(N,1)))
     + 0.10 × H)
```

Import colocation classifies every resolved production edge, in order, as same directory,
parent/child directory, same concept, same pillar, same package, cross-package, or cross-root. The
display-only colocation score weights those classes `1, .9, .75, .6, .35, .1, 0` and reports the
weighted percentage. It does not change the health composite. Pillar cohesion is
`2 × internal / (2 × internal + inbound + outbound)`. Raw counts remain authoritative.

Same-file calls are conservative direct identifier calls to a uniquely named top-level function in
the module. They are reported separately from import edges. An inline candidate must be private,
have exactly one same-file direct call, and be either an unchanged-parameter forwarder or a small
single expression. Exported functions, callbacks used as values, recursion, branching,
async/generator/generic boundaries, and mutation are excluded. Candidates are review evidence, not
automatic rewrites. Callback proxies (Q1) and transparent one-use forwarders (Q3) are high
confidence; small expressions are explicitly review-only and feed hint Q4 because a semantic name
may justify them. Full assessments aggregate the authenticated Q1/Q3/Q4 catalogue into pillars so
Svelte markup references and dominance have one source of truth.

## Duplicate and overlapping entities

The compiler scanner removes trivia, normalizes identifiers, preserves literal values for exact
hashes, and hashes only named
functions, assigned functions, methods, constructors/accessors, and classes with at least 40 tokens
while preserving accessed member names. Repeated lines, inline statement blocks, and anonymous
callbacks are not candidates. An exact group needs the same entity-family hash in two production
files and reports every file/entity/kind/line occurrence. An exact duplicated class suppresses its
member duplicates.

Near-overlap detection requires at least 60 tokens and normalizes literal kinds in its structural
shingles. It first indexes callable entities by selected
non-generic call names/counts and control-flow counts. Only entities in one index bucket are
compared. A pair then needs an 85% token-count ratio and at least 88% Jaccard similarity over sorted
five-token structural shingles. Exact-hash pairs are excluded. This is a fast high-precision
copy/variation detector, not semantic equivalence. `--overlap-only` performs just this production
entity pass and emits no health score.

Exact and near relationships form an undirected graph. Each connected component is a functionality
cluster. Labels are deterministic: the three most frequent non-generic operation names, falling
back to normalized entity-name words when no operation profile exists. This is a navigation label,
not a semantic claim. A cluster reports sorted members, concepts, whether it crosses concepts,
operation signatures, exact/near relationship counts, relationship density, average near
similarity, pillar spread, same-pillar relationship share, pass-through share, cyclomatic and
nesting distributions, excess cyclomatic complexity, and total normalized tokens. Cluster identity
is the SHA-256 prefix of its sorted member identities. No embedding, model, or source comment
affects the cluster or label.

Nested functions are measured independently rather than inflating their owner. A pass-through has
only one direct call or returned direct call.

## Tests

Test candidates use conventional test directories and `.test.*`/`.spec.*` names. A candidate is
configured when its nearest package has a `test`/`test:*` script invoking a recognized broad runner
or whose `node --test`/literal command can select it. This is command-shape analysis, not a build-tool
interpreter; custom wrappers can be classified conservatively and are listed separately. Reach
starts from configured tests and follows resolved value imports. It is not coverage or test quality.

## Scanner provenance and principles

Static findings require exactly one canonical `.norbital/diagnosis/receipt.json` per root
using receipt version 6 and static scanner version 32. Health verifies full production scope,
excluded tests, completion,
canonical root/location, exact receipt/count fields, TSV digest and severity/principle aggregates,
and SHA-256 forms.

The input digest is recomputed over eligible source plus every existing `package.json`,
`tsconfig.json`, and `jsconfig.json` on each source ancestor path through the root. Records are
sorted repository-relative paths serialized as `path + NUL + sha256(file bytes) + LF`. The rule-set
digest fingerprints the detector and Effect-catalogue generator source, TypeScript version, and
Effect public-API catalogue. Health format-validates it; the consolidated assessment always creates
the receipt with its internal static-quality section immediately before analysis.

Every finding has scanner-owned buckets in canonical order: `simplicity`, `straightforwardness`,
`modularity`, `testability`, `efficiency`, `type-safety`, `colocation`, `no-bloat`. Reports expose
count and density for each. A multi-principle finding
contributes once per bucket, so bucket counts need not sum to total findings. The current scanner
covers `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, and `.svelte`; other structural production extensions
are listed as uncovered, with static-quality/health withheld and verdict `incomplete`.

## Composite scores and regression

Except coupling, scores are higher-is-better on `[0,100]`:

- **Modularity** = `100 - coupling`.
- **Colocation** = the display-only weighted import-locality percentage above.
- **Testability** = `50 × min(1, configuredTestCodeLOC/(0.5 × productionCodeLOC)) +
50 × value-reachedProductionModules/productionModules`.
- **Simplicity** = `100 × (1 - (0.45 × min(1,p95Cyclomatic/15) +
0.30 × min(1,p95Nesting/8) + 0.25 × passThroughFunctions/functions))`.
- **Static quality** = `100 / (1 + weighted findings per 1,000 scanner-covered production code
LOC)`, with error weight 4, warning 1, hint 0.
- **Health** = `0.30 × modularity + 0.20 × testability + 0.20 × simplicity +
0.30 × static quality`.

Calculations use unrounded components. Display scores round to two decimals; 12-decimal companions
drive baseline deltas. There is no artificial 1,000-LOC denominator floor. No verified complete
scanner coverage means no static-quality or health score. Scanner errors/warnings fail regardless of
score. Baselines require matching report/analyzer versions and exact canonical roots. Regression
checks coupling, component scores, cycles, exact duplicate groups/occurrences, high-confidence
overlap pairs, functionality clusters/occurrences, pillar spread, inline candidates, and scanner
error/warning totals; it cannot prove behavior, performance, security, or semantic equivalence.
