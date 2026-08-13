# Pod specification

Status: normative. This is the compatibility contract for `@norbital-ai/pod` workspaces, builds,
hosts, and browser clients.

## 1. Workspace source

A Pod workspace MUST be a Vite/Svelte project configured with one `pod()` plugin. Authored behavior
lives under `src/` and is discovered by filename:

| Source                                      | Contract                           |
| ------------------------------------------- | ---------------------------------- |
| `collections/<name>/+model.ts`              | collection schema and metadata     |
| `collections/<name>/+hooks.ts`              | mutation lifecycle behavior        |
| `collections/<name>/+pipelines.ts`          | import/export/processing pipelines |
| `collections/<name>/+representation.svelte` | collection-specific UI             |
| `collections/+relationship.ts`              | cross-collection relationships     |
| `custom-types/<name>/+definition.ts`        | reusable validated data type       |
| `custom-types/<name>/+renderer.svelte`      | display/edit renderer              |
| `apps/**/+<name>.svelte`                    | navigable application surface      |
| `automation/+<name>.ts`                     | scheduled or collection-event automation (deterministic handler) |
| `policies/+<name>.policy.ts`                | named policy / role                |
| `channels/+<name>.channel.ts`               | conversational channel entry point |
| `tools/+<name>.tool.ts`                     | compiler-discovered workspace agent tool |
| `+agent.ts`                                 | interactive agent profile          |
| `remotes/+<name>.ts`                        | typed server query or command      |
| `+seed.ts`                                  | optional standalone seed           |

Workspace source MUST NOT contain a second application router, SvelteKit routes, a manual workspace
registry, or hand-authored generated schema assembly.

## 2. Compiler and generated state

`pod sync` MUST validate topology and generate the registry, types, migration inputs, and compiler
configuration. `pod check` MUST type-check all generated and authored TypeScript/Svelte. `pod build`
MUST refuse invalid source and produce isolated browser/server outputs.

`.norbital/generated`, `.norbital/types`, `.norbital/diagnosis`, and build output are disposable Pod
state. `.norbital/migrations` is authored history and MUST be committed. Generated files MUST NOT be
edited by hand.

Discovery MUST be deterministic. Duplicate names, invalid suffixes, unknown relationships, and
manifest references to missing source MUST fail sync/check rather than resolve by filesystem order.

## 3. Deployment unit

A tenant runs an immutable template revision with an exact package lockfile. Editing a template source
directory does not mutate an already-provisioned tenant. A runtime process serves one compiled
manifest revision; schema-changing deployment replaces that process.

Hosted and standalone modes MUST execute the same Pod server bundle. Hosted mode MUST NOT load
`pod.host.ts`. Standalone mode MAY load it to supply local bindings and identity.

## 4. Identity and organization

The host is authoritative for the signed-in user and active organization. Pod is authoritative for
the policy scope derived from that identity and the tenant database.

Every request MUST carry one complete base scope. Runtime code MUST NOT consult a second mutable
organization singleton. Every shell, generated client, replica, and server request in one document
MUST refer to the same organization and compiled workspace.

Organization switching MUST validate membership, make the target runtime ready, set the active host
session, and replace the document. Failure before session update leaves the old workspace canonical.

## 5. Runtime trust boundary

Hosted tenant code runs without host credentials or arbitrary network access. The host supplies typed
facility bindings. Pod MUST reject startup when a manifest requirement is not satisfied.

The database facility MUST support PostgreSQL 18+ queries and pinned transactions. Transaction
methods MUST keep `begin`, subsequent queries, and commit/rollback on the same connection.

External provider credentials belong to the host. Tenant record reads/writes, policy, hooks,
approvals, audit, history, and sync belong to Pod.

## 6. Collection contract

All ordinary writes MUST use `collection_ops`. The `_ops_guard` database boundary MUST reject direct
collection inserts, updates, and deletes. A mutation transaction MUST atomically include the record,
relationships, version/history, approvals, audit/outbox side effects, and sync announcement.

All ordinary reads MUST combine the authored query with the current requestor policy. Unknown
collections/columns, invalid filters, and malformed cursors MUST fail explicitly.

Before-hooks may validate or normalize input. After-hooks observe the committed record through the
elevated post-write API. Approval-gated changes MUST remain invisible until released and MUST produce
the visibility deltas required by active replicas.

Mutation availability is explicit behavior. A collection with no `create`, `update`, or `delete`
behavior for an action is read-only for that action; a representation component does not grant
write authority. An empty authored action section permits the action without adding a hook.

## 7. Remotes, pipelines, automations, and facilities

Runtime endpoints MUST authenticate before registry dispatch. An export pipeline receives only rows
visible to the caller and selected by the requested record IDs/filter. Its returned manifest MUST be
JSON-serializable. An ordinary import pipeline MUST validate its input before ordinary collection
operations commit the returned records; partial imported writes MUST roll back.

An inbound integration delivery MUST stage one durable receipt keyed by the provider event id, then
synchronously validate its declared input before acknowledging success. A worker invocation MUST claim at
most one receipt and commit at most one bounded `createMany` chunk with that receipt's offset. Pipeline
output MUST be materialized once before the first chunk; retries MUST use that materialization rather
than rerunning author code. The row writes and offset advance MUST share one transaction, and an expired
lease MUST resume from that offset. Retryable faults MUST use bounded backoff; schema refusal is terminal
with zero rows. Each runtime read/write step is budgeted to complete within two seconds; longer waits and
provider latency belong to the host orchestrator between durable steps. The same 2,000 ms cap
applies to every admitted guest invocation — remotes, hooks, collection operations, automation
reducer steps, and agent-turn steps — not only integration chunks.

Automations MUST be declared in the compiled registry, run with the restricted before API, and
record a success or failure in `automation_run`. Integration transforms MUST use their declared
direction and binding. Unknown registry keys MUST fail explicitly.

File storage, maps, AI, notifications, queues, and integration delivery are host facilities, not
ambient globals. A workspace MUST declare every required facility in its manifest. Missing declared
facilities MUST fail the startup gate or invocation with a bounded error; tests MUST NOT substitute a
no-op provider. PostgreSQL change-feed `NOTIFY` is not user notification delivery.

## 8. Browser client

The generated `$pod/client` is the only tenant application data API. Its collection reads are live;
its create/update/delete operations use the sync mutation protocol; its remotes and pipelines use
typed runtime endpoints.

The client MUST keep the last trustworthy value visible during refresh or background work. Errors
MUST be surfaced without converting an existing result into an empty state. Query identity MUST be
stable under object-key ordering.

A command that changes collection state MUST provide read-your-command behavior. When the command
commits through an outbox-backed server path, its generated client operation MUST wait for the
returned outbox watermark before resolving, with only a bounded authoritative root-record read as a
fallback. Invalidating a query over an unchanged replica is not synchronization.

A reopened persisted replica is complete only at its saved cursor, not at the current server head.
The client MUST remain server-first until its live feed crosses the head observed for that document;
only then may restored residency make arbitrary local reads authoritative.

The complete replica, consistency, and mutation behavior is defined by
[SYNC_ENGINE.md](./SYNC_ENGINE.md).

## 9. Workspace shell and startup

The host-served document selects the organization and immutable workspace bundle. Pod's bootstrap
then supplies manifest, app navigation, requestor/team policy facts, and replica metadata.

Optional host decoration MUST NOT block the Pod bootstrap. In particular, billing/provider lookups
load after workspace first paint. A warm target runtime SHOULD reach an interactive workspace within
one second; timing tests MUST measure the user-visible boundary, not only an internal function.

Fatal bootstrap failures MUST render a bounded error state. The shell MUST NOT remain indefinitely on
“Preparing your workspace”.

## 10. Navigation and state

Applications are discovered from authored `+*.svelte` files and rendered only from the active
workspace manifest. URL state owns shareable navigation; component state owns ephemeral interaction.
See [NAVIGATION_STATE.md](./NAVIGATION_STATE.md).

A leaf component MUST NOT create a second query for records already owned by its parent. Relationship
labels require an explicit relationship renderer and option set; UUIDs are otherwise rendered as
identifiers, not resolved through hidden per-cell network requests.

## 11. Compatibility and failure rules

Pod does not promise compatibility for generated internals. Public package exports, authored file
conventions, committed migration behavior, host bindings, and documented wire protocols are the
compatibility surface.

Failures MUST preserve truth:

- missing infrastructure fails tests/startup;
- a partial collection is never presented as complete;
- an invalid resume cursor rebuilds rather than skips data;
- a rejected optimistic mutation rolls back;
- an organization or epoch change discards incompatible local state;
- an optional provider failure does not prevent the workspace from rendering.

## 12. Acceptance pillars

Pod is complete only when these pillars pass:

1. authoring/compiler topology and generated types;
2. runtime isolation, identity, facility gate, and hosted/standalone parity;
3. collection authority: policy, hooks, approvals, history, audit, and write guard;
4. sync correctness, offline/reload behavior, scale, and real SSE transport;
5. remotes, pipelines, automations, integrations, and notifications where declared;
6. workspace shell, application discovery, navigation, and organization isolation.

The exact suite ownership and duplicate-test policy are in [`tests/README.md`](../tests/README.md).
Docker-backed coverage is mandatory and MUST fail, not skip, when its infrastructure is unavailable.
