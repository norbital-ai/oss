# Integration definitions, instances and providers

A source definition declares an external system's behavior. A native `sys_integration` row is one account of that definition. The host opens its provider link, seals its credentials and carries requests, messages or sync pages into Bolt. Business projections belong to the workspace source.

## Source declarations

Author `src/integration/<name>/+integration.ts` with `integration('<name>', spec)`. Its name
matches the folder. The literal contains the driver, typed configuration, credentials or OAuth,
`webhook: { verify }`, optional `rate`, and an inline `test` callback. The models declare what is
exchanged under their own `syncs`; see [syncs](./syncs.md).

The driver kinds are `http`, `sqlserver`, `calendar`, `whatsapp`, `email`, `telegram`, `slack`,
`discord` and `wechat`. A host provider implements the transport, pairing and conversation codec.
It contains no tenant ERP projections, payroll rules or CRM matching logic. HTTP definitions
supply HTTPS base URL and credential-based authentication or OAuth. Verified webhook deliveries
are stored and wake the connection's model sync reads.

Configuration contains safe runtime settings and uses declared input fields. Credential fields belong only to HTTP and SQL Server definitions and are collected masked at pairing. A driver that grants OAuth (`http`, `calendar`) declares its client in the definition's one `oauth` slot: the client and secret by names from `src/+secrets.ts`, and for `http` the `authorize` and `token` endpoints, whose token its requests then carry. Secret values remain encrypted in the tenant store. Secrets and provider credentials do not enter guest contexts or browser status.

## Native accounts and source roles

Create and edit accounts through `sys_integration` and ordinary grants. Its fields include the definition, display name, optional owner, active flag, configuration and optional envoy. Every write decodes the configuration and fills its defaults, so each body reads a defaulted field as present; only an `optional` field without a default may be absent or null. An owner's account is personal: it synchronizes, never sends a message and never deploys an envoy; a remote sync may write back through it using the standing link and return the acknowledged remote identity/version. Permissions must scope personal accounts to their owner and intended definitions.

A `+workspace.ts` connection declares a named default instance, for example `connections: { support: { integration: 'email', envoy: 'service' } }`. Its slot is the instance ID; the named instance cannot be deleted through the model. Other accounts receive native IDs.

Envoys are tenant rows in `sys_envoy`: name, audience, policy handles, the supplementary `task`, group/delegation/triage/DM policy and active state. Settings → Envoys creates an envoy (step one), then its card offers the conversation channels the host or a tenant integration definition provides (step two). A connector creates the `sys_integration` account with `envoy` set to the row id and pairs it; the sheet edits the permitted instance fields. Source envoys at `src/agent/envoy/+<name>.envoy.ts` remain supported as declared defaults; a tenant-created envoy does not need a source file. Credentials never enter `sys_envoy` or any readable model field: `sys_integration` owns the link and `bolt_credential` seals the secret. Generic accounts and member-owned connections belong to a workspace integration app, not the built-in shell. Teams, policy links and inline approval routes remain source declarations.

An envoy answers a chat like a person. Every chat message it may answer (a DM, or a group message that mentions, replies to or names it; email never) is held until the sender has been quiet for 2 s, at most 6 s after the burst's first message, so one reply covers the whole thought. A provider that reports the sender typing (`emit({ kind: 'presence', thread, typing })`) pushes the decision out within that cap. Where the envoy's `triage` covers the conversation and the host binds `sys_1`, the decider then answers, waits briefly or, in a group, ignores; otherwise the burst is admitted as it is. While a turn runs, a DM steers it at once; in a group only an addressed message does, so chatter stays out of the agent's context. Ignored and unanswered messages stay in the conversation (the panel shows them as asides), and the agent reads them with `read_messages`. The chat shows typing from the hold (DMs, and addressed group messages) and through the turn, renewed every 10 s until the first reply ships; an ignore or a turn that ends without a reply sends `typing(to, signal, false)`. A provider's `typing(to, signal, on)` turning on may also mark the chat's received messages read.

## Model syncs and requests

Models own remote `read` and `write` callbacks, their cursors, partition configuration, identities
and fields. Read pages commit their rows and progress atomically; snapshot completion reconciles
missing rows. Returned source fields are sync-owned and local fields remain locally writable.
A driver's invalidation or verified webhook wakes the matching reads; periodic reads catch up if
a hint was lost. Calendar items preserve provider source data for authored business interpretation.

A sync's `write` runs for committed local changes, after approval. It receives `op`, `row`, `changed`,
`$id` and `$version`, returns acknowledged identity/version, or `null` for a local-only change.
The transactional outbox owns idempotency, retry, ordering, conflict rollback and dead letters.
It never echoes writes made by that sync. The view toolbar starts the model's `<model>.sync.<name>`.

Automations `yield* ctx.request(instance, operation)` for HTTP or database work. Remote sync and
integration-test bodies use their own instance's `ctx.request(operation)`. A request fails with
`FacilityFailure`, or `Unavailable` while unpaired. Credentials stay in the host link. Any external
computation that later updates a previously read row must carry its observed revision to `ctx.act`.
SQL Server requests are structured `DatabaseRequest` programs: `values`, `read`, `call`, CDC metadata/pages,
and `insertOnce`. A workspace declares qualified tables, projected columns, filters, precise decimal/date
formats and its delete policy; Store compiles the native SQL on the host. CDC pages retain current-row and
tombstone reconciliation with an inclusive LSN/sequence/operation/key cursor. `insertOnce` uses an immutable
key/fingerprint, a five-second native transaction lock, one serializable header/child/procedure batch and an
exact receipt. Remote procedure calls name a procedure and typed arguments, sent through native RPC.
Driver cancellation, row/byte
bounds, TLS identity and network admission apply to every compiled program. Source retention policy and
business interpretation stay in the workspace.

```ts
yield *
	ctx.request({
		op: 'read',
		table: { schema: 'accounting', name: 'products' },
		columns: ['code', 'name'],
		where: { active: true },
		maxRows: 100
	});
```

## Host and browser contracts

A host registers its providers; `@norbital-ai/bolt-server` exports `drivers()` as the shared host provider list. The engine's `Links` service holds each session link in the activation's scope, opened with the instance's sealed credentials, the workspace's secrets and its public URL; closing that scope closes every link. A committed change of an instance follows to its session link (`Links.changed`): a pause or a delete closes it, a resume opens it, a changed configuration reopens it with that. Credentials use AES-GCM and the instance's epoch fences writes from replaced links; a request link writes under the epoch it read and moves it, so of two concurrent calls (two refreshes of a rotating OAuth token) the second to write is fenced. A fenced write stops its link for good; any other credential write retries until it lands, outside compute admission.

The driver contract (`Provider`, `Link`, `DriverOpen`) stays Promise + AbortSignal + JSON, because providers come from the host's module graph. A provider written as Effects crosses it through `toDrivers(defs, run)` (`@norbital-ai/providers/abi`) on the host's runner, and the engine adapts it once (`src/engine/integrations/abi.ts`): interrupting a call aborts the provider's signal, and every answer is decoded. Each provider opens a `Link` from `DriverOpen`. It reports durable status, ephemeral pairing data, inbound messages or invalidations, and implements its applicable request, send, read, discovery, webhook and renewal operations. The instance endpoint is `/__bolt/integrations/<instance>`; pairing, unpairing, test, discovery and stream use that ID. Webhooks route under `/hooks/integration/<instance>`: the host verifies a definition's `webhook.verify` before storing its delivery in the sync inbox; provider-specific webhooks remain the link's responsibility. Every OAuth sign-in returns to the one `/hooks/oauth/callback`, routed to its instance by the `state` that `DriverOpen.state()` mints, so an OAuth app registers one redirect URI for every instance.

The browser uses `bolt.integration(instance)`: status, pair, unpair, test and discover are Effects and watch is the status Stream, each answer decoded at the trust boundary. The page SDK's transport and the tenant base path apply to each request. `GET /__bolt/integrations/` lists each definition with the providers this host offers for it (personal and workspace); a provider whose sign-in needs an OAuth client neither the definition nor the host configures is marked `available: false`. It never returns secret values.

An optional `+integration.svelte` supplies the definition's setup component through the lazy `integrationSetups` registry. Its props carry the instance's status and `pair`, `unpair` and `test` as Effects that never fail (a refusal arrives as `error`), run with `fork`. Otherwise `IntegrationSetup` renders the provider's setup metadata, pairing and connected view. Source declarations do not duplicate provider authentication protocols.

## Calendar driver

A `calendar` definition pushes `CalendarEvent` items through a model sync, partitioned by a text-many configuration field so each calendar keeps its own cursor. Its link announces a changed calendar as an invalidation; the sync read then reads that partition from its cursor, and a read whose history is gone (`retained: false`) starts a fresh snapshot. The link renews expiring watches through `renew()` and receives the account's push notifications through its own `webhook`, acknowledging one only after the engine has queued the read. All-day events keep their dates; timed events keep their instants and source zones. How a provider registers and verifies its watches and keeps its sync position belongs to that provider, and a template's calendar screens to that template.

On HTTP loopback hosts, Google cannot deliver public push notifications. Its provider uses the same renewal owner to enqueue native sync invalidations every five minutes; persisted partition cursors make those reads incremental. Pausing or closing the link stops that refresh. Public HTTPS hosts continue to use authenticated watches.

## Verification

Use native model forms and HTTP authorization probes for instance creation, configuration, deletion and role immutability. Exercise sync pagination, duplicate pages, cancellation, expired history, cursor failures and restart; sync-write probes cover approval timing, idempotency and provider delivery events. Provider callback tests cover forged state/tokens, notification-before-registration, replay and renewal. Inspect the actual template UI at desktop and narrow widths and verify that private account data remains invisible to other members.
