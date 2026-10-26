# Workspace contract

A model is one entity: stored fields, relations, read and write exposure, validation, queries,
search, notifications and syncs. Each declaration has one owning file. Every callback
sits inside that declaration on the thing that invokes it.

```text
src/
├── +workspace.ts
├── +secrets.ts
├── data/
│   ├── model/<name>/+model.ts
│   ├── model/<name>/+representation.svelte
│   └── custom_field/<name>/+definition.ts, +renderer.svelte
├── access_control/team/+team.ts
├── access_control/policy/+<name>.policy.ts
├── integration/<name>/+integration.ts, +integration.svelte
├── automation/+<name>.automation.ts
├── agent/
├── app/
├── kiosk/
├── i18n/
└── lib/
```

| Declaration               | Owning file                               | Callbacks                                                                                                        |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `model(name, spec)`       | `data/model/<name>/+model.ts`             | `create.transform`, `update.transform`, `delete.check`, `queries.*.run`, `search.indexes.*`, `notify`, `syncs.*` |
| `customField(name, spec)` | `data/custom_field/<name>/+definition.ts` | `validate`                                                                                                       |
| `policy(spec)`            | `access_control/policy/+<name>.policy.ts` | `approval` on each write grant                                                                                   |
| `team(spec)`              | `access_control/team/+team.ts`            | none                                                                                                             |
| `integration(name, spec)` | `integration/<name>/+integration.ts`      | `test`                                                                                                           |
| `automation(name, spec)`  | `automation/+<name>.automation.ts`        | `run`                                                                                                            |

Names come from paths. Declarations with bodies repeat that name as their first argument;
`bolt check` refuses a mismatch. Models always use named folders so their representation can
live beside them. Relations are `kind: 'ref'` fields on the model holding the foreign key.
Apps, groups, kiosks, envoys, MCP servers and message catalogues keep their own file roles.
Ordinary helpers live in `lib/` or beside their owning component.

`bolt sync` evaluates declarations and writes their data shapes as literal type text into
`.norbital/names.ts`; bodies are omitted. It does not type a declaration through an import of
its own source. `bolt dev` synchronizes on save; `bolt check` synchronizes before checking.
A new field becomes visible to bodies on the next sync. Never edit generated files.

Start with [the model](./models.md), then its [syncs](./syncs.md), [search](./search.md) and
[notices](./notifications.md). [APIs](./apis.md) describes the execution contexts and authority.
