# Bolt template migration

| Old form | New form |
| --- | --- |
| `model(name, spec)` and `integration(name, spec)` imported from the package root | Run `bolt check` to generate declaration bindings. Import `model` from `.norbital/models/<name>.ts` or `integration` from `.norbital/integrations/<name>.ts` using the declaration file’s relative path, then call `model(spec)` or `integration(spec)`. The generated binding supplies its path-derived callback types. |
| `Insert<M>` or `CreateTree<M>` | `CreateInput<M>` |
| `Patch<M>` or `UpdateTree<M>` | `UpdateInput<M>` |
| `CreateRow<M>` in a transform | Infer the row from the model's create transform signature. Use `CreateInput<M>` for rows the caller supplies. |
| `UpdateSet<M>` in a transform | Infer the set from the model's update transform signature. Use `UpdateInput<M>` for sets the caller supplies. |
| `ctx.transaction(function* (tx) { … })` | Read before the act and pass observed revisions on writes. Group writes in one `ctx.act.many` batch. Use nested write layers or carried rows when one write supplies rows for another. |
| `ctx.ai.speak(...)`, `SpeakOptions`, `SpeechFormat` | Remove these uses and any host speech configuration. Audio transcription still uses `ctx.convert.ingest`. |
| `src/agent/envoy/+<id>.envoy.ts` and `envoy(spec)` | Create an active `sys_envoy` row in Settings, then bind its UUID on the connection. Move `groupMessages` to `group_messages` and map `triage: { scope }` to `triage: true` plus `triage_scope`. |
| `EnvoyName` and `EnvoySpec` | Use `Id<'sys_envoy'>` for a runtime envoy's ID and `Row<'sys_envoy'>` for its readable row. |
| `connections.<slot>.envoy` | Set `sys_integration.envoy` to the envoy row's UUID after provisioning the slot. |
| `CursorValue` from `@norbital-ai/bolt/protocol/cursor` | Import `CursorValue` from `@norbital-ai/bolt/protocol`. |
| `jsonDiff` from `@norbital-ai/bolt` | Use the inference draft's `diff` tool for draft changes. Code comparing values directly owns that comparison. |
| `import { bolt } from '$bolt'` or `useBolt()` in an authored view | Accept `ctx` as a prop. Use `PageContext` for shell pages and `PublicPageContext` for public pages, both from `@norbital-ai/bolt/page`. Pass the whole context or the operations a child needs. |
| `useKinds().zone` | Read `ctx.tz` or pass it to a child as a prop. |
| `run`, `fork`, `attach` from `$bolt` | Import the execution helpers from `@norbital-ai/ui/effect`. |
| `pages.<page>.embed` | Put the allowed origins on the app's `embed`. The policy applies to all pages in that app. Split apps that need distinct framing policies. |
| `ctx.db.query`, `ctx.db.aggregate`, `ctx.db.after` | Use `ctx.query`, `ctx.aggregate` and `ctx.query.after` respectively. Callbacks and syncs keep their existing read authority. |
| `return ctx.deny(message, at)` in a policy | Use `return yield* ctx.refuse(message, at)`. |
| `ctx.todayIn`, `ctx.invocationId`, `ctx.carriedBy` | Use `ctx.today_in`, `ctx.invocation_id`, `ctx.carried_by`. |
| `browserStart`, `instanceId`, `isInstance`, `idOf` | Import `browser_start`, `instance_id`, `is_instance`, `id_of`. |
| `ctx.recordCapabilities`, `ctx.previewPdf`, `ctx.fileUrl` | Use `ctx.record_capabilities`, `ctx.preview_pdf`, `ctx.file_url`. |
| `ctx.files.image(ref, { jpeg: { maxEdge } })` | Use `{ jpeg: { max_edge } }`. |
| Page `ctx.convert(source, request)` | Start an automation that uses `ctx.convert.document` to create a file. Use `ctx.preview_pdf` for PDF bytes. |
| Page `ctx.start(name, input)` and type `PageStart` | Use `ctx.run(name, input)` and type `PageRun`. The returned job handle still carries `id`, `ids` and `automation`. |
| `ctx.files.text`, `ctx.files.table`, `ctx.files.sheet` | Use `ctx.convert.ingest` in an automation for parsed documents and spreadsheets. A file-sync parser reads its bytes with `ctx.files.get`. |
| Policy `automations: [...]` | Move the list to `capabilities.automations`. |
| Policy `create.check`, `update.check`, `delete.check` | Rename the callback to `verdict` in the same verb block. |
| Policy `read` | Move the grant to `outputs.default`. The root scope is `{ where }` and child scopes nest under their relation names. Identity outputs use the same `{ where }` form. |
| Policy `history` beside the read grant | Set `history: true` on each output whose readers may inspect revisions. Its root `where` also scopes history. Add this flag explicitly where an earlier read-only grant was intended to expose revisions. |
| Policy `moves` on a model grant | Move it into `update.moves`. Rewrite `update: true` as `update: { moves }` or use `update: { columns: {}, moves }` when the old policy granted only moves. |
| `ctx.approve(flow => flow.step(...).supersededBy(...))` | Pass `{ steps: [{ name, teams }], superseded_by: [...] }` directly. Use ordinary conditions to select steps. Use `ctx.allow()` and `yield* ctx.refuse(...)` for immediate verdicts. Approval steps name teams. |
| `automation(name, spec)` | Use `automation(spec)`. The file supplies the name and the body infers its input and result from the declared fields. |
| `on: { cron: ... }` or `on: { webhook: ... }` | Use `on: [{ cron: ... }]` or `on: [{ webhook: ... }]`. |
| Automation `delegations` | Give the automation's declared policies the exact generated verbs needed by the run. |
| Automation `limit` | Remove the declaration entry. Manual starts have a fixed quota of 30 per automation and starter per minute. |
| `+<page>.page.server.ts`, `<page>.page.data.ts`, and `data` page prop | Move the reads to `ctx.query` in the Svelte page and derive display values from `query.current`. Read path filters from `ctx.location` on public pages. Delete the companion and its data codec. |
| Test kit `sweep({ publicPages: codecs })` | Remove `publicPages`. The sweep validates the page's admitted query snapshots. |
| `app(name, spec)` | Use `app(spec)`. The folder names the app and each listed page needs a file. |
| `src/kiosk/<name>/+kiosk.ts` with `kiosk(name, spec)` | Move the directory contents to `src/app/<name>/` and export `app({ ...spec, shell: 'kiosk' })` from `+app.ts`. Replace signed-in `auth` with `audience`. Move `policies` to `audience.public` for `auth: 'none'`. Move policy `capabilities.kiosks` entries into `capabilities.apps`. |
| `group(name, { label, defaultChild })` | Use `group({ title, default_child })`. The folder names the group and `default_child` names a direct child. |
| `customField(name, spec)` | Use `custom_field(spec)`. The folder names the field and `validate` infers its input from the declared shape. |
| Model `read: 'all'` or `read: { model: { fields }, 'model.relation': { fields } }`, and flat named outputs | Move the default into `outputs.default` and put child projections under their relation names. Use `outputs: { default: { fields: 'all', relation: { fields: [...] } }, named: { fields: [...] } }`. |
| Model ref `onDelete: 'setNull'` | Use `on_delete: 'set_null'`. Other delete actions keep their values. |
| Model `unique: [{ fields, where, name }]` | Use `constraints: { [name]: { unique: fields, where } }`. Give unnamed rules a name. |
| Model `check: { rule: where }` | Use `constraints: { rule: { check: where } }`. |
| Model `noOverlap: [{ period, key, where, name }]` | Use `constraints: { [name]: { no_overlap: period, per: key, where } }`. |
| Model `locked: where` | Use `constraints: { locked_record: { locked: where } }`. Use `except: ['column']` for fields that stay editable. |
| Model `label: 'field'` or `label: ['a', 'b']` | Use the CEL expression `record_label: 'record.field'` or `record_label: "[record.a != null ? string(record.a) : '', record.b != null ? string(record.b) : ''].filter(part, part != '').join(' · ')"`. |
| Model `computed: { total: { kind, expr } }` | Move each entry into `fields.total: { kind, computed: expr }`. |
| Model `index`, `table.indexes`, `search.text`, `search.semantic`, `search.indexes` | Declare one named `indexes` map. Physical entries use `{ on }`, text entries `{ text }`, semantic entries `{ semantic }`, and custom vector entries retain their bodies and metadata. |
| `kind: 'list', of: item` | Put `many: true` on the item descriptor. List bounds become `min_items` and `max_items`. Keep `key` on a many-valued object. Wrap nested or nullable item descriptors in `{ kind: 'json', shape: item, many: true }`. |
| File field `multiple: true` | Use `many: true`. |
| Input `kind: 'id', of: model` | Use `kind: 'ref', to: model`, including nested inputs and shapes. |
| Field `kind: 'duration'` | Use `kind: 'int'` for whole seconds, with explicit bounds as required. |
| `orderBy`, `asOf`, `onConflict`, `isNull` | Use `order_by`, `as_of`, `on_conflict`, `is_null`. |
| Outcome `pendingApproval`, approval decision `requestChanges`, history reason `uncompatible` | Use `pending_approval`, `request_changes`, `incompatible`. Migrate persisted structured payloads during cutover. |
| Actor `teamPath`, kind `apiKey`, MCP `clientId` and `clientSecret` | Use `team_path`, `api_key`, `client_id`, `client_secret`. |

Apply these entries when relocking the template to the matching Bolt release. For deployed workspaces, create the runtime envoy rows and remap their connections and conversation references before activating the new release.
