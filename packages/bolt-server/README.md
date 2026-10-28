# @norbital-ai/bolt-server

An example untethered host (plan 01): one Bolt workspace's built release served from one process with the
workspace's host file. `bolt-server [workspace]` serves `<workspace>/.norbital/bundle` (or `--artifact=<dir>`) with
`<workspace>/norbital.host.ts` (or `--host=<file>`); a workspace without a host file is Colony's to serve. Flags:
`--listen` (default `127.0.0.1`), `--port` (default `3100`), `--trust-proxy=<cidrs>`, `--founder=<address>`,
`--seed=<pack>`. `bolt dev` loads the same host file the same way and serves through the same engine path
(`serveRelease` in `@norbital-ai/bolt/node`): integration links, activation, deadline wakes and the cron clock.

A host file default-exports its `Facilities` (`@norbital-ai/bolt/facilities`, `satisfies Facilities`) and may export
`serving` (`Serving`: integration providers, OAuth app, converter, geocoder, web reader, shell badge and push key, and
`close`). [`example/norbital.host.ts`](example/norbital.host.ts) composes this package's own adapters (`host(settings,
database, options)`) from `BOLT_*` variables; its header lists them. The variables are the example host file's, not
Bolt's or bolt-server's: Bolt reads no environment.

Direct Node launches require `node --no-node-snapshot <entry>` for the native guest engine,
as specified by [isolated-vm](https://github.com/laverdet/isolated-vm#requirements). The Bolt CLI
and the server's fork test workers supply the flag.

Schema changes ship as committed files in `migrations/`: editable SQL, `snapshot.json` and
`migrations.lock.json`. Review the generated SQL and add `-- accept: <step-id>` within each destructive
step's block when accepting that step. Run `bolt build` again to replay the complete SQL history,
compare its resulting schema with the declarations and record the verified checksums, then commit all
three kinds of file with the source change.

Startup applies the artifact's migration files in order and records each applied checksum. An applied
file cannot be edited; a later change needs a new migration. Changed history, an unverified snapshot
or a destructive step without its SQL acceptance line refuses startup. Development follows the same
migration checks; runtime flags do not override them.

- Activation refuses a bundle whose recorded needs the host file leaves `off`, naming each member; nothing is guessed
  from the origin, and no endpoint has a default.
- `ServerLive(options)` is a scoped Layer providing `Server` (its URL and `ActiveWorkspace`). It loads the host file,
  verifies, migrates and optionally seeds the artifact, then serves it; `main(argv)` is the CLI Effect, launched once by
  the Node runtime and closed on SIGTERM or SIGINT, which also closes the host file's `serving`.
- Deadlines are one scoped fiber sleeping until the next due wake, with no polling. Inbox notices reach devices by their
  subscription's `kind`: `web` sends web push (the example's VAPID keys), `apns` sends to iOS apps over APNs HTTP/2
  with an ES256 provider token per Apple team. A device the service reports gone is deleted; a team without a key
  answers Unavailable. Host messaging is this package's own Resend (`src/resend.ts`) and Twilio (`src/twilio.ts`)
  adapters.
- `drivers()` is every host's provider list, by driver kind: the conversation and calendar providers
  `@norbital-ai/providers` ships, then this host's own `http` (bolt's `httpRequest` under the definition's base URL,
  through the public guard) and `sqlserver` providers. It returns native `ProviderDef` values;
  `toDrivers` from `@norbital-ai/providers/abi` adapts them once to the Promise + AbortSignal + JSON
  driver contract at the host boundary. Every host (bolt-server, a platform's own) links instances from it.
- Integration instances read no host env: an administrator (or whoever may update the instance's row) picks its
  provider and enters its credentials at `/__bolt/integrations/<instance>/pair`, sealed per instance with
  the host's `keys`; each instance's webhook is `/hooks/integration/<instance>` (paths under it, such as a mailbox's
  open pixel, reach the same link; a custom chat's signed deliveries are checked there with its credential). Every
  OAuth sign-in returns to the one `/hooks/oauth/callback`, routed to its instance by `state`: register that URI with
  an OAuth app once. Links reopen at start from the instance rows that are active and store a provider, and again when
  an instance's configuration changes.
- Gmail and Google Calendar share the host's Google Web application (`serving.oauth`) when a workspace declares no
  app of its own; register `<public URL>/hooks/oauth/callback` as an authorized redirect URI.
- Runtime events (§5.12) are log lines carrying each event's JSON; the last 10,000 are queryable from memory.

The public page reader (`src/web.ts`) reads HTTPS only, pins every checked DNS answer, refuses private
and reserved networks before a socket opens and follows at most five checked redirects.
`readPublicPage` returns an Effect with typed facility failures, including its thirty-second timeout.
