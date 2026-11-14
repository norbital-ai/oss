# Capability inventory

Everything here is native unless stated. A facility a host left `off` fails `Unavailable`.

## Data

| Capability | Lives in |
| --- | --- |
| Typed fields: text formats, numbers, money, dates, periods, enums, state, sequences, roll-ups, json, files, points, vectors | `+model.ts` |
| Keys, unique, index, check, non-overlapping periods, computed expressions | `+model.ts` |
| One-to-many, many-to-many via a model, polymorphic arcs, ownership, delete rules | `ref` fields |
| Structured domain values | custom fields |
| Runtime formulas, extraction variants, business catalogues | configuration models validated by write contracts |
| Parent-owned calculation parts, document snapshots | shaped JSON or custom datatypes |
| Effective-dated facts, versioned lineages | `period` + `no_overlap` constraint + callbacks, std versioned |
| System columns, history, audit | runtime |
| Reviewed SQL migrations generated from the manifest | root `migrations/` |
| Text, semantic and custom-index search, filters, cursor paging, aggregates | `search`, `bolt.query` |

## Workflow

| Capability | Lives in |
| --- | --- |
| Per-verb callbacks and refusals | `+model.ts` |
| Lifecycles and edit locks | `state` field and named `locked` constraints |
| Computed reads, named business operations | a read plus helper; an automation |
| File import and export with context, findings and documents | `+<sync>.sync.ts` with `with: 'file'` |
| Scheduled and manual durable work, immediate typed calls | automations; model effects handle row writes; integrations verify webhooks |
| Source teams, policies, inline approvals, decision audit | `access_control/` |
| Formula evaluation; exact decimal and money; calendars and business days | std modules |
| Documents (Markdown or HTML to declared targets), a record's own view as a PDF, spreadsheets | `ctx.convert.document`, `ctx.convert.record`, std sheet; both are optional host capabilities |

## People, communication, AI

| Capability | Lives in |
| --- | --- |
| Envoys on conversation channels under declared policies; sender matching only where the driver carries a handle | runtime `sys_envoy` rows, `sys_integration.envoy` |
| In-app agent briefs | `+agent.md`, `+agent.external.md` |
| Workspace skills; personal skills per tenant and person | `agent/skill/<name>/+skill.md`; Colony personal-skill tools |
| Agent tools with bundled packages under declared authority | automations with `agent: 'direct'` or `'confirm'` |
| Remote MCP servers, granted by policy | `agent/mcp/` |
| Typed decisions; LLM inference with structured output, images and files; embeddings | `ctx.ai.*` |
| Speech to text | `ctx.convert.ingest` when the host binds Convert |
| Mail, chat and in-app notifications; record-driven outbound with delivery events | connections, sync `write` and `read`, `notify` |
| Workspace secrets | `+secrets.ts` |
| File storage, upload, image facts | `file` fields, `ctx.files` |
| Portal users and signed-out public forms | `audience` on `+app.ts` |
| Public and external sites with caller-scoped SSR | `ctx.query` in the public page |
| Device kiosks and embeddable customer sites with phone verification and self sign-up | `portal: true`, kiosks, `signup` |

## External world (mediated)

| Capability | Lives in |
| --- | --- |
| Source mirrors, local annotations, outbound commands | model syncs with engine-managed cursors, outbox, idempotency |
| Outbound HTTP with bearer, basic, header or OAuth2 credentials | `http` definition, connection, `ctx.request` |
| Verified webhooks triggering sync reads | integration `webhook.verify`; sync `read` gets `deliveries` |
| Verified webhooks answered by a body | integration `webhook.handle` with `webhook.policies`: reads, acts, replies |
| Durable multi-step processes | `ctx.wait` in a job: until a time, a matching write or an approval's decision |
| Signed inbound webhooks | integration `webhook.verify`, retained deliveries for model syncs |
| Web page reads | `ctx.web.read` |
| Browser SDKs and WASM | page dependencies |

## UI

Apps, groups, pages; tables, boards, forms, matrices, charts, pivots, maps; record views; pickers, typed inputs, markdown, formula and code editors; camera capture with liveness and on-device face descriptors; typed message catalogs; layout primitives with one scroll owner per axis.

## Not a capability

- The platform's billing and metering prices the platform; it is no tenant payment facility.
- Sandbox host tools reach source during authoring; they are not runtime features.
