# @norbital-ai/doctor

The audit over a workspace's TypeScript and Svelte source (RFC §3.3.10, OD-K5′).

Four packs, one YAML file per rule under `packs/`: `boundaries`, `layout`, `svelte` and `reactive`. Findings are
`error` or `hint`. A reviewed `repository-health:allow <rule> -- <reason>` on the reported line, or in the comment block
directly above it, suppresses that one rule there; a marker without a reason suppresses nothing. `.doctorignore` scopes
files and rules.

```ts
import { doctor, search, type Finding, type SearchRule } from '@norbital-ai/doctor';

const findings: readonly Finding[] = doctor({ root: workspaceRoot });
```

**An organization's rule set** (`@norbital-ai/doctor/rule-set`, Schemas only) is data its host stores: each platform
rule's state (`error`, `hint` or `off`), organization-wide path globs the audit skips, and its own rules in the packs'
schema. `norbital-doctor [root] [--rules <file>] [--rules-only] [--json]` is the one entrypoint that runs it, for the
sandbox's `audit` job and a repository's CI alike. With `--json` it writes one `AuditEvent` per line — every rule as
that organization sees it, each own rule that does not compile (the audit completes without it), the findings, and a
last `done` line naming the rule set's digest and this doctor's version — and exits 0 once complete. Without it, an
`error` finding or a rule error exits 1. It writes nothing into the tree.

`search()` matches one ad hoc rule without running a pack; it is the only public rule-matching API.

The realm's own gates select the realm packs under `packs/realm/` by name: `realm/boundaries` (package isolation and
host neutrality), `realm/graph` (unreachable modules, unreferenced exports, duplicate bodies; tests reach but are never
reported), `realm/overlaps`, `realm/structure`, `realm/effect`, `realm/ceremony` and `realm/erase`
(type erasure). An absolute directory selects a host's own pack.

```ts
doctor({ root: ossRoot, packs: ['realm/boundaries', 'realm/graph'] });
```

An explicit Markdown file list also checks TypeScript, JavaScript, JSX, TSX and Svelte code fences
with `realm/effect`. Tenant registration callbacks retain their Markdown line numbers and fence-local
bindings; prose, presentation handlers and native Promise adapters do not become tenant bodies.

- [Rule catalogue](./docs/rules.md)
- [Rule algebra](./docs/matcher.md) (a port of ast-grep's `SerializableRule`)
