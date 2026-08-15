# Workspace environment

One declaration. One store. One Integrations surface. Core and `pod start` are the same path.

A workspace never holds a secret value in source. It declares the names it needs. The host stores
the values in the **facility database** — the tenant Postgres the host already provides as `db` —
and an administrator sets them in **Settings → Integrations**, the same tab as channel credentials.
At boot the host loads those values into `process.env` so tenant code reads `$app/env/private` and
`$app/env/public`, the same modules SvelteKit uses.

`process.env` is the runtime cache, not the source of truth. A `.env` file is not the product
store. Host infrastructure keys (`DATABASE_URL`, the encryption master key) stay in the host
process environment; they are not workspace secrets.

## Declare

`src/+env.ts` is a workspace-root role, same convention as `+seed.ts` and `+agent.ts`.

```ts
import { defineEnvVars } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export const variables = defineEnvVars({
	STRIPE_KEY: {
		description: 'Stripe restricted API key',
		schema: z.string().trim().min(1)
	},
	PUBLIC_MAPS_REGION: {
		description: 'Default maps region shown in the client',
		public: true,
		schema: z.string().trim().min(1)
	}
});
```

| Flag          | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| (default)     | Private. Import from `$app/env/private`. Server-only. Sealed in the DB. |
| `public: true`| Safe for the browser. Import from `$app/env/public`. Never a credential. |
| `schema`      | Standard Schema (Zod, …). Applied only when a value is present.         |
| `description` | Shown in Integrations and on hover.                                     |

The compiler lifts private keys into `manifest.secrets` and public keys into `manifest.env.public`.
An integration `{ env: 'STRIPE_KEY' }` must name a declared private key or the build fails.

## Store

On deploy the host **declares** each key as a row in the facility database. A row with no value is
a known gap, not a missing declaration. An administrator cannot invent a key the workspace did not
declare; `set` is an update of an existing row.

Values are sealed at rest (AES-GCM). The encryption master key is host infrastructure — Core's
`SECRET_APP_ENCRYPTION_KEY`, or the equivalent on `pod start`. Ciphertext lives in the tenant
database. Plaintext never does.

This is the same pattern as integration credentials: declare from the manifest, set from
Integrations, resolve at call time. Environment variables and integration `{ env: 'NAME' }`
references are the same rows.

## Configure

Settings → Integrations is the only place an operator pastes a value. It is the same tab as
channel transports. There is no separate Environment settings tab.

The pane lists declared keys from `+env.ts`, whether each is configured, and the description. It
never returns a stored value. An admin can set or clear. Every key is optional: an unset value
does not refuse boot and does not disable an integration. Callers that need the value handle
`undefined` themselves.

That pane must exist on every host, including `pod start`. Core already mounts it inside the
Integrations host plugin; standalone must show the same list, not a Core-only screen and not a
second Settings tab. There is no "paste this into a `.env` and restart" product path for
workspace secrets.

## Make available

At process start the host reads configured rows, decrypts them, and puts them on `process.env`.
Tenant code never talks to the secret table.

```ts
import { STRIPE_KEY } from '$app/env/private';
import { PUBLIC_MAPS_REGION } from '$app/env/public';
```

`$app/env/private` is server-only. The compiler rejects the import outside these roles, and Vite
refuses it in a client bundle:

| Allowed                                      | Forbidden                                              |
| -------------------------------------------- | ------------------------------------------------------ |
| remotes, automations, hooks, pipelines       | `src/apps/**` (pages)                                  |
| integrations, agent tools, `+seed.ts`        | representations, custom-type renderers                 |
| `+agent.ts`, `src/mcp/**`                    | `src/lib/**` and any other shared / client module      |

Hooks are server-side (`+hooks.ts` runs in the tenant runtime). They are not isomorphic and never
ship to the browser. `$app/env/public` may be imported from client code; it must never hold a
credential.

Imported values are `string | undefined`. A missing key never refuses boot. `validateDeclaredEnvVars`
only rejects a value that is present and fails its schema.

### Core

1. Deploy declares rows in the facility (tenant) database.
2. An admin sets values in Settings → Integrations.
3. When Core boots the isolate it decrypts configured rows into isolate `process.env`. Isolate
   `process.env` is workspace env only.
4. Core's own platform secrets (`SECRET_NEON_API_KEY`, …) are **not** injected. Those stay in
   Core's process and are read from `$app/env/private` in Core, declared in
   `apps/core/src/env.schema.ts`.

The isolate has no network and is never told a database URL. Workspace secrets are the exception
that belongs in the isolate: they are the tenant's credentials, not Core's.

### Self-host (`pod start`)

1. Deploy declares the same rows in the same facility database (the Postgres `pod.host.ts` already
   points at).
2. An admin sets values in the same Settings → Integrations pane.
3. The host process decrypts configured rows into its own `process.env` before the workspace
   module loads.
4. `$app/env/*` reads that process. Integration delivery and webhook verification resolve the
   same rows.

A local `.env` may still seed host infrastructure (`DATABASE_URL`). It is not the store for
`STRIPE_KEY`.

## What stays out of this store

| Kind                                      | Lives in                                      |
| ----------------------------------------- | --------------------------------------------- |
| Workspace secrets (`STRIPE_KEY`, …)       | Facility DB, configured in Integrations       |
| Host infrastructure (`DATABASE_URL`, …)   | Host process environment                      |
| Core platform secrets (`SECRET_NEON_*`)   | Core `env.schema.ts` + Core process env       |
| Channel transport tokens (Telegram, …)    | Host credential store (Core system DB today)  |

Channel sockets remain a host facility. Workspace env is tenant configuration.
