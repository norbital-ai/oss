# @norbital-ai/doctor

The static rules `bolt check` runs over a workspace's TypeScript and Svelte source (RFC §3.3.10, OD-K5′).

Four fixed packs, one YAML file per rule under `packs/`: `boundaries`, `layout`, `svelte` and `reactive`. There is no
configuration, no CLI and no authored-rule API: a workspace adds no rules, and every finding is an error. A reviewed
`repository-health:allow <rule> -- <reason>` on the reported line, or in the comment block directly above it, suppresses
that one rule there; a marker without a reason suppresses nothing. `.doctorignore` scopes files and rules.

```ts
import { doctor, type Finding } from '@norbital-ai/doctor';

const findings: readonly Finding[] = doctor({ root: workspaceRoot });
```

The realm's own gates select the realm packs under `packs/realm/` by name: `realm/boundaries` (package isolation and
host neutrality), `realm/graph` (unreachable modules, unreferenced exports, duplicate bodies; tests reach but are never
reported), `realm/overlaps`, `realm/structure`, `realm/effect`, `realm/ceremony`, and `realm/types` (the type-aware
tier: a call resolved to a `@deprecated` signature is `LEGACY2`). An absolute directory selects a host's own pack.

```ts
doctor({ root: ossRoot, packs: ['realm/boundaries', 'realm/graph'] });
```

- [Rule catalogue](./docs/rules.md)
- [Rule algebra](./docs/matcher.md) (a port of ast-grep's `SerializableRule`)
