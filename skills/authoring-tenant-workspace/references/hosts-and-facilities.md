# Hosts and facilities

A host runs a bundle and supplies its facilities: database, files, logs, mail, AI, network, sandbox, the secrets key. Bolt ships only interfaces. Member table: the Bolt `hosts.md`; contract: the `Facilities` type.

## Tethered (default)

Colony supplies every facility. A template declares what it uses and writes no host code, keys or env vars. Stop here unless the workspace must run elsewhere.

## Untethered

A host file default-exports one `Facilities` record and may export `serving`. It is `norbital.host.ts` at the workspace root, or `--host=<file>`, and never part of a release.

1. Every key is required: use `satisfies Facilities`.
2. `off` is the only way to leave a member out. No defaults or fallbacks.
3. `mail` has no `off`. `database`, `files`, both logs and `keys` are required. The guest runner is no facility.
4. Bolt reads no env vars; the host reads its own.
5. Adapters are the host's code, never Bolt's.

## Needs

The build records needs from declarations. Needs are never config or secrets.

| Need | Recorded when | Member |
| --- | --- | --- |
| `sms`, `phone` | phone sign-up | `transactional.sms`, `.phone` |
| `challenge` | an app with `challenge: true` | `transactional.challenge` |
| `system1`, `system2` | an `ai` block | `intelligence.system1`, `.system2` |
| `embed` | `ai.embeddings` | `intelligence.embed` |
| `webhooks` | an integration definition | `ports.webhooks` |
| `outbound` | an integration definition or declared secret | `ports.outbound` |

- Activation refuses a need whose member is `off` and names every unmet member. Nothing starts half-working.
- `mail` is needed by every bundle. Other members may be `off`; a call answers `Unavailable`.
- Interfaces are Promise plus AbortSignal.

## `bolt dev`

- A host file present: untethered at `127.0.0.1:5180`, migrating each build on the host's database. A `.svelte` edit is a hot update; a model edit rebuilds and reactivates.
- Absent, or `--tethered`: rewrites `.norbital/` on save for local Colony, which follows without a reset.
