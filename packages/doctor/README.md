# @norbital-ai/doctor

Deterministic static code-quality analysis for TypeScript, JavaScript, and Svelte repositories,
with a CLI, a programmatic API, and a type-safe rule authoring surface.

Rules are ordinary TypeScript files committed to your repository. A person or an agent adds one,
opens a pull request, and the next audit enforces it — no build step, because Node strips the types
on import.

## Install

```bash
pnpm add -D @norbital-ai/doctor
```

## Audit from a terminal

```bash
npx norbital-doctor audit                # this repository
npx norbital-doctor audit --include-tests   # include test and e2e sources
npx norbital-doctor assess --root . --root ../other --out report.json
```

Exit codes are the contract, and they are three-valued on purpose:

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | the gate completed with no actionable debt                                 |
| 1    | the analysis is valid and found actionable debt — not a crash              |
| 2    | the evidence is incomplete, stale, or invalid — do not read scores from it |

Collapsing 1 and 2 would let a scan that never produced evidence read as a clean pass, which is the
failure this tool exists to prevent.

Where `@norbital-ai/bolt` is installed, the same audit is available as `bolt audit`.

## No bundler plugin

There is no Vite plugin. Distribution as one would have tied the audit to a bundler that many
projects do not use, and a plugin cannot register a CLI command anyway — Vite's command set is
fixed. A CLI runs the same in a pre-commit hook, a CI job, an editor task, a container, and a
file-watcher of your choosing.

## Write a rule

```ts
// dr/rules/no-raw-fetch.ts
import { defineRule } from '@norbital-ai/doctor';

export default defineRule({
	id: 'ACME1',
	severity: 'error',
	summary: 'raw fetch bypasses the http client',
	principles: ['straightforwardness', 'testability'],
	when: ['CallExpression'],
	files: ['src/**'],
	check(node, context) {
		if (context.calleeName(node) !== 'fetch') return;
		context.report(node, 'callee=fetch prefer=@acme/http#request');
	}
});
```

`when` is a list of TypeScript syntax-kind names, so a typo is a type error rather than a rule that
silently never fires. The engine dispatches by kind: each node is visited once and only the rules
that asked for that kind are consulted.

`context` carries the file, its source, the parsed `SourceFile`, the `ts` namespace, and helpers —
`calleeName`, `text`, `ancestors`, `imports`, `importsFrom`. A rule that throws becomes a finding
against itself rather than taking the audit down.

Rules run in the syntactic tier: one file at a time, no cross-file state, no type checker. That
restriction is what makes them cheap enough to run on every save.

Every audit loads authored rules in a fresh worker, so editing a rule takes effect on the next scan
instead of remaining trapped in Node's module cache.

## Configure

```ts
// doctor.config.ts
import { defineConfig } from '@norbital-ai/doctor';
import noRawFetch from './dr/rules/no-raw-fetch.ts';

export default defineConfig({
	base: 'none',
	rules: [noRawFetch],
	packs: ['./dr/packs/house-style.ts'],
	overlaps: [
		{ shape: 'clamp', owner: 'es-toolkit', member: 'clamp' },
		{ shape: 'deep-equal', owner: 'es-toolkit', member: 'isEqual' }
	],
	disable: ['OVERLAP_SUM']
});
```

### `base`

Which built-in rule set runs beneath your own.

- `norbital` (default) — the ~140-rule detector this engine grew out of: Effect ownership, a
  generated collection client, a model compiler, Svelte runes, one design system's layout
  primitives. It encodes one product's architecture. It is a **pack, not a baseline**.
- `none` — your authored rules are the whole rule set.

A project that is not Norbital should choose `none`. Note that `none` also declines the graph tier,
so reachability, dead exports, and cycles go unevaluated; the receipt records that as
`tiers.graph: false` rather than implying a complete scan.

### `overlaps`

"You reimplemented something a library already owns."

The shape detectors are library-agnostic — `Math.min(Math.max(x, lo), hi)` is a clamp in any
ecosystem — so the binding to an owner is configuration. Point them wherever you like; a file that
already imports the owner is exempt, because importing `es-toolkit` and then writing a loop is a
choice about that call site rather than unawareness of the library.

Shapes: `clamp`, `chunk`, `partition`, `deep-equal`, `group-by`, `unique`, `sum`.

## Scope with `.doctorignore`

Some source is deliberately outside a rule set's architecture: a build-time tool that cannot take
the runtime's dependencies, a vendored corpus that exists to be malformed. `.gitignore` syntax, at
the repository root:

```
# norbital-doctor itself must run without an Effect runtime, so the Effect rules do not describe it
packages/doctor/engine/
packages/doctor/src/
```

Prefer this over a row of per-line allowances: thirty allowances is not thirty reviewed exceptions,
it is one missing setting.

## Tiers

| Tier        | Cost                                     | Runs   |
| ----------- | ---------------------------------------- | ------ |
| `syntactic` | per file, pure                           | always |
| `graph`     | whole repository, module graph           | always |
| `typeAware` | a TypeScript program per owning tsconfig | always |

The type-aware tier roughly doubles scan time. It used to be optional, and off, which made it
useless for the one thing it is for: `LEGACY2` reads `@deprecated` tags that live in somebody else's
`.d.ts`, so with the tier off its silence and its all-clear were the same result. It now always
runs, `assess` always requires it, and `typeAware: false` in a receipt means only that the selection
held no file a program can contain.

Its scope is TypeScript and JavaScript. The compiler cannot parse `.svelte`, so a component's
script reaches the other two tiers but not this one.

## Programmatic use

```ts
import { audit, assess } from '@norbital-ai/doctor';

const result = await audit({ root: process.cwd() });
console.log(result.counts, result.packs, result.authoredFindings);
```

Findings, the authenticating receipt, and the reports are written to `.norbital/diagnosis/`.
