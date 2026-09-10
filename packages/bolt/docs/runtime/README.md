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
A Command, Plugin, or Task payload that claims them is refused before contract decode.

Missing or invalid session/system proof is **401** (`DispatchError { code: 'unauthorized' }`,
message `Missing command credential`). Tenant mismatch, refused impersonation, and
`AccessDenied` are **403**. An authenticated unknown command raises
`DispatchError { code: 'unknown_command' }`, which `app.ts` does not map to a status, so it is
reported as **500** `dispatch_failed`. There is no 404 mapping.

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

| Plugin          | No credential                                         | Status |
| --------------- | ----------------------------------------------------- | -----: |
| `data-browser`  | `AccessDenied` — `trustedContext` is not a credential |    403 |
| any other plugin | `DispatchError { code: 'unauthorized' }`             |    401 |

A Data Browser call with a session may then impersonate inside the same tenant. System HMAC is also
accepted.

## Managed automation connections

An automation may declare one `connection: defineConnection({ baseUrl, authentication })` in its spec.
`api.connection.get({ path, query })` resolves a relative path inside that API prefix and reads the
credential through the workspace vault. Hooks and functions do not receive this capability. Each GET
uses a distinct invocation effect identity; stoppage is checked before the credential or provider call.
The response carries `status`, lower-case `headers`, and a JSON body (or text when the provider returns
non-JSON). The automation owns pagination and non-success status handling.

The default host connector accepts HTTPS GET against public DNS addresses only, pins the checked
address, refuses transport-header overrides, and never follows redirects. The complete request has a
30-second deadline and a two-MiB body limit. Credentials and raw transport errors are not exposed in
errors. Existing integration delivery providers remain independently configured.
