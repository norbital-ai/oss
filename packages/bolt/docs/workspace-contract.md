# Workspace contract

A model is one entity: stored fields, relations, read and write layers, validation, search,
notifications and syncs. Each declaration has one owning file. Every callback
sits inside that declaration on the thing that invokes it.

```text
src/
├── +workspace.ts
├── +secrets.ts
├── data/
│   ├── model/<name>/+model.ts          # folders may nest; the leaf folder names the model
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

| Declaration               | Owning file                               | Callbacks                                                                                       |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `model(name, spec)`       | `data/model/**/<name>/+model.ts`          | `create.transform`, `update.transform`, `delete.check`, `search.indexes.*`, `notify`, `syncs.*` |
| `custom_field(spec)` | `data/custom_field/<name>/+definition.ts` | `validate`                                                                                      |
| `policy(spec)`            | `access_control/policy/+<name>.policy.ts` | `check` on each `create`, `update` and `delete` grant                                           |
| `team(spec)`              | `access_control/team/+team.ts`            | none                                                                                            |
| `integration(name, spec)` | `integration/<name>/+integration.ts`      | `test`                                                                                          |
| `automation(spec)`  | `automation/+<name>.automation.ts`        | `run`                                                                                           |

Names come from paths. Declarations with bodies repeat that name as their first argument;
`bolt check` refuses a mismatch. Models always use named folders so their representation can
live beside them. Model folders may nest under another model or an ordinary grouping folder: the
leaf folder names the model and the name stays unique across the workspace. Relations are
`kind: 'ref'` fields on the model holding the foreign key.
Apps, groups, kiosks, MCP servers and message catalogues keep their own file roles.
`src/agent/+agent.md` is the in-app agent's brief for staff and `+agent.external.md` the brief for
external members. `skill/<name>/+skill.md` declares a workspace skill and `mcp/+<name>.mcp.ts` a remote MCP server. Envoys live in `sys_envoy` rows, and their connections and credentials are configured at runtime.
Ordinary helpers live in `lib/` or beside their owning component. A computed answer that was once a
declared query is a read request (a root and its layers) plus a pure `lib/` helper, called by the
page and, over `ctx.query`, by server code.

`bolt sync` evaluates declarations and writes their data shapes as literal type text into
`.norbital/names.ts`; bodies are omitted. It does not type a declaration through an import of
its own source. `bolt dev` synchronizes on save; `bolt check` synchronizes before checking.
A new field becomes visible to bodies on the next sync. Never edit generated files.

Start with [the model](./models.md), then its [syncs](./syncs.md), [search](./search.md) and
[notices](./notifications.md). [APIs](./apis.md) describes the execution contexts and authority.
