# Integration definitions, instances and providers

A source definition declares an external system's behavior. A native `sys_integration` row is one account of that definition. The host opens its provider link, seals its credentials and carries requests, messages or feed pages into Bolt. Business projections belong to the workspace source.

## Source declarations

Author `src/integration/<name>/+integration.ts` with `integration('<name>', literal)`. The name matches the folder. Declare `description`, `driver`, optional typed `configuration`, credentials or OAuth client, and named `feeds` and `outbound` rules in the literal. Attach `test`, `feed`, `outbound`, `receive` and `send` bodies afterward. The compiler checks their declared names and requires the applicable bodies.

The driver kinds are `http`, `sqlserver`, `calendar`, `whatsapp`, `email`, `telegram`, `slack`, `discord` and `wechat`. A kind defines what requests, feed items or conversations the account supports. A host provider implements that transport; it does not contain a tenant's ERP projections, payroll rules or CRM matching logic.

An HTTP definition declares its HTTPS base URL and authentication: credential fields (bearer, header, basic) or an OAuth grant. A custom conversation uses the HTTP driver, declares its signed webhook and message kind, and attaches receive/send bodies. Its receive body maps a verified request into messages; Bolt commits them before acknowledging the webhook.

Configuration contains safe runtime settings and uses declared input fields. Credential fields belong only to HTTP and SQL Server definitions and are collected masked at pairing. A driver that grants OAuth (`http`, `calendar`) declares its client in the definition's one `oauth` slot: the client and secret by names from `src/+secrets.ts`, and for `http` the `authorize` and `token` endpoints, whose token its requests then carry. Secret values remain encrypted in the tenant store. Secrets and provider credentials do not enter guest contexts or browser status.

## Native accounts and source roles

Create and edit accounts through `sys_integration` and ordinary grants. Its fields include the definition, display name, optional owner, active flag, configuration and optional envoy. Every write decodes the configuration and fills its defaults, so each body reads a defaulted field as present; only an `optional` field without a default may be absent or null. An owner's account is personal: it synchronizes, never sends a message and never deploys an envoy; an outbound command may write back to it (a calendar's `call` driver writes events through the standing link, and the run's `{ id, set }` answer patches the record with the remote's version). Permissions must scope personal accounts to their owner and intended definitions.

A `+workspace.ts` connection declares a named default instance, for example `connections: { support: { integration: 'email', envoy: 'service' } }`. Its slot is the instance ID; the named instance cannot be deleted through the collection. Other accounts receive native IDs.

Envoy roles are immutable source declarations at `src/agent/envoy/+<name>.envoy.ts`. Pairing, pause and role deployment are properties of the runtime instance. Settings lists native accounts, creates them through the collection form, and edits their permitted fields. Teams, policy links and inline approval routes also remain source declarations.

## Collection feeds

Each feed names `into`, remote `key` fields, and its source. The target model's key combines those remote fields with one relationship to `sys_integration`, pinned by `where: { integration: { eq: '<definition>' } }`. Bolt stamps that instance FK. A feed target exposes reads and optional local update columns; the feed cannot write those local columns. Feed targets do not expose creation, deletion or custom actions.

A pulled feed declares its cron and attaches `read(cursor, ctx)`. Return changes, cursor, `more`, optional snapshot boundary, retention loss or health. A page's rows, markers and cursor commit together. A lost history starts a new snapshot; its final page reconciles missing rows through `removed`. Replayed identical data does not bump record revisions.

A driver feed declares `from: 'driver'` and attaches `map(items, ctx)`. Calendar feeds receive normalized `CalendarEvent` items, including the original provider event in `source` for attendees, recurrence and authored business rules. A messages feed uses `from: 'messages'` and receives the definition's stored conversation messages. A configuration field of text-many values can partition a feed, giving each calendar its own cursor. Dropped partitions release progress while retaining their existing rows.

Feed bodies receive the instance, partition, decoded configuration and trusted reads. Their only writes are returned changes. `removed` decides whether a disappearance deletes a row or patches its source fields, such as a cancellation status. Collection toolbars invoke the actual `<definition>.<feed>` run.

SQL Server CDC retention, bootstrap, identities, header/line assembly and verify-first business commands are authored in the Trading Operations definition. The shared SQL Server driver executes bounded parameterized statements and transactions; Bolt contains no Kingdee-specific database interpretation.

## Outbound rules and requests

An outbound rule names its collection, create/update trigger, optional condition, instance route and optional version field. Bolt queues the delivery in the record's effective commit, after any required approval. Its build body reads the committed row and returns a message, command payload or `null` to skip. Non-conversation rules attach a run body, which receives the immutable idempotency key and uses its instance request. Conversation rules can attach delivery event handlers to patch the business row.

Automations `yield* ctx.request(instance, operation)` for external HTTP or database work. Integration bodies use their instance's `ctx.request(operation)`. Either fails with a `FacilityFailure`, or `Unavailable` while the instance is unpaired. The host resolves credentials and enforces the definition's transport. Any external computation that later updates a previously read record must carry its observed revision to `ctx.act`; a stale response must not overwrite a newer edit.

## Host and browser contracts

A host registers its providers; `@norbital-ai/bolt-server` exports `drivers()` as the shared host provider list. The engine's `Links` service holds each session link in the activation's scope, opened with the instance's sealed credentials, the workspace's secrets and its public URL; closing that scope closes every link. A committed change of an instance follows to its session link (`Links.changed`): a pause or a delete closes it, a resume opens it, a changed configuration reopens it with that. Credentials use AES-GCM and the instance's epoch fences writes from replaced links; a request link writes under the epoch it read and moves it, so of two concurrent calls (two refreshes of a rotating OAuth token) the second to write is fenced. A fenced write stops its link for good; any other credential write retries until it lands, outside compute admission.

The driver contract (`Provider`, `Link`, `DriverOpen`) stays Promise + AbortSignal + JSON, because providers come from the host's module graph. A provider written as Effects crosses it through `toDrivers(defs, run)` (`@norbital-ai/providers/abi`) on the host's runner, and the engine adapts it once (`src/engine/integrations/abi.ts`): interrupting a call aborts the provider's signal, and every answer is decoded. Each provider opens a `Link` from `DriverOpen`. It reports durable status, ephemeral pairing data, inbound messages or invalidations, and implements its applicable request, send, read, discovery, webhook and renewal operations. The instance endpoint is `/__bolt/integrations/<instance>`; pairing, unpairing, test, discovery and stream use that ID. Webhooks route under `/hooks/integration/<instance>`; a custom conversation's are verified there with its credential field, never in the guest. Every OAuth sign-in returns to the one `/hooks/oauth/callback`, routed to its instance by the `state` that `DriverOpen.state()` mints, so an OAuth app registers one redirect URI for every instance.

The browser uses `bolt.integration(instance)`: status, pair, unpair, test and discover are Effects and watch is the status Stream, each answer decoded at the trust boundary. The page SDK's transport and the tenant base path apply to each request." `GET /__bolt/integrations/` lists each definition with the providers this host offers for it (personal and workspace); a provider whose sign-in needs an OAuth client neither the definition nor the host configures is marked `available: false`. It never returns secret values.

An optional `+integration.svelte` supplies the definition's setup component through the lazy `integrationSetups` registry. Its props carry the instance's status and `pair`, `unpair` and `test` as Effects that never fail (a refusal arrives as `error`), run with `fork`. Otherwise `IntegrationSetup` renders the provider's setup metadata, pairing and connected view. Source declarations do not duplicate provider authentication protocols.

## Calendar driver

A `calendar` definition pushes `CalendarEvent` items through a `from: 'driver'` feed, partitioned by a text-many configuration field so each calendar keeps its own cursor. Its link announces a changed calendar as an invalidation; the feed run then reads that partition from its cursor, and a read whose history is gone (`retained: false`) starts a fresh snapshot. The link renews expiring watches through `renew()` and receives the account's push notifications through its own `webhook`, acknowledging one only after the engine has queued the read. All-day events keep their dates; timed events keep their instants and source zones. How a provider registers and verifies its watches and keeps its sync position belongs to that provider, and a template's calendar screens to that template.

On HTTP loopback hosts, Google cannot deliver public push notifications. Its provider uses the same renewal owner to enqueue native feed invalidations every five minutes; persisted partition cursors make those reads incremental. Pausing or closing the link stops that refresh. Public HTTPS hosts continue to use authenticated watches.

## Verification

Use native collection forms and HTTP authorization probes for instance creation, configuration, deletion and role immutability. Exercise feed pagination, duplicate pages, cancellation, expired history, cursor failures and restart; outbound probes cover approval timing, idempotency and provider delivery events. Provider callback tests cover forged state/tokens, notification-before-registration, replay and renewal. Inspect the actual template UI at desktop and narrow widths and verify that private account data remains invisible to other members.
