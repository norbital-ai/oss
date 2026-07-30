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

---

## What Core must delete

| Remove                                                                                                       | Why                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| better-auth entirely — the `organization` plugin, `emailOTP`, redis session storage, the drizzle adapter     | Pod owns authentication                                |
| System-DB `invitation`, `session`, `account`, `verification` tables                                          | Pod owns the directory and credentials                 |
| `lib/access_control/auth/*` — `auth.server`, `auth.client`, `auth_redis`, `cookies`, `session`, `encryption` | superseded                                             |
| `(auth)/login`, `(auth)/accept-invite`, `(auth)/email-otp/callback`, `(auth)/link/[token]`                   | Pod ships these pages as runtime surfaces              |
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

| Facility              | Notes                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `db`                  | unchanged                                                                                                                            |
| `fileStorage`         | unchanged                                                                                                                            |
| `ai`                  | Core's, on `@tanstack/ai`, OpenRouter default. Pod ships **no** ai adapter                                                           |
| `maps`                | replace Core's inline Google implementation with Pod's `googleMaps({ apiKey, region })`                                              |
| `messaging`           | rename from `notifications`; add the `transports` record. Supply `whatsapp` (socket + `node:fs` auth state) as `transports.whatsapp` |
| `queue`               | pg-boss, driving `workspaceJobs()`                                                                                                   |
| `integrationDelivery` | unchanged                                                                                                                            |
| `agentTools`          | re-expose `coding.tool.ts` / `deployment.tool.ts` as `HostAgentTool`s pointed at the sandbox                                         |

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

| Template       | Core seed step                  | Pod declaration        |
| -------------- | ------------------------------- | ---------------------- |
| `bca`          | 147 lines, 2 policies           | none                   |
| `construction` | 67 lines, 3 policies            | none                   |
| `norbital_hr`  | 369 lines, 1 policy (generated) | none                   |
| `crm`          | none                            | `+sales_rep.policy.ts` |
| `reclamation`  | none                            | none                   |

- [x] **A1. Resolved — the premise was wrong, and A2–A5 are unblocked.** `${requestor.norbital_id}` is
      bound at **evaluation** time, not seed time: the seed stores the literal token in single-quoted
      strings and only does parameterised inserts. See `docs/POLICY_SUBSTITUTION.md`.
      **Use `$sql`, never `RAW`.** `RAW` is a function, so it does not survive storage and the grant
      lands unconditional; `definePolicy` now refuses it.
- [ ] **A2.** Port `bca` (2 policies, `$sql` subqueries — _not_ `RAW`). Verify a
      contractor sees only their own rows and an admin sees all.
- [ ] **A3.** Port `construction` (3 policies).
- [ ] **A4.** Port `norbital_hr` (1 policy, generated from collection lists — keep the generation, move
      it into the declaration).
- [ ] **A5.** Add a `reclamation` policy; it has none anywhere today.
- [ ] **A6.** Delete each `seed/<template>/steps/policies.ts` and its `index.ts` wiring, **only after**
      the matching declaration reconciles. `reconcileDeclaredPolicies()` upserts by key and never
      deletes undeclared rows, so a stale seeded policy lingers silently — remove it deliberately.
- [ ] **A7.** ~~Delete `team.ts` where it only holds `policy_id`.~~ **Corrected:** no such file exists.
      Every `team.ts` carries names, descriptions, `is_active`, and (in `norbital_hr`) a three-level
      hierarchy, and its ids are imported by each `user.ts`. A7 reduces to dropping the `policy_id`
      value and its `dependsOn` edge.

### B. Channels

- [ ] **B1.** Rename the `notifications` facility to `messaging` and add its `transports` record.
      Blocks B2 and the transport validation in `ChannelDefinition`.
- [ ] **B2.** Validate `+<name>.channel.ts` transports at startup, in the shape of
      `assertSystemEventsAreReachable` in `define-workspace.ts`.
- [ ] **B3.** Port channel delivery (~2,500 lines: `channel-manager`, `channel-history`, `automation`,
      `pending-channel-message`) onto tenant collections. Telegram built in; WhatsApp host-supplied.

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
- [ ] **C9.** `resolveRuntimeBindings` supplies only db/fileStorage/ai/notifications/maps — `queue`,
      `integrationDelivery` and `agentTools` are absent, not merely unchanged.
- [ ] **C10.** The `hmac(email) → org_ids` routing index does not exist. `platform_user_lookup` is a
      chat-platform mapping and is not it; build it.

### D. Prove it works

Unit and e2e coverage did not catch total auth failure in standalone. These are manual passes.

- [ ] **D1.** Integrations round trip: sync a template collection to a real external API and back.
- [ ] **D2.** Notifications: trigger one from a hook and confirm delivery.
- [ ] **D3.** Automations: scheduled and event-triggered, both observed firing.
- [ ] **D4.** Hooks: `before` mutation and `after` derived write.
- [ ] **D5.** Policies: two users, different policies, confirm each sees only their own scope.
- [ ] **D6.** Agent: chat from the panel, tool call, transcript replay across turns.
- [ ] **D7.** A full standalone walkthrough per template, not just `crm`.
