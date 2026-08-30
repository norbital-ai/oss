# Access control and identities

Access is one system. A **subject** is minted per invocation; **policies** are source; **team
membership** is data. Colony routes the sign-in request and never mints a session.

Sibling: [approvals and locking](./approvals.md).

Source: `src/runtime/identity/`, `src/runtime/access/`, `src/runtime/dispatch.ts`.

---

## Subject

Every actor shares `Subject` (`src/runtime/identity/subject.ts`):

| Field            | Meaning                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `userId`         | Person UUID, or `colony-system` / `envoy:<name>` / `automation:<name>` / `colony-seed` |
| `tenantId`       | Invocation scope                                                                       |
| `teamPath`       | Own team first, then descendants (depth ≤ 8). **Authority is `teamPath[0]` only.**     |
| `policies`       | Non-empty only for static identities. People always have `[]`.                         |
| `system`         | Host principal only. Cannot be supplied in a payload.                                  |
| `admin`          | `user.status === 'admin'`. A status, not a role.                                       |
| `impersonatedBy` | Set when the actor is previewing a team or another user.                               |

`CurrentSubject` is provided by dispatch after authentication. Minted fields (`system`, `policies`,
…) are stripped or refused on command payloads.

---

## Identity kinds

```text
                    ┌─────────────┐
   cookie / OTP ──► │    user     │  userId = UUID, policies = [], teamPath from user.team_id
                    └─────────────┘
   HMAC (host)  ──► │ colony-system│  system: true; manage schema + identity only
                    └─────────────┘
   declaration  ──► │ automation:x │  policies from +<name>.ts; teamPath = []; cannot approve
                    └─────────────┘
   inbound msg  ──► │ envoy:y      │  policies from declaration; linked sender may narrow userId
                    └─────────────┘
   host seeder  ──► │ colony-seed  │  attributable name only; no policies
                    └─────────────┘
```

### Person

Session credential → `Identity.authenticate` → `subjectFromSource`. `teamPath` is computed from
`user.team_id`. Used for every credential-backed command, `${requestor.*}`
tokens, and approval requestor links.

A person belongs to **exactly one team**. There are no roles. Administration is
`user.status = 'admin'`.

### `colony-system`

HMAC-verified host signature → `SystemPrincipal.systemSubject`. `userId = 'colony-system'`,
`system: true`, empty `teamPath` and `policies`.

Authority is `COLONY_SYSTEM_POLICY`: `manage` on `schema` and `identity` only — `schema.migrate`
and `identity.admitFounder`. It cannot read tenant rows or approve. Used for provisioning.
`identity.continueSession` and `identity.bootstrapFounder` are also host-signed
(`SYSTEM_ONLY_COMMANDS` in `dispatch.ts`); they are not extra policy grants.

### Automation

`automationSubject(declaration, tenantId)`. `userId = automation:<name>`. Policies copied from
the declaration. Never the caller's subject. Empty `teamPath` → **cannot approve**.

### Envoy

`envoySubject(envoy, tenantId, linked?)`. Capability is **always** the declaration. If the sender
is linked to a `user` via `user.channels`, `userId` becomes that account (a narrowing for
`${requestor.id}`), but `teamPath` stays empty and `admin` is dropped. A linked administrator
reaches exactly what an anonymous sender reaches.

### Impersonation

- **Team preview** (`x-colony-impersonated-team`): actor `userId` unchanged; `teamPath` replaced;
  `admin` cleared; `impersonatedBy` set. Requires an `impersonate` / `identity` grant.
- **User impersonation** (`access.impersonate`): subject becomes the target user.

### `colony-seed`

A name in a history row so seeded records have a creator. Holds no policy. The seeder writes over
the host's own connection and never crosses authorization.

---

## Policies and teams

A policy is `src/access/policies/+<name>.ts`. The filename is the only name. `grants` is an object
keyed by collection; presence is the rule, absence is denial.

- Read / history: `{ where?, fields?, dependencies? }`
- Write: `{ fields?, authorize?, approval? }` — see [approvals](./approvals.md)
- Delete: `{ authorize?, approval? }`

`where` is normally the same structured field predicate used by collection reads. A relation scope
that cannot be expressed structurally uses `policySql(statement)`, a policy-only serialized
predicate; it is deliberately absent from `api.db.*` query configuration. Both forms bind
`${requestor.id}`, `${requestor.email}`, and `${requestor.team_scope_users}`. `authorize` is a
server-only function over the prepared candidate. `capabilities` grants apps, tools, MCP, skills.
`limits` are rate rules.

**Membership is a row; authority is source.**

| Concern                           | Lives in                                       |
| --------------------------------- | ---------------------------------------------- |
| Which teams exist, who is on them | `team` / `user.team_id` (operator edits)       |
| What a team may do                | `src/access/+teams.ts` (compiled into release) |
| Approval routing                  | Policy grant `approval.flow()`                 |

A `team` row has **no policy column**. `policiesHeld` resolves `teamPath[0]` against `+teams.ts`
(case-insensitive). Descendants stay in the path for row predicates and confer no policies.
Approval eligibility uses `teamPath[0]` only.

Static envoys and automations name policy arrays in their declarations and are never `user` rows.

---

## Colony vs Bolt

Colony (`sign-in.ts`) finds the workspace and forwards `identity.sendCode` / `identity.verifyCode`
with no auth header. It stores the returned credential in a cookie. It never generates a code and
never mints a session.

Bolt runs Better Auth inside the bundle: OTP, persistence, delivery, `verifyCode` / `startSession`.
`tenantId` is bound from invocation scope. Rate limits for the challenge live in
`src/access/+anonymous_limits.ts` and are enforced at dispatch.

---

## Wire subject

The facility wire `CallSubject` is `{ userId, team? }` only. The full `Subject` exists inside the
guest.

---

## System collections (identity)

`user`, `session`, `account`, `verification`, `auth_config`, `team`,
`bolt_external_subjects`, `bolt_workspace_identity_settings`, `bolt_invitations`.
Declared in `src/authoring/system-models.ts`.
