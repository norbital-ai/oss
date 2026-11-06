# Behavior and mechanism map

This is the reading map for the authored contract and its runtime implementation. It describes
source behavior, not a claim that a particular host has deployed this release. The generated
API reference gives exact signatures and field options; this handbook explains their interaction.

## Declarations, values and compilation

A workspace declares models, custom fields, policies, source teams, apps, pages, integrations,
automations, kiosks, messages, agents, envoys, MCP endpoints, secrets and seeders. Compiler roles
come from filenames. Ordinary helpers are not declarations. Model names repeat their path name;
build refuses mismatches. Generated names carry literal data shapes, not imports of declaration
bodies, avoiding self-typing cycles. See [Workspace contract](./workspace-contract.md),
[Schema and type inference](./inference.md) and [Dev loop](./dev-loop.md).

Fields use the canonical kind language in `@norbital-ai/std/kind`. Input and stored-value decoders,
wire encoding, nullability, defaults, brands and nested shapes derive from it. Custom values use
`src/data/custom_field/<name>/+definition.ts` and an optional renderer. Model refs own relational
identity; inline objects do not acquire independent permissions or history. See
[Custom fields](./custom-fields.md). The UI's structured-data renderer also recognizes semantic
JSON Schema formats and exact native shapes; unknown named datatypes and explicit shape
mismatches in seeded schemas fail check/build. An implicit near-match stays an ordinary object.

## Reads, outputs, authority and liveness

Each read selects exactly one fixed model output: `default`, or a named output granted by policy.
Only the root model's policies authorize the access point. Each grant can scope individual
layers; a deeper scope filters that layer or nulls its ref, without removing the root. Field
visibility belongs to the output declaration, not a policy mask. Reading the related model as
its own root is a separate access point. See [APIs](./apis.md) and [Models](./models.md).

One JSON request can contain several roots and declared relation layers. Reads support explicit
fields, predicates, order, cursors, aggregates, history and search within the declared contract.
Unknown options and paths fail rather than silently widening a query. Live pages use reactive
`current`, `loading`, `error`; one-shot reads can be awaited and server reads yielded. Materialize
clock values before putting them into predicates. Search indexes and their typed probes are
maintained by the engine; see [Search](./search.md).

## Writes, invariants and atomicity

Create, update, delete and upsert by ID or natural key take arrays on every surface. Write exposure, policy
columns, state moves, locks and model validation all apply to generated business writes. A
parent-owned child written through a parent layer uses the parent's authority but still runs its
own business callback. Defaults, checks, uniqueness, FK actions, audit and expressible state
invariants have native database enforcement. Raw SQL is privileged and does not gain application
policy checks. A model lock is an application rule, not a SQL permission.

Create transforms return rows; update transforms receive before/set pairs; delete checks may
refuse. They plan and validate, not perform external I/O. Seed restore and derived roll-ups are
explicit bypasses. A callback handles up to 1,000 rows per invocation and batches dependent reads;
all chunks of an import remain in its one transaction. See [Models](./models.md).

Separate acts are separate commits. Group independent writes in one batch when they must commit
together. Dependent reads and writes can use a native transaction generator: one session,
read-your-writes, one settlement and a fixed five-second deadline. PostgreSQL 17+ is required;
PGlite explicitly refuses it. Only transaction reads and guarded writes are admitted; no captured
outer Effects, I/O, async callbacks or nesting. Inner answers are provisional. The outer answer
alone is committed or held, with no callback output for a held transaction. See [APIs](./apis.md).

## Approval and history

Source teams map to policies. Parent teams scope hierarchy without automatically inheriting
permission. A direct matching allow executes; absent direct permission, an applicable approval
flow holds a provisional write and snapshots its steps and approvers. The optional model
`record_label` CEL identifier is resolved and searched through the target reference at read time;
it is never copied onto the request. Target row grants and readable label dependencies apply.
Without a label or accessible target, consumers show the target record UUID from the existing reference. Approve, reject and
request-changes are distinct outcomes. Rejection restores the checkpoint; editing and resubmitting
reevaluates the policy. `supersededBy` names exact source team handles. Automation, integration and
envoy identities do not approve. See the policy declarations and the public approval guides.

Native audit captures committed changes, including referential actions. Historical reads expose
the selected output under current authority. Restore is a guarded business write, subject to
current exposure, locks and validation; it does not bypass current rules. Built-in record history
is bounded and is not a substitute for a domain's required long-lived snapshots.

## Effects, automations and recovery

A model effect is durable work after commit, queued by the same write statement. Created and
deleted receive rows; updated receives before/after changes to stored fields. Its input is the
writer's readable output, it runs as that writer, and it holds no independent policy. Its
facilities are the run context. Further writes can queue effects, with a depth cap of eight.

A named automation is different authority: it always runs as the reserved system identity with
its required non-empty `policies`. Cron and verified webhook declarations schedule it; no `on`
means started only. Model row events belong in effects. `ctx.run.trigger` records a person and
optional Norbius conversation, or a system cause (cron, webhook, effect, schedule). Trigger
provenance grants no permission. Code acting for the starter must explicitly check the trigger;
`requestor.*` in a system run does not identify that person. `policy.automations` grants manual
starts only; scheduling from code does not require it. See [APIs](./apis.md).

A run can contain several commits and external calls. Process-lost automations rerun from the
beginning; they do not replay a journal of prior I/O. Declared failure retries and backoff are
separate from this recovery. Provider idempotency keys remain necessary for external effects.
Chat sessions resume saved turns. An operation's key deduplicates that operation, not the whole
business world. Progress and run status are the observation path, not a refresh loop on another
model. Identity administration events have their dedicated path in
[Identity automation events](./identity-automations.md).

## Sync, integrations and communication

File imports parse and validate complete row sets, produce row/field findings, match keys and
apply guarded writes atomically under caller authority. Context is input, never an authorization
grant. Exports select a declared document target. Remote syncs operate through their own trusted
instance exchange; field ownership preserves local fields. Cursor reads, webhook hints, conflict
handling and retries belong to the sync engine. See [Syncs](./syncs.md).

Integration declarations own configuration and request shapes; host facilities own providers,
sealed credentials, OAuth and network I/O. Named workspace connections and paired runtime
instances are distinct from source defaults. Credential data never becomes a readable model
field. See [Integration providers](./integration-providers.md).

Model notices are queued after commit and delivered independently. Inbox and optional external
channels share recipient, attachment and record-link contracts. An external conversation send is
an explicit operation through a connection, not a model notification. See
[Notifications](./notifications.md) and [APIs](./apis.md).

## Agents, files, AI and tools

Norbius receives only the caller's granted tools and outputs. `describe_workspace` provides a
compact policy-filtered map of apps/pages, models and automations; focused calls and source
inspection supply details. Mutations use the same guarded catalogue as pages. Planning,
confirmation, delegation, skills and MCP do not confer extra data authority.

File ingest is a job using one converter path. Documents become sanitized HTML and images;
structured data becomes typed JSON and images. A host may read a scanned page with a vision model and
add its transcript beside the page's image (`data-read`). Audio transcription is performed by the converter when its audio model
is configured. Jobs outlive a turn and completion can wake the conversation. Numbered windows,
table boundaries and cached outputs constrain rereads. See [Documents](./documents.md).

AI classes and their facility availability come from the workspace and host. Structured inference
uses a schema-checked draft and tool operations, with explicit request rules, progress and step
semantics. Embedding uses scoped file access and declared model classes. Host observations own
usage and billing; a workspace cannot assert its own metered cost. See
[Runtime overview](./README.md) and the generated inference API reference.

## UI, public surfaces and release lifecycle

Generated tables, forms, record sheets, boards, matrices, filters and history consume the model
contract. A custom representation receives a `RecordView` from the UI package and preserves
create/view/edit state. Custom field renderers keep typed values and honor readonly/disabled
controls. Shared controls own size, scroll regions, errors and semantic datatype dispatch.
Devices expose only their declared page capability; see [Device](./device.md).

Public pages and kiosks have explicit authentication, scope and capability boundaries. Source
bundles, server bodies and secrets do not cross into the browser graph. Public-page hydration and
the internal SPA are distinct builds; the internal SPA shares one platform Svelte/UI/Effect
runtime with the shell. See [Client bundling](./client-bundling.md).

A build emits bundle, authored source and seed packs by digest, plus reviewed SQL migrations and
physical proofs. A host activates a release and applies its immutable migration history. A new
template release does not change an existing tenant automatically; publication and promotion are
separate. Native migration replay catches schema drift; it cannot invent missing data backfills.
See [Releases](./releases.md), [Seeding](./seeding.md), [Hosts](./hosts.md) and
[Studio changes](./studio-changes.md).

## Source checkpoints

| Contract                             | Owning implementation                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| Declarations and typed contexts      | `src/decl/`, `src/protocol/read-request.ts`                   |
| Kinds, codecs and wire               | `../std/src/kind.ts`, `../std/src/wire.ts`                    |
| Reads, outputs and live invalidation | `src/engine/query/`, `src/engine/access/`, `src/engine/live/` |
| Writes and model effects             | `src/engine/write/act.ts`, `src/engine/runs/`                 |
| Approval and identity                | `src/engine/access/`, `src/engine/identity/`, `src/system/`   |
| Sync and integration instances       | `src/engine/sync/`, `src/engine/integrations/`                |
| Agent tools, ingest and AI           | `src/engine/agent/`, `src/decl/runtime/facilities.ts`         |
| Notifications and conversations      | `src/engine/notifications/`, `src/engine/conversations/`      |
| UI and structured data               | `../ui/src/`, `../std/src/kind.ts`                            |
| Discovery, artifacts, types, seeds   | `../bolt-cli/src/compiler/`, `../bolt-cli/src/test/`          |
| ABI and limits                       | `src/protocol/host-api.ts`, `src/engine/contracts.ts`         |

Paths in this table are relative to the Bolt package. The published API reference links to the
exact declaring file and line; inspect that source for details beyond the guide.
