# Hosts and Facilities

`bolt build` turns a workspace into a bundle. A **host** runs the bundle and supplies its
**facilities**: everything the engine needs from outside (database, files, logs, mail, AI, network,
sandbox, the secrets key, the guest runner). Bolt ships only the facility interfaces (`@norbital-ai/bolt/facilities`);
the host writes the implementations. The full member table is `@norbital-ai/bolt/docs` → `hosts.md`.

## Tethered (the default): nothing to configure

Colony is the host. It supplies every facility for every tenant from its own platform code. A
template declares what it uses (`+workspace.ts` AI, phone sign-up, integrations, secrets) and
writes no host code, keys, endpoints or env vars. This is the normal case; stop here unless the
workspace must run somewhere other than Colony.

## Untethered: the host supplies everything itself

A host file default-exports one `Facilities` record and may export `serving` (integration
providers, OAuth app, converter, geocoder, web reader, `close`). It is `norbital.host.ts` at the
workspace root: `bolt dev` and the example `@norbital-ai/bolt-server` load it when present, and
`--host=<file>` names another. The host file is never part of the release's source.

Rules:

1. Every key is required. `satisfies Facilities` turns a missing key into a type error.
2. `off` is the only way to leave a member out. There are no defaults and no fallbacks.
3. `mail` has no `off`: every host sends sign-in codes and invitations. `database`, `files`,
   both logs and `keys` are required too. The guest runner is no facility: the host serving the
   file owns it (bolt-server and `bolt dev` run bolt-cli's `nodeGuests`).
4. Bolt reads no env vars. Whatever the host needs (keys, endpoints, credentials) it reads itself.
5. Facility adapters (Resend, Twilio, OpenRouter, S3, …) are the host's own code, never Bolt's.

## Needs: what the bundle asks for

The build records the bundle's **needs** in its manifest, derived from the declarations. Needs are
never config or secrets.

| Need        | Recorded when the workspace declares                                  | Facility member           |
| ----------- | --------------------------------------------------------------------- | ------------------------- |
| `sms`       | phone sign-up (`signup.via` includes `phone`): texted invitations     | `transactional.sms`       |
| `phone`     | phone sign-up (`signup.via` includes `phone`)                         | `transactional.phone`     |
| `challenge` | an app whose audience sets `challenge: 'turnstile'`                   | `transactional.challenge` |
| `system1`   | an `ai` block in `+workspace.ts`                                      | `intelligence.system1`    |
| `system2`   | an `ai` block in `+workspace.ts`                                      | `intelligence.system2`    |
| `embed`     | `ai.embeddings`                                                       | `intelligence.embed`      |
| `webhooks`  | an integration, a connection, or an automation triggered by a webhook | `ports.webhooks`          |
| `outbound`  | an integration, a connection, or a secret in `+secrets.ts`            | `ports.outbound`          |

Activation checks the needs first. A need whose member is `off` refuses the whole activation and
names every unmet member: `the bundle needs phone, system2, which this host leaves off`. Nothing
starts half-working. `mail` is needed by every bundle and checked at run time too. Members no
declaration requires (`push`, `speech`, `websockets`, `sandbox`) may be `off`; a call that reaches
one answers `Unavailable`.

## A minimal host file

```ts
// norbital.host.ts: the host's OWN implementations
import { off, type Facilities } from '@norbital-ai/bolt/facilities';
import { keysPort } from '@norbital-ai/bolt/node';
import { database, files } from './host/storage.ts';
import { runtime, audit } from './host/logs.ts';
import { mail } from './host/mail.ts';
import { readFileSync } from 'node:fs';

export default {
	storage: { database, files },
	logs: { runtime, audit },
	transactional: { mail, sms: off, phone: off, push: off, challenge: off },
	intelligence: { system1: off, system2: off, embed: off, speech: off },
	ports: { webhooks: off, websockets: off, outbound: off },
	sandbox: off,
	keys: keysPort(readFileSync('.host/master.key')) // 32 bytes
} satisfies Facilities;
```

Each interface is Promise + AbortSignal, so any runtime can implement it. This file suits a
workspace with no AI, phone sign-up, integrations or secrets; anything more needs those members
implemented. A complete Node host file is `oss/packages/bolt-server/example/norbital.host.ts`: it
reads its own `BOLT_*` settings and composes bolt-server's adapters, every member configured or `off`.

## `bolt dev`

```bash
bolt dev [--port=5180]                  # norbital.host.ts present: untethered, at http://127.0.0.1:5180
                                        # absent: tethered, build on save; local Colony serves it
bolt dev --host=./dev.host.ts           # untethered with another host file
bolt dev --tethered                     # tethered even when norbital.host.ts is present
```

- **Tethered** (no host file) rewrites `.norbital/` on each save and serves the pages from source
  for the host. In the realm, `env start` already runs this for every template checkout: a page
  `.svelte` edit is a hot update in local Colony's open tab, and any other edit is a rebuild Colony
  picks up without a reset.
- **Untethered** loads the host file, migrates each build on the host's own `database` and
  activates it through the needs check. Pages are served from source: a `.svelte` edit is a hot
  update; a model edit rebuilds the manifest and guest and reactivates. Deadlines wake, crons fire
  and integrations link through the same engine path bolt-server serves with.
