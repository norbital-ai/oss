# Core refactor: what Core must change to match this Pod

Pod moved authentication, policies, and (in progress) the agent into the OSS package. Core was
deliberately **not edited** while that happened, so this file is the complete list of what Core owes.
Nothing here is optional if Core is to run against this Pod — several items are breaking.

Written from the Pod side. Every claim below points at a real symbol in this repository, so a Core
change can be checked against it rather than against memory.

---

## Breaking changes Core must absorb

### 1. `queue` is a real facility

`HostSchedulerConfig` is gone. `bin/invocation/scheduler.ts` is gone.

- Pod now derives its whole job set from the manifest: `workspaceJobs()` in
  `src/lib/bin/invocation/jobs.ts` returns one job per scheduled automation, one per configured
  outbox, and one for event tailing. Each job has a `name`, a `schedule` (a five-field cron
  expression, or `'continuous'`), and a `run()`.
- A host supplies `queue: HostQueue`, which receives that job set and returns a stop function. The
  host owns timing, persistence across restarts, and the guarantee that **one job name never overlaps
  itself** — an overlapping outbox drain claims the same rows twice.
- **Core action:** register the job set with pg-boss instead of relying on Pod to sweep. Core already
  has a `schedule` table and a queue supervisor; the change is to drive Pod's jobs from it.
- `satisfiedFacilities()` now keys off the binding's presence, so a host cannot claim `queue` without
  supplying one. A workspace with automations refuses to boot otherwise.

### 2. `maps` is no longer implied by a `geolocation()` field

`requiredRuntimeFacilities()` no longer returns `maps` for a geolocation column. The stored value is
self-contained; only edit-time autocomplete and static-map rendering need a provider, and those
validate when called.

- **Core action:** none required, but Core may now serve geolocation-holding tenants without a maps
  key. Keep supplying `maps` for the picker.

### 3. Roles are tiered: `admin | advanced | basic`

`UserRoleSchema` in `platform-utils/src/system/types.ts` replaced `admin | member`.

- **Core action:** migrate existing `member` rows to `basic`. `advanced` is new and no code branches
  on it — it exists to be billed and to be referenced by policies.
- Anything in Core typing a role as `'admin' | 'member'` must widen. `TUserRole` is exported.

### 4. Two new system collections, both client-opaque

`invitation` and `host_event_outbox` are in `SYSTEM_COLLECTION_NAMES` and the tenant schema.

- Both are refused by `collection_permission.guard.server.ts` for **every** role, including admin.
  Every other deny there is policy-driven and an admin short-circuits it, so without the explicit
  check an admin session would replicate token hashes and subject digests into a browser.
- **Core action:** do not add a policy granting on either. Reach them through the host-command plane.

### 5. `publicUrl` is required on a self-hosted host

Not applicable to `mode: 'core'` directly, but Core must supply the equivalent per tenant when it
issues the `provision` command — an invitation link has to be absolute and its token travels by email,
so there is no request to derive an origin from.

### 6. Binding and manifest shapes changed without being written down

Found by typechecking Core against the current Pod. Each one breaks Core today; none were listed.

| Symbol                      | Change                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| `HostFileStorageBinding`    | lost `presignPut` / `presignGet`                                     |
| `HostAiBinding`             | lost `infer`                                                         |
| `AiChatInput`               | lost `temperature`                                                   |
| `AiChatResult`              | gained a **required** `stopReason`                                   |
| `NotificationDeliveryInput` | renamed `NotificationDelivery`, and the result shape changed         |
| manifest `automations`      | lost `enabled`, `cron_schedule`, `created_by_user_id`, `description` |
| manifest automation `spec`  | lost `agentProfileId`                                                |

### 7. `queue` needs more than a binding

`workspaceJobs()` is now exported from `@norbital-ai/pod/host` — it previously was not, which made
`queue` a facility no host could satisfy, since the contract hands the host a job set it had no way to
obtain.

Two things still block a host from driving it, and both are Core-side:

- `QueueJob.run()` goes through `handlePodHostCommand`, which is deliberately unreachable from
  `handlePodRequest`. Core's frame sender speaks `request` / `notify` / `cancel` / `binding` — there is
  no `host-command` sender.
- **Automations are already dead against this Pod, not merely unported.** Core's
  `AutomationRunDispatcher` POSTs to `/_runtime/runtime/run`, which is not in
  `RUNTIME_ENDPOINT_HANDLERS`.

---

## What Core must delete

| Remove                                                                                                       | Why                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| better-auth entirely — the `organization` plugin, `emailOTP`, redis session storage, the drizzle adapter     | Pod owns authentication                                |
| System-DB `invitation`, `session`, `account`, `verification` tables                                          | Pod owns the directory and credentials                 |
| `lib/access_control/auth/*` — `auth.server`, `auth.client`, `auth_redis`, `cookies`, `session`, `encryption` | superseded                                             |
| `(auth)/login`, `(auth)/accept-invite`, `(auth)/email-otp/callback`                                          | Pod ships these pages as runtime surfaces              |
| `org_settings/members_pane.svelte`                                                                           | membership moves to Pod's tenant configuration surface |
| `lib/agent/**` except channel transports and the sandbox tools                                               | Pod owns the agent loop (in progress — see below)      |
| `routes/(workspace)/_components/agent/**`, `routes/api/agent/**`                                             | ditto                                                  |
| ops email allowlist                                                                                          | replaced by an `operator` table (below)                |

---

## What Core keeps, and how it changes

### Signup becomes a provisioning form

Core keeps `(auth)/signup`, but it authenticates nobody:

1. Public form takes organization name, admin email, template key. No session created.
2. Core creates the `organization` row (Stripe customer) and provisions the tenant DB and runtime.
3. Core **verifies the runtime has a `messaging` binding and a `publicUrl`** — otherwise the founding
   invitation cannot be delivered, and provisioning must fail loudly rather than strand a tenant that
   nobody can ever enter.
4. Core issues one host command:
   `{ kind: 'provision', adminEmail, publicUrl }`.
5. **Pod** mints the invitation — generates the token, stores only its hash, sets single-use and an
   expiry — and sends it over `messaging`.
6. Core redirects to a **tokenless** "check your email" page. Core never generates, sees, stores, or
   transmits the token, so it cannot appear in a redirect URL.

Core creates an **invitation, not an account**. That is what makes step 2 safe without verification: a
freshly provisioned tenant admits nobody until Pod proves the address, so an unverified signup costs
resources and never grants access. Abuse is a rate-limit and captcha problem, not an auth problem.

### Ops keeps its own credential space

`(ops)/ops` stays in Core and must keep working when a tenant is broken, so it cannot live inside a
workspace. But it gets **no second auth implementation**: build it from Pod's primitives.

```ts
import { cookieSession, emailOtpIdentity } from '@norbital-ai/pod/host';

const operatorSessions = cookieSession({ secret: env('OPS_SESSION_SECRET') });
const operatorLogin = emailOtpIdentity({
	sessions: operatorSessions,
	secret: env('OPS_SESSION_SECRET'),
	organizationId: 'operators',
	organizationName: 'Norbital Operations',
	deliver: /* Core's mailer */
});
```

Separate `operator` table, separate cookie, separate secret. An operator is not a workspace user, has
no organization, cannot be invited, and there is no self-service signup — operators are seeded out of
band. Infrastructure auth in front (reverse-proxy IdP, mTLS) remains recommended as defence in depth.

### Billing consumes seat snapshots

Pod publishes membership events to `host_event_outbox`, drained through the `queue` facility with the
same claim/ack/fail protocol as the other outboxes.

```ts
{ eventId, observedAt,
  event: 'membership.changed',
  reason: 'invite_accepted' | 'user_removed' | 'user_deactivated'
        | 'user_reactivated' | 'role_changed',
  subject_hmac,                                  // keyed digest, never the address
  seats: { admin: 3, advanced: 12, basic: 40 } }  // authoritative, billable only
```

- **Apply the snapshot, never a delta.** The outbox is at-least-once, so a redelivered "+1 seat" would
  double-bill. Applying the same snapshot twice is a no-op. Settle out-of-order delivery by
  `observedAt`.
- A billable seat is `status = 'active'` **and** `kind = 'human'`, so an agent user never bills.
- `role_changed` and `user_reactivated` are billing-visible and do emit — not just create/remove.
- Reconcile periodically with the trusted-host `{ kind: 'identity', action: 'seats' }` command rather
  than billing from an event stream alone.

### The organization selector

Core keeps a routing index of `hmac(email) → org_ids` — no address, name, role, or credential. Keep it
current from `host_event_outbox`; rebuild any tenant's slice with
`{ kind: 'identity', action: 'membership' }`.

Switching workspaces uses the verified-subject form of `HostIdentity`: Core asserts
`{ subject: { email } }` and the target Pod resolves it against its own directory, honouring a pending
invitation. `TenantWorkspaceShellData.userOrganizations` already carries the list into the pod shell.

### Facilities Core supplies

| Facility              | Notes                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                  | unchanged                                                                                                                                                                                                                                                                                                                                                                    |
| `fileStorage`         | unchanged                                                                                                                                                                                                                                                                                                                                                                    |
| `ai`                  | Core's, on `@tanstack/ai`, OpenRouter default. Pod ships **no** ai adapter                                                                                                                                                                                                                                                                                                   |
| `maps`                | replace Core's inline Google implementation with Pod's `googleMaps({ apiKey, region })`                                                                                                                                                                                                                                                                                      |
| `messaging`           | renamed from `notifications`. Channels and transports are **methods**, not fields or a record — `listChannels()`, `listTransports()`, `sendVia(transport, message)` — because a binding crosses the isolate as a proxy that forwards method calls, and a data field arrives there as a function. Supply `whatsapp` (socket + `node:fs` auth state) as a `MessagingTransport` |
| `queue`               | pg-boss, driving `workspaceJobs()`                                                                                                                                                                                                                                                                                                                                           |
| `integrationDelivery` | unchanged                                                                                                                                                                                                                                                                                                                                                                    |
| `agentTools`          | re-expose `coding.tool.ts` / `deployment.tool.ts` as `HostAgentTool`s pointed at the sandbox                                                                                                                                                                                                                                                                                 |

`googleMaps` is already ported into `packages/pod/src/lib/host/maps.ts`, including the fit-to-markers
zoom derivation. Core's copy in `tenant_runtime/bindings.ts` should be deleted in favour of it.

### Host plugins

Pod now has the contract, so `CORE_HOST_PLUGINS` has somewhere to go. `HostAppPlugin` is pure data
(`key`, `label`, `icon`, `entry`, `placement`, `adminOnly?`) and lives in
`platform-utils/src/runtime/binding.ts`.

- **Core action:** send one `{ t: 'configure', hostPlugins }` frame per container, before the first
  request. Core's Workspace Studio and organization-settings entries become plugin records pointing at
  their existing Core routes.
- The agent **leaves** that list — it is a normal pod capability now, not a host surface.
- `entry` must be site-relative or `https:`; `assertHostPlugins()` is exported so Core can validate its
  own set at startup rather than shipping a bad link to every tenant.
- Do **not** put plugins in a request header. The billing summary travels that way and a browser can
  forge it; a forged plugin puts an attacker's link under Core's own label in the sidebar. Pod reads
  them only from the `configure` frame, never from a request.
- Hiding an `adminOnly` entry is presentation only. Core's routes must still authorize their own
  requests — the URL is in the markup.

---

## Not yet done in Pod

Listed so Core does not plan against something that is not there.

|                                                                             | State                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------- |
| Agent runtime port (loop, store, transcript, chat, channel authoring, UI)   | **done** — see [AGENT_PORT.md](./AGENT_PORT.md) |
| `+<name>.channel.ts` authoring and the `messaging` facility rename          | **not started**                                 |
| `HostAppPlugin` / `buildSystemNavigation`                                   | **done** — Core can send `configure`            |
| Tenant configuration sidebar (teams, users, invitations, policy assignment) | **not started**                                 |

Until the agent port lands, Core's `lib/agent/**` stays authoritative and the deletions above do not
apply to it.

---

## Checklist

Ordered so each item is verifiable when it lands. Tick nothing that has not been run.

### A. Policies become declarations (OSS, then Core)

Core seeds policies today; Pod declares them. Both cannot be true. Measured state:

All five templates now declare their policies. The seed steps still exist and are still the source of
truth on a live tenant until A6 deletes them.

| Template       | Core seed step            | Pod declaration                        |
| -------------- | ------------------------- | -------------------------------------- |
| `bca`          | 147 lines, 2 policies     | 2 policies, 49 grants                  |
| `construction` | 67 lines, 3 policies      | 3 policies, 36 grants                  |
| `norbital_hr`  | 369 lines, **3** policies | 3 policies, 140 grants (`hr-payroll/`) |
| `crm`          | none                      | `+sales_rep.policy.ts`                 |
| `reclamation`  | none                      | 1 policy, 9 grants (new, not a port)   |

The `norbital_hr` row previously read "1 policy (generated)". It is three — `HR`, `Management`, and
`Employee` — and only the first two are generated.

- [x] **A1. Resolved — the premise was wrong, and A2–A5 are unblocked.** `${requestor.norbital_id}` is
      bound at **evaluation** time, not seed time: the seed stores the literal token in single-quoted
      strings and only does parameterised inserts. See `docs/POLICY_SUBSTITUTION.md`.
      **Use `$sql`, never `RAW`.** `RAW` is a function, so it does not survive storage and the grant
      lands unconditional; `definePolicy` now refuses it.
- [x] **A2. Done.** `bca_controller` (36 grants) and `bca_contractor` (13, all conditional) declared in
      `template_workspaces/bca/src/policies/`, keeping the seed's keys so reconciliation upserts the
      existing rows rather than orphaning `team.policy_id`. Verified by booting standalone: migrate
      logged `policies reconciled (2 created, 0 updated)` and all seven `$sql` strings read back out of
      jsonb byte-for-byte identical to the seed.
- [ ] **A2a. Approvals drag a Core seed UUID into public template source.** A gated grant carries
      `teams_that_can_approve`, which holds `team.norbital_id` — and teams have no declarative
      counterpart, so the id is unchecked by anything and unsatisfiable under `pod start`, where no team
      rows exist. `approval` is typed `Record<string, unknown> | null`, so its shape is not checked
      either: a misspelled key compiles and fails at request time with a 400. Either teams become
      declarable or approvals need a name-based reference.
- [ ] **A2b. The `RAW` guard does not run in the way policies are actually written.** A1 records that
      `definePolicy` refuses a function-valued condition, and it does — but every policy file in this
      repository is `export default { … } satisfies Policy`, which never calls it. Nothing else on the
      path checks: the compiler imports the default export and stamps a key on it
      (`vite/compiler/index.ts`), and `reconcileDeclaredPolicies` `JSON.stringify`s the grants, which
      is exactly where a `RAW` callback disappears. `RAW` is still a member of `SchemaWhere`, so
      `where: { RAW: (t, ops) => … }` typechecks in a policy today and lands as `conditions: {}` —
      unconditional. The guard belongs in the compiler, or `RAW` belongs out of the policy `where`
      type. The runtime consequence is unchanged since A1 wrote it down; what is new is that the stated
      mitigation does not fire. **Demonstrated, not inferred:** a `where: { RAW: (t, ops) => … }` added
      to `construction`'s `defects` read grant compiled with 0 errors, reconciled without complaint,
      and stored `conditions: {}` — the whole collection, readable.
- [x] **A3. Done.** Three policies in `template_workspaces/construction/src/policies/`, 12 unconditional
      read grants each, differing only in `apps`. Keys match the seed's. Booted standalone: migrate
      logged `policies reconciled (3 created, 0 updated)`; all three rows read back with 12 grants and
      the right single app; no grant carries conditions, which is also true of the seed.
      The seed shared one `readGrants` array across all three records; the declarations repeat it,
      because `src/policies` admits only `+<name>.policy.ts` — a shared module beside them is a
      `POLICY_NAME_INVALID` diagnostic.
- [x] **A4. Done.** Three policies in `template_workspaces/hr-payroll/src/policies/` — `HR` (79 grants),
      `Management` (35), `Employee` (26, 14 of them conditional) — with the collection groups kept as
      generation, in `src/lib/policy_grants.ts`. Booted standalone: `policies reconciled (3 created,
  0 updated)`, grant counts 79/35/26 exactly matching the seed, every `$sql` string stored with its
      literal `${requestor.email}` token, and **all eleven approval steps read back with the seed's
      `norbital_id`, derived step id, and `teams_that_can_approve` unchanged**.
      Two things the port surfaced, both recorded below as A4a and A4b. A third was fixed on the way:
      `apps` was bound to the generated `AppName` union, which lists only leaf ids, so no policy could
      name the `hr_controller` **group** that `appAccessAllowed` has always honoured as a prefix.
      `PolicyAppName` now derives group names from the same union, so `hr_controller` compiles and
      `hr_controler` does not.
- [ ] **A4a. Blocking for Core: the seed's policy keys cannot be reproduced.** A policy's key is its
      filename, and the compiler requires `+<lower_snake_case>.policy.ts`. `norbital_hr`'s seeded keys
      are `HR`, `Management`, and `Employee`, so the declarations land as `hr`, `management`,
      `employee`. Reconciliation upserts by key, so on an existing tenant this **inserts three new rows
      and leaves every `team.policy_id` pointing at the old ones** — precisely the orphaning the
      key-preservation rule exists to prevent. Core must run `UPDATE policy SET key = lower(key)`
      before A6 deletes the seed. (`construction` and `bca` are unaffected; their keys are already
      lower_snake_case.) The alternative — letting a policy declare an explicit `key` — was not taken,
      because it reintroduces the identity drift the filename convention removed.
- [ ] **A4b. The seed derives colliding approval step ids, and the port preserves them.** Every step id
      is `configId.slice(0, -1) + '9'`, so `…0004`, `…0007`, `…0009`, and `…000a` all yield step
      `…0009` — four distinct approval configs inside the `HR` policy share one step id, and the same
      happens in `Management` and `Employee`. Kept verbatim, because an in-flight `approval_request`
      resolves against these ids and changing them strands it. It needs fixing with a migration, not in
      a port.
- [x] **A5. Done.** `template_workspaces/reclamation/src/policies/+reclamation_estimator.policy.ts` —
      9 grants, 4 conditional. A decision, not a port: reclamation had no policy in either repository.
      **No collection carries an owner column** (no `owner_id`, `user_id`, or `created_by`), so there is
      nothing to scope to the requestor; a reclamation project is a shared workbook and inventing an
      owner column to enable requestor scoping would be changing the schema to justify the rule. The
      narrowing is by what a row is instead: the rate matrix is read-only, a `reconstruction` document
      is not writable because the stitch hook reads it, and an `issued` or `superseded` estimate is not
      editable. Booted standalone: `policies reconciled (1 created, 0 updated)`, 9 grants, both `$sql`
      strings stored intact.
- [ ] **A6.** Delete each `seed/<template>/steps/policies.ts` and its `index.ts` wiring, **only after**
      the matching declaration reconciles. All five now do (A2–A5), so this is unblocked — but do A4a
      first for `norbital_hr`, or the deletion strands three policies' worth of team assignments.
      `reconcileDeclaredPolicies()` upserts by key and never deletes undeclared rows, so a stale seeded
      policy lingers silently — remove it deliberately.
- [ ] **A7.** ~~Delete `team.ts` where it only holds `policy_id`.~~ **Corrected:** no such file exists.
      Every `team.ts` carries names, descriptions, `is_active`, and (in `norbital_hr`) a three-level
      hierarchy, and its ids are imported by each `user.ts`. A7 reduces to dropping the `policy_id`
      value and its `dependsOn` edge.

### B. Channels

- [x] **B1. Done.** The facility is `messaging` everywhere — `HostMessagingBinding`,
      `RuntimeFacilityBindings.messaging`, `RuntimeFacilityName`, `satisfiedFacilities`,
      `requireRuntimeFacility('messaging')`, `messagingProviders`/`consoleMessaging`, and the
      standalone runner's wiring. **Transports are not a record.** `RuntimeFacilityBindings` reach a
      tenant runtime through the proxy in `runtime/serve.ts`, which traps every property get and
      returns a call forwarder, so a data field arrives as a function and a record of functions does
      not survive the structured clone at all. They are `listTransports(): Promise<readonly string[]>`
      and `sendVia(transport, message)` instead — method calls, which is the only thing that boundary
      carries. **The pre-existing `channels` field is fixed too** — it is
      `listChannels(): Promise<readonly string[]>`. It was read inside the isolate in two places, and
      the two failed differently: `hook-api.server.ts` handed it to
      `assertNotificationChannelSupport`, where `new Set(fn)` threw
      `TypeError: function is not iterable`, so under Core _every_ external notification failed with
      an error naming neither the channel nor the facility; `invitation.server.ts` read
      `channels[0] ?? 'email'` off the same function, got `undefined`, and silently addressed the
      founding invitation to `email` whatever the host actually advertised. No binding on
      `RuntimeFacilityBindings` — `db`, `fileStorage`, `ai`, `messaging`, `maps` — carries a data
      field now, and `tests/runtime/facility-binding-shape.test.ts` keeps it that way with a
      type-level assertion that fails `pnpm lint` naming the offending property, plus a runtime check
      that drives `messaging` through the real `facilityProxy` from `runtime/serve.ts`. `queue`,
      `integrationDelivery`, and `agentTools` are host-side and never cross the proxy;
      `HostAppPlugin` is deliberately pure data and crosses on the `configure` frame instead.
- [x] **B2. Done.** `assertChannelTransportsAreSupported` in `authoring/channels/channels.ts`, run by
      `startStandalone` after the facility gate and exported from `@norbital-ai/pod/host` so Core runs
      the same check. A channel naming a transport the host does not supply refuses to boot, naming
      the channel and listing what is available — every offending channel, not just the first.
      Channels now reach the manifest (`buildChannelEntries`, `ManifestChannelSchema`), because the
      host never loads the workspace bundle and a transport name that lives only in
      `src/channels/+<name>.channel.ts` is invisible to it.
      **`pod dev` supplies the transports the workspace declares, as console loggers.** It holds no
      sockets, so the alternative was `crm` — whose `+sales_desk.channel.ts` names `telegram` — being
      unrunnable locally without Telegram credentials. The template was left alone: `telegram` is what
      that channel is, and changing source to suit the weakest host would have made the declaration a
      lie. The generosity is confined to the Core development emulation; `pod start` checks against a
      real `pod.host.ts`.
- [x] **B3. Done for one wire, end to end. Deliberately much smaller than Core's ~2,500 lines.** A
      declared channel now delivers: inbound message → agent turn under the declared policy → reply
      back over the same transport.
      **Two tenant collections**, registered in all four places: `channel_conversation` binds
      `<channel>:<external conversation>` to a `chat_session` (unique on `binding_key`, because a
      composite unique index is not expressible through `systemTable`), and
      `channel_inbound_message` is the deduplication ledger, claimed with `ON CONFLICT DO NOTHING`
      **before** the model is called, so a redelivery costs one failed insert rather than a second
      agent run, a second bill, and a second answer. `organization_id` is dropped throughout.
      **Inbound is host-driven, not a route.** `SelfHostedPodHostConfig.channels` is a
      `HostChannelListener`, host-process code exactly like `HostQueue`: it is handed a `deliver`
      function and returns a stop function. Pod serves **no** public inbound endpoint for channels —
      verifying a webhook means holding the transport's secret, the credential belongs to whoever
      holds the wire, and a tenant holds none. Delivery reaches the runtime over the private
      host-command plane (`{ kind: 'channel', action: 'inbound' }`), which `handlePodRequest` cannot
      reach, so no tenant request can make the agent answer as a channel.
      **The policy is the point, and it is enforced.** `reconcileDeclaredChannels` (exported from
      `@norbital-ai/pod/host`, run beside `reconcileDeclaredPolicies` at migrate) gives each channel a
      `kind='agent'` user in a team holding the declared policy. Delivery re-enters the workspace
      under that principal through the ordinary `resolveRequestorBaseScope`, so a channel gets the
      same enforcement a signed-in user gets — proven by an agent tool call being refused on a
      collection the policy does not grant.
      **Outbound** is `messaging.sendVia(transport, message)` from inside the runtime.
      **Telegram is built in**, both halves: `telegramBot()` returns a `MessagingTransport` and a
      `HostChannelListener`. It long-polls `getUpdates` rather than taking a webhook — an outbound
      authenticated call exposes nothing and needs no public URL, which is why it was cheap enough to
      build in at all. The offset is not persisted: Telegram redelivers what it was not acknowledged
      for, and the inbound ledger recognises the replay. WhatsApp stays host-supplied.
      **Not ported, and not pretended:** no `channel_message_archive` / `channel_history_sync` (the
      provider-history sync and its media pipeline), no `channel_contact` (linking an external sender
      to a workspace user, and the pending-message hold that goes with it), no attachments, no
      inbound batching or session commands, no group-vs-DM distinction, no streaming. Transcript
      replay is a fixed 40-message window trimmed to start at a `user` message, not a summarising
      compactor. A failed turn leaves a `failed` receipt and is **not** retried — an agent turn has
      side effects, and replaying one silently is worse than a row somebody has to look at.

### C. Core absorbs the breaking changes

Every item below is already listed above with its rationale.

- [ ] **C1.** Delete better-auth and the auth routes; Pod owns authentication. **Three traps:**
      the Stripe webhook receiver lives _inside_ `auth.server.ts`, so a naive deletion silently removes
      billing ingestion; `auth/utils/encryption.ts` is generic AES-GCM whose only consumer is the
      integration secret repository, so deleting it breaks integration secrets; and the `member` table
      is better-auth's but is not in the delete list.
- [ ] **C2.** Drive `workspaceJobs()` from pg-boss. **Correction:** there is no `schedule` table and
      `queue-supervisor.server.ts` is a liveness probe, not a job registry — the thing to change is
      `automation-scheduler.server.ts`.
- [ ] **C3.** Migrate `member` → `basic`; widen anything typed `'admin' | 'member'`.
- [ ] **C4.** Consume seat snapshots from `host_event_outbox`. **Correction:** Core already counts
      absolute rows, so delta-counting was never the bug; what changes is the _source_, since the
      `member` table dies with C1.
- [x] **C4a. Resolved — the mapping is fixed and lives in one place.** `admin` and `advanced` are both
      **builder** seats; `basic` is **standard**. Do not re-derive this in Core: call
      `billableSeats(census)` from `@norbital-ai/platform-utils/system/types`, which turns a
      `host_event_outbox` snapshot into `{ builder, standard }`. A host that mapped `advanced` to the
      cheap tier would under-bill silently and nothing in either codebase would contradict it — the
      mistake only ever surfaces on an invoice — so it is pinned by a test. The "≥1 builder seat" rule
      needs no special case: a workspace always has an admin.
- [ ] **C5.** Supply `hostPlugins` through the host contract. **Correction — and a live defect:**
      `CORE_HOST_PLUGINS` already exists and already ships to pods **in a request header**
      (`ingress.ts`), which is exactly the vector Pod's `HostAppPlugin` refuses: a settable header lets
      anyone put an arbitrary link, under Core's label, into a tenant's sidebar. Shapes differ too
      (`route`/`requiredCapability` vs `entry`/`adminOnly`). Move it off the header.
- [ ] **C6.** Re-expose sandbox tools as `HostAgentTool`; delete `lib/agent/**` the port replaced.
- [ ] **C7.** Replace Core's inline Google maps with Pod's `googleMaps()`.
- [ ] **C8.** Rebuild `(ops)/ops` on `cookieSession` + `emailOtpIdentity` with its own `operator`
      table. There is a **second** copy of the ops email allowlist in `ingress.ts` that must go too.
- [ ] **C9. Correction: `resolveRuntimeBindings` is the wrong plane.** `queue` and
      `integrationDelivery` cannot be `RuntimeFacilityBinding`s at all — bindings cross the isolate by
      structured clone and cannot carry callbacks, and `RuntimeFacilityBindings` has only five fields.
      They belong on Core's host side, mirroring `SelfHostedPodHostConfig`. `workspaceJobs()` is now
      exported so a host can obtain the job set; the remaining blocker is that Core has no
      `host-command` frame sender (see §7).
- [ ] **C10.** The `hmac(email) → org_ids` routing index does not exist. `platform_user_lookup` is a
      chat-platform mapping and is not it; build it.

### D. Prove it works

Unit and e2e coverage did not catch total auth failure in standalone. These are manual passes.

- [x] **D1. Done, and it found that outbound integrations never ran.** `toRuntimeWorkspace()` dropped
      `integrations`/`secrets`, so no outbox row was ever written and the facility gate was a no-op.
      Fixed; covered by `tests/standalone/integration-delivery-e2e.test.ts`, verified non-vacuous by
      stashing the fix. **Two gaps remain open — integrations are not finished:**
- [ ] **D1a. An HTTP `request` destination cannot be built from a filesystem workspace.** A `send`
      binding needs a `connection` registered in `defineWorkspace`'s `connections` input, but the
      compiler never emits `connections` or `env.private` — `PodStructure` has no field for them and no
      source file is scanned. Declaring one inline in `+integrations.ts` fails with "uses an
      unregistered connection"; omitting it fails with "requires a connection". `AUTHORING.md` says
      `+integrations.ts` is where the connection is declared, so the surface and the doc disagree. The
      same gap blocks `authentication`. Only a `systemEvent` destination is reachable today.
- [ ] **D1b. The inbound half has no consumers at all.** Nothing dispatches
      `{kind:'integration', direction:'receive'}` or `{kind:'system-event'}`; the handlers in
      `tenant_run.ts` are unreachable. No HTTP route accepts a `webhook` origin or verifies its HMAC,
      and `workspaceJobs()` builds jobs only from automations, so a `pull` binding's `schedule` never
      fires. A `receive` binding can never run, and a `send` with a `systemEvent` destination never
      reaches its matching `receive` — it is only handed to the host as an outbound delivery.
- [ ] **D2.** Notifications: trigger one from a hook and confirm delivery.
- [ ] **D3.** Automations: scheduled and event-triggered, both observed firing.
- [ ] **D4.** Hooks: `before` mutation and `after` derived write.
- [ ] **D5.** Policies: two users, different policies, confirm each sees only their own scope.
- [ ] **D6.** Agent: chat from the panel, tool call, transcript replay across turns.
- [ ] **D7.** A full standalone walkthrough per template, not just `crm`.
