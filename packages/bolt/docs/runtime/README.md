# Command surface

`dispatch.ts` authenticates an invocation and runs one binding. `commands.ts` is the only catalogue:
fixed contracts, authored `invoke.*` / `automations.*`, and the one composite plugin
`('data-browser', 'query')`. There is no second dispatcher and no `runtime/remotes.ts`.

Source: `src/runtime/dispatch.ts`, `src/runtime/commands.ts`,
`src/runtime/collections/authored.ts`. Protocol contracts live in `bolt-protocol`
(`host.ts`, `sync.ts`, `system.ts`).

---

## Origin proofs

| Origin              | Proof                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `public`            | Only `identity.sendCode` and `identity.verifyCode`. Payload claims to minted identity fail.    |
| `session-or-system` | Session cookie/header, or a valid Colony HMAC. Tenant mismatch is 403.                         |
| `system`            | Per-invocation HMAC whose subject has `system === true`. An administrator session is not this. |
| `runtime-task`      | `Invocation.Task` with an explicit Task origin rule. No person. Minted identity claims fail.   |

`subject`, `actor`, `tenantId`, `impersonatedTeam`, and `policies` are minted by the boundary.
A public Command, a Plugin and a Task that claim them are refused before contract decode; a
credentialed Command's payload has the minted keys stripped before decode.

Missing or invalid session/system proof is **401** (`DispatchError { code: 'unauthorized' }`,
message `Missing command credential`); a credential that fails authentication answers
`Credential is invalid or expired`. Tenant mismatch, refused impersonation, and
`AccessDenied` are **403**. An authenticated unknown command raises
`DispatchError { code: 'unknown_command' }`, which `app.ts` does not map to a status, so it is
reported as **500** `dispatch_failed`. There is no 404 mapping.

---

## Telemetry

Every invocation writes its runtime records to the tenant's `telemetry` collection in
OpenTelemetry-log shape — one row per turn, model call, tool call, write and failed invocation,
carrying `severity`, `event`, `attributes` and the ids that join them. Records are written in
slices of 100 while work runs and pruned to the host window (`BOLT_TELEMETRY_RETAIN_HOURS`, default
72 hours). A typed failure is a refusal logged at warning (`dispatch.refused`); a defect is logged
at error (`dispatch.failed`). Read is granted only by the built-in `bolt.telemetry` policy
(administrator-only). Source: `src/runtime/telemetry.ts`,
`src/runtime/schema/system-collections.ts`.

---

## Authored `invoke.<name>`

Exact membership comes from `RemoteRegistry` (the merged `src/functions/+<name>.ts` map). Empty,
undeclared, duplicate, or fixed-name collisions fail. The Command origin is session-or-system.

Dispatch does **not** call `AccessControl.authorize('invoke', name)`. A signed-in caller in the
tenant may reach any authored function in the release. The handler still runs as that principal, so
every collection, file, and approval check inside the function is the caller's policy.

---

## Data Browser vs other plugins

`authenticatePlugin` treats a missing credential differently for the one shipped plugin:

| Plugin           | No credential                                         | Status |
| ---------------- | ----------------------------------------------------- | -----: |
| `data-browser`   | `AccessDenied` — `trustedContext` is not a credential |    403 |
| any other plugin | `DispatchError { code: 'unauthorized' }`              |    401 |

A Data Browser call with a session may then impersonate inside the same tenant. System HMAC is also
accepted.

## Automation history

Automation outcomes are retained in the read-only `automation_run` collection for both direct
and scheduled invocations. The task queue's cleanup removes old execution envelopes without
deleting those outcomes. Authored handlers can read `api.db.automation_run` to resume deferred
work and recognise completed requests. Task inputs and credentials are not exposed by this record.

## Automation reminders

`api.notify({ key, recipients, title, body })` writes one inbox notification per recipient — user
ids or `{ team }` names, resolved to the team's members inside the insert — and queues the delivery
task in the same statement. The row id is derived from the reminder key and the recipient, so a
retry, or a later run that states the same reminder, writes nothing twice; the key is the
reminder's identity, not the run's. Hooks and functions do not receive this capability: a reminder
belongs to a durable run, never to somebody else's atomic write.

## Managed automation connections

An automation may declare one `connection: defineConnection({ baseUrl, authentication })` in its spec.
`api.connection.get({ path, query })` resolves a relative path inside that API prefix and reads the
credential through the workspace vault. Hooks and functions do not receive this capability. Each GET
uses a distinct invocation effect identity; stoppage is checked before the credential or provider call.
The response carries `status`, lower-case `headers`, and a JSON body (or text when the provider returns
non-JSON). The automation owns pagination and non-success status handling.

The default host connector performs every integration request — an automation's GET, a pull, a
send's POST/PUT/PATCH/DELETE with a JSON body — against public HTTPS addresses only, pins the checked
address and refuses transport-header overrides. It follows at most five redirects, re-checking each
hop, dropping every caller header on a cross-origin hop, and continuing a `301`/`302`/`303` answer to
a write as a bodiless GET (Google Apps Script answers that way). A host may pass `allowLoopback` to
reach `localhost`/`*.localhost` over plain HTTP — a development host's own workspaces. The complete
request has a 30-second deadline and a two-MiB body limit. A refused request is a known failure;
an unreachable or slow provider is retryable. Credentials and raw transport errors are not exposed.

A connection's `baseUrl` may be `{ env: NAME }`, so one source reaches a different system per
deployment, and `authentication` may be `{ type: 'query', name, value: { env } }` for an API that
reads nothing but the query string. An empty binding path is the root URL itself.

## Integration bindings

A receive binding with `existingOnly: true` enriches rows the collection already has: its `map`
returns only the columns that source owns, and a record whose identity matches no row is skipped. A
pull writes nothing for a record whose mapped values already equal the row, so a full re-read costs
reads only, records no history and never re-fires a send binding — which is what makes a
full-refresh pull the reliable way to keep a mirror in line.

A send binding may declare `settle({ status, body })`: the receiver's final answer as a patch on the
record it was about — the id a provider assigned, or on a refusal the reason. A delivery's
idempotency key is `<integration>:<binding>:<record id>:<sequence>`: stable across its retries,
unique across tenants and resets.

## Workspace API

Every workspace serves its collections and authored functions as HTTP under
`<origin>/__bolt/request/api`, described by `GET …/openapi.json` (OpenAPI 3.1):

| Request                                                               | Does                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `GET  collections/{name}?limit&after`                                 | one page, `{ value, next }`; `order_by=field,-field` |
| `GET  collections/{name}?updated_since=`                              | the delta read, in change order                      |
| `GET  collections/{name}?{field}=value`                               | equality on a declared column                        |
| `GET/PATCH/DELETE collections/{name}/{id}`, `POST collections/{name}` | one record; `202` when held for approval             |
| `POST functions/{name}`                                               | the authored function, `{ value }`                   |

Every call runs as its caller, so policies decide exactly what a browser with the same policies would
see. A caller is a session, or an **API key**: an `+env.ts` variable declared with
`apiKey: { policies: [...] }`, whose value (24+ characters) is presented as `Authorization: Bearer`.
It acts as `api:<NAME>` with exactly those policies and no team.
