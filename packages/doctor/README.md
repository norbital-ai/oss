# @norbital-ai/doctor

The static rules `bolt check` runs over a workspace's TypeScript and Svelte source (RFC §3.3.10, OD-K5′).

Four fixed packs, one YAML file per rule under `packs/`: `boundaries`, `layout`, `svelte` and `reactive`. There is no
configuration, no CLI and no pack-authoring API: a workspace adds no rules. Findings are `error` or `hint`; only
`error` blocks. A reviewed
`repository-health:allow <rule> -- <reason>` on the reported line, or in the comment block directly above it, suppresses
that one rule there; a marker without a reason suppresses nothing. `.doctorignore` scopes files and rules.

```ts
import { doctor, search, type Finding, type SearchRule } from '@norbital-ai/doctor';

const findings: readonly Finding[] = doctor({ root: workspaceRoot });
```

`search()` matches one ad hoc rule without running a pack; it is the only public rule-matching API.

The realm's own gates select the realm packs under `packs/realm/` by name: `realm/boundaries` (package isolation and
host neutrality), `realm/graph` (unreachable modules, unreferenced exports, duplicate bodies; tests reach but are never
reported), `realm/overlaps`, `realm/structure`, `realm/effect`, `realm/ceremony`, `realm/erase` (type erasure), and `realm/types` (the type-aware
tier: a call resolved to a `@deprecated` signature is `LEGACY2`). An absolute directory selects a host's own pack.

```ts
doctor({ root: ossRoot, packs: ['realm/boundaries', 'realm/graph'] });
```

An explicit Markdown file list also checks TypeScript, JavaScript, JSX, TSX and Svelte code fences
with `realm/effect`. Tenant registration callbacks retain their Markdown line numbers and fence-local
bindings; prose, presentation handlers and native Promise adapters do not become tenant bodies.

- [Rule catalogue](./docs/rules.md)
- [Rule algebra](./docs/matcher.md) (a port of ast-grep's `SerializableRule`)
