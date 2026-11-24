# Hosts and facilities

Hosts run bundles and provide facilities (database, files, logs, mail, AI, network, sandbox, secrets key; interfaces are Promise + AbortSignal).

- **Tethered (default):** Colony supplies every facility; templates write no host code, keys or env vars.
- **Untethered:** `norbital.host.ts` (or `--host=<file>`, never in a release) default-exports `satisfies Facilities` (optional `serving`). Required: `database`, `files`, `mail` (sign-in codes, invitations, and `bolt.mail` inbox notification emails), logs, `keys`; omit optional members explicitly with `off` (no defaults/env reads inside Bolt; adapters live in host code).
- **Needs:** recorded from declarations (`sms`/`phone` from phone sign-up — host transactional SMS is for sign-in/invitation codes only, not `ctx.notify`; `push` delivers `bolt.push` inbox alerts; `challenge`, `system1`/`system2` from `ai`, `embed` from `ai.embeddings`, `webhooks`/`outbound` from integrations/secrets). Activation refuses unmet needs; `off` optional members fail `Unavailable`.
- **`bolt dev`:** with host file serves untethered at `127.0.0.1:5180` with hot `.svelte` updates and model rebuilds; without (or `--tethered`) updates `.norbital/` for local Colony.
