# @norbital-ai/doctor

Deterministic static code-quality analysis for TypeScript, JavaScript, and Svelte repositories,
with a CLI, a programmatic API, and YAML as the rule authoring surface.

The core is agnostic by construction: it ships no opinionated rules and encodes no product's
architecture. A repository that configures nothing gets the neutral baseline — module-graph
reachability, dead exports, duplicate bodies, type-aware deprecation checks, a per-root metrics
table, and the semantic pass. Curated rule sets are named explicitly or not loaded at all.

Rules are ordinary YAML files committed to your repository. A person or an agent adds one, opens
a pull request, and the next audit enforces it. A `rule` half uses ast-grep's pattern shape; a
`pseudocode` half matches semantically against this repository's embedding index; either alone is
a complete rule.

## Install

```bash
pnpm add -D @norbital-ai/doctor
```

## Audit from a terminal

```bash
norbital-doctor audit                # this repository
norbital-doctor audit --include-tests   # include test and e2e sources
norbital-doctor assess --root . --root ../other --out report.json
norbital-doctor delta --root . --against master   # file and code-LOC movement per pillar
```

`delta` answers a question a report cannot: which pillar shrank or grew between a git checkpoint
and what is on disc right now. The checkpoint's tracked tree is materialized through a temporary
index — not `git archive`, whose `export-ignore` attributes would thin the baseline — and both
sides are counted by the same walk, the same comment-excluding LOC classifiers, and the same
pillar assignment the report uses. `--json` adds each pillar's added, removed, and changed file
lists. A delta is inventory, not a gate: it carries no verdict, and only invalid evidence (not a
git work tree, an unknown ref) fails it at exit 2.

Exit codes are the contract, and they are three-valued on purpose:

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | the gate completed with no actionable debt                                 |
| 1    | the analysis is valid and found actionable debt — not a crash              |
| 2    | the evidence is incomplete, stale, or invalid — do not read scores from it |

Everything runs, or the run exits 2: a missing embedding credential, an unreachable provider,
malformed YAML, or a corrupt index is exit-2 evidence with the fix named in the message — never a
quiet all-clear. The one explicit escape is `semantic: { disabled: true }`, because declining
embeddings is a legitimate choice while failing to notice they never ran is not.

Where `@norbital-ai/bolt` is installed, the same audit is available as `bolt audit`.

## Write a rule

```yaml
# .norbital/config/doctor/no-raw-fetch.yaml
id: ACME1
summary: raw fetch bypasses the http client
severity: error
principles: [straightforwardness, testability]
rule:
	pattern: fetch($$$ARGS)
```

```yaml
# .norbital/config/doctor/retries.yaml — the same rule may carry a semantic half instead of, or beside, a structural one
id: RETRY_SEM
summary: hand-rolled retry around async work
severity: hint
pseudocode: |
	an async operation retried with increasing delay up to a limit
threshold: 0.84
```

A misspelled field throws at load time naming the file: "zero findings" must mean "clean", never
"misconfigured". See `docs/matcher.md` for the full rule algebra and `docs/semantic.md` for the
semantic tier.

## Configure

```ts
// .norbital/config/doctor/doctor.config.ts — the complete surface
import { defineConfig } from '@norbital-ai/doctor';

export default defineConfig({
	packs: ['norbital'],       // registered curated packs
	disable: ['SEM_TWIN'],
	semantic: {
		provider: 'openrouter',               // built-in today; or an inline function
		model: 'qwen/qwen3-embedding-8b',
		dimensions: 4096,
		credential: 'NORBITAL_AI_CREDENTIAL' // env-var NAME — values never live in configs
	}
});
```

YAML extensions sit beside that file under `.norbital/config/doctor/*.yaml` and join automatically.

OSS and Colony audit the monorepo as one `--root`. Templates audit each published template so the
same config ships in a tenant workspace.

Credentials are referenced by environment-variable name and resolved from the invoking
environment, so a config file can be shared anywhere without sharing anyone's key. Any
OpenAI-compatible `/v1/embeddings` host works through `endpoint`; anything else fits an inline
`provider` function.

## Tiers

| Pass         | Cost                                        | Runs   |
| ------------ | ------------------------------------------- | ------ |
| `syntactic`  | per file, pure                              | always |
| `graph`      | whole repository, module graph              | always |
| `typeAware`  | a TypeScript program per owning tsconfig    | always |
| `semantic`   | embeddings + clustering (network, metered)  | always unless declined |

The semantic tier refreshes its vector index through a Merkle diff — only changed files embed —
clusters the repository's responsibilities (`SEM_SPREAD`, `SEM_TWIN`), and evaluates every
pseudocode half. Its findings are hints that nominate for review; deterministic evidence decides
gates. Every run prints and records its bill: embedded/reused counts, requests, tokens, cost when
the provider reports it.

## Scope with `.doctorignore`

Some source is deliberately outside a rule set's architecture. `.gitignore` syntax at the
repository root scopes authored rules, YAML patterns, and built-in checks identically. Prefer it
over rows of per-line allowances.

## Programmatic use

```ts
import { audit, assess } from '@norbital-ai/doctor';

const result = await audit({ root: process.cwd(), semantic: { disabled: true } });
console.log(result.counts, result.packs, result.semantic);
```

Findings, the authenticating receipt, the metrics table (`metrics.tsv`), and reports are written
to `.norbital/diagnosis/`.
