# Authoring a tenant workspace

The mental model, and the four principles the authoring surface is designed around. The
[README](../README.md) is the reference for each role; this document is the _why_, and the rule for
deciding where something new belongs.

## The one-sentence model

> **A workspace declares what it is. The host supplies what it needs. Pod owns everything in between.**

Everything below follows from that split. When you cannot decide where something goes, ask which of
the three owns it: is it a property of this workspace (declare it), a credential or a socket or a
clock (the host supplies it), or behaviour every workspace shares (Pod already owns it, and you should
not be writing it).

## Four principles

### 1. Declarative — the filesystem is the registry

Names come from paths. There is no registry file, no `index.ts` to keep in step, and no place for a
declaration to drift from the thing it declares.

| File                                                         | Declares                                   |
| ------------------------------------------------------------ | ------------------------------------------ |
| `src/collections/work_orders/+model.ts`                      | collection `work_orders`                   |
| `src/collections/work_orders/+hooks.ts`                      | its mutation rules                         |
| `src/collections/+relationship.ts`                           | the whole relationship graph (exactly one) |
| `src/apps/operations/+dispatch_board.svelte`                 | app `dispatch_board`                       |
| `src/automation/+daily_digest.ts`                            | automation `daily_digest`                  |
| `src/remotes/+dashboard_summary.ts`                          | remote `dashboard_summary`                 |
| `src/policies/+field_agent.policy.ts`                        | policy `field_agent`                       |
| `src/**/+find_supplier.tool.ts`                              | agent tool `find_supplier`                 |
| `src/custom-types/money/+definition.ts` + `+renderer.svelte` | custom type `money`                        |

Adding a file adds the thing. Deleting it removes the thing. Renaming it renames the thing. A role
file whose name Pod does not recognise is a compile error rather than a file that silently does
nothing.

**Policies are declarations; membership is not.** A permission set is a property of the workspace, so
it lives in source and shows up in a diff. Who holds it changes at runtime, so `team`, `team_members`,
and `team.policy_id` stay database rows. Reconciliation matches policies by key and never deletes an
undeclared row or flips `is_active` — a deploy must not revoke access nobody asked to revoke.

### 2. Type safety — the generated types are the contract

Every role directory gets a `$types.d.ts`. Import from it and the workspace's own schema is bound:

```ts
// src/collections/quotes/+hooks.ts
import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input, api }) => {
			// `input` is the quotes create input; `api.db.query.accounts` is exact.
		}
	}
} satisfies Hooks;
```

You rarely need to name a type at all. `defineAutomation`, `defineQueryHandler`, and
`defineCommandHandler` default their schema generic to the compiler-merged workspace schema, so an
unannotated `api` is already exact:

```ts
export default defineAutomation(
	{ trigger: { collection: 'quotes', event: 'created' } },
	async (api, { scope }) => {
		// `scope.incoming_record` is a quotes row. `'quotez'` above would not compile.
	}
);
```

The generated unions — `CollectionName`, `PolicyName`, `AgentToolName`, `AppName` — are what make a
cross-reference checkable. An agent that names a collection it cannot reach, or a policy naming a
collection that does not exist, fails at compile time.

### 3. No footguns — the wrong thing does not compile, and the ambiguous thing does not exist

The surface is designed so that mistakes surface at their cause rather than downstream:

- **A misspelled name is a compile error, not an empty result.** A trigger on `'quotez'`, a grant on
  `'accountz'`, an agent tool that does not exist — all rejected before anything runs.
- **A `where` is checked against its own collection's row.** A condition naming a column another
  collection has would otherwise compile and then match nothing, reading as a grant while granting
  access to no rows.
- **A malformed cron expression fails at startup**, naming the automation, rather than never firing.
- **A workspace refuses to boot when a facility it needs is absent** — schedules that silently never
  fire are worse than a process that will not start.
- **There is one way to do each thing.** No parallel mechanism to choose between, and no
  configuration that only matters in one deployment.

Where a foot-gun cannot be removed, it is named. `intervalQueue()` is a timer with no durability, so it
is an explicit opt-in rather than a default — a deployment running on one says so in its own config.

**One known limit.** A `before` hook that returns a _spread_ — `{ ...input, no_such_column: 'x' }` —
compiles, because TypeScript does not apply excess-property checking to an object literal built from a
spread. A bare literal with the same mistake is rejected. This is a compiler limitation rather than a
loose type: the payload type itself is exact, and the same key assigned to `WorkspaceInsert<'quotes'>`
directly is an error. The mistake is caught at runtime with a 400 naming the field and listing every
valid field and relation for the collection, so it fails loudly — just one layer later than the rest of
the surface.

### 4. Simplicity — the smallest surface that is still honest

Pod ships the parts every workspace would otherwise write badly, and a workspace author never sees
them:

- Authentication, sessions, invitations, and the login / code-entry / accept-invite pages.
- Collection operations, policy enforcement, approvals, audit, and temporal history.
- The sync engine and the policy-scoped local replica.
- The agent loop and its tools.

If you find yourself writing auth, a permission check, an audit trail, or a login form, stop — that is
Pod's, and hand-rolling it means it is not covered by the guarantees above.

## Where does a new thing go?

```
Is it data shape or behaviour of this workspace?
  → declare it: a collection, hook, policy, automation, remote, app, tool, or custom type.

Does it need a credential, an outbound socket, a mailer, a model, or a clock?
  → the host supplies it. Declare the need; never the secret.
      · a fixed capability every host provides  → a facility (db, fileStorage, ai, maps,
        messaging, queue, integrationDelivery). The set is closed — there is no authoring surface
        for a new one, because Core must satisfy it generically for every tenant.
      · a call to one specific third party      → an integration: `+integrations.ts` declares the
        connection and the credential *reference*; `integrationDelivery` makes the call host-side.

Does it need business logic with typed input and output?
  → a remote: `src/remotes/+<name>.ts`.

Is it authentication, permissions, audit, history, or sync?
  → Pod already owns it. Do not write it.
```

## Secrets

A workspace never holds a secret value, only a reference:

```ts
connection: {
	baseUrl: 'https://api.stripe.com',
	authentication: { type: 'bearer', token: { env: 'STRIPE_KEY' } }
}
```

The reference compiles into the manifest; the host resolves it at call time. Tenant code runs in an
isolate with no network under Core, so it could not make the authenticated call even if it held the
key.

## The two deployments are the same workspace

A workspace does not change when it moves between hosts. Same source, same manifest, same auth path:

|                               | Core          | Standalone (`pod start`)                       |
| ----------------------------- | ------------- | ---------------------------------------------- |
| Authoring, policies, agent    | identical     | identical                                      |
| Auth logic and prebuilt pages | identical     | identical                                      |
| Facility _implementations_    | Core supplies | `pod.host.ts` supplies                         |
| Queue                         | pg-boss       | operator's binding (`intervalQueue()` for dev) |
| Organization selector         | Core          | n/a — one workspace                            |

`pod.host.ts` is the only file that differs, and it is data rather than setup code — adapters and
descriptors are values, so a host configuration stays readable, diffable, and type-checked.

## Getting a workspace running

```bash
pod sync          # generate types and derive migrations from the filesystem
pod check         # compile the workspace and report structural errors
pod dev           # build, migrate, and serve with a loopback development identity
pod invite you@example.com   # mint a founding invitation (self-hosted)
```

`pod dev` supplies `db`, `fileStorage`, and `queue`, and nothing else. A workspace with an agent
automation refuses to start under it, because `ai` is a _static_ requirement — which is the intended
answer, not an inconvenience: the alternative is a development run that fails at the first inference
call, far from the cause.

`maps` and notifications are not static requirements and never gate startup. Nothing in the manifest
implies them: a stored geolocation carries its own geometry and address, and a notification channel is
chosen at call time. Both validate when called.
