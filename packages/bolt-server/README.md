# @norbital-ai/bolt-server

`bolt start`: one Bolt workspace artifact served from one process (RFC §5.11.6), and the self-host
adapters of the engine's host ports that another host may import.

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

- `ServerLive(config, options?)` is a scoped Layer providing `Server`. It activates the artifact
  against its database, files, secrets and facilities and owns the HTTP listener. `DatabaseLive(config)`
  supplies the native `TenantDb` adapter. `BoltConfig(flags?)` reads `BOLT_*` through Effect Config;
  `main(argv)` is the CLI Effect, launched once by the Node runtime and closed on SIGTERM or SIGINT.
- Core configuration: `BOLT_ARTIFACT` (required); `BOLT_PUBLIC_URL`, an origin that is `https://` unless its
  host is loopback (required); exactly one of `BOLT_DATABASE_URL` and `BOLT_PGLITE_DIR`; `BOLT_HOST` (default
  `127.0.0.1`) and `BOLT_PORT` (default `3100`); `BOLT_MASTER_KEY` and `BOLT_OPS_KEY`, 32-byte keys as 64 hex digits
  or base64; `BOLT_FILES_PROVIDER` `local` (`BOLT_FILES_ENDPOINT` a directory) or `s3` (`BOLT_FILES_ENDPOINT` the
  bucket URL, `BOLT_FILES_CREDENTIAL` `<access key id>:<secret>`). `BOLT_ENVIRONMENT` other than `production` shows
  the shell's badge; `--dev` or `BOLT_DEV=1` runs `bolt start` as `bolt dev`, only on a loopback origin outside
  production.
- `BOLT_AUDIT_DIR` is required: a separate persistent local database directory for administrator audit events,
  including writes, approvals, identities, automation results and integration changes. Preserve this directory
  across process and artifact restarts, including when the tenant database uses Postgres. It must not point at
  the tenant or system database. The host owns and closes the audit store, retains immutable events for 30 days,
  and provides indexed filtering, full-payload search and recovery through Bolt's audit facility.
- File and deadline ports come from `@norbital-ai/bolt/engine`: `localFiles` and
  `inProcessDeadlines`. `s3Files` is this server's internal adapter (`src/ports.ts`), not a package
  entry. Deadlines use a scoped `DeadlineTimer` fiber with no polling. Inbox notices
  reach devices by their subscription's `kind`: `web` sends web push (`BOLT_VAPID_PUBLIC_KEY` +
  `BOLT_VAPID_PRIVATE_KEY`), `apns` sends to iOS apps over APNs HTTP/2 with an ES256 provider token per
  Apple team, from `BOLT_APNS_KEYS` (JSON `{ "<teamId>": { "keyId": "…", "key": "<.p8 PEM>" } }`). A
  device the service reports gone is deleted; a team without a key answers Unavailable. Host messaging
  comes from the `transactional` export of `@norbital-ai/providers`.
- `drivers()` is every host's provider list, by driver kind: the conversation and calendar providers
  `@norbital-ai/providers` ships, then this host's own `http` (bolt's `httpRequest` under the definition's base URL,
  through the public guard) and `sqlserver` providers. It returns native `ProviderDef` values;
  `toDrivers` from `@norbital-ai/providers/abi` adapts them once to the Promise + AbortSignal + JSON
  driver contract at the host boundary. Every host (`bolt start`, `bolt dev`, a platform's own) links instances from it.
- Integration instances read no host env: an administrator (or whoever may update the instance's row) picks its
  provider and enters its credentials at `/__bolt/integrations/<instance>/pair`, sealed per instance with
  `BOLT_MASTER_KEY`; each instance's webhook is `/hooks/integration/<instance>` (paths under it, such as a mailbox's
  open pixel, reach the same link; a custom chat's signed deliveries are checked there with its credential). Every
  OAuth sign-in returns to the one `/hooks/oauth/callback`, routed to its instance by `state`: register that URI with
  an OAuth app once. Links reopen at start from the instance rows that are active and store a provider, and again when
  an instance's configuration changes.
- Gmail and Google Calendar share the host's Google Web application when a workspace declares no app of its own.
  Set both `BOLT_GOOGLE_OAUTH_CLIENT_ID` and `BOLT_GOOGLE_OAUTH_CLIENT_SECRET`; register
  `<BOLT_PUBLIC_URL>/hooks/oauth/callback` as an authorized redirect URI. Without the app those sign-ins are unavailable.
- Host messaging (sign-in codes, invitations; never an integration instance): email and phone are chosen separately.
  - `BOLT_TRANSACTIONAL_EMAIL`:
    - `resend`: `BOLT_RESEND_API_KEY`; optional `BOLT_RESEND_FROM` (default `noreply@<public host>`, a domain the
      Resend account must have verified).
    - `sinch`: `BOLT_SINCH_MAILGUN_KEY` + `BOLT_SINCH_MAILGUN_DOMAIN` (Mailgun, from `noreply@<domain>`).
  - `BOLT_TRANSACTIONAL_PHONE` (default `none`: numbers cannot sign in, nobody is texted an invitation):
    - `twilio`: `BOLT_TWILIO_ACC_SID` + `BOLT_TWILIO_AUTH_TOKEN` (Verify for a number's code by SMS or WhatsApp,
      service `Norbital` found or created; Messages for texted invitations from the account's Messaging Service or
      first SMS-capable number).
    - `sinch`: `BOLT_SINCH_VERIFICATION_KEY` + `BOLT_SINCH_VERIFICATION_SECRET` (a Verification application sending
      six-digit codes by SMS or WhatsApp); optional `BOLT_SINCH_SMS_PLAN_ID` + `BOLT_SINCH_SMS_TOKEN` +
      `BOLT_SINCH_SMS_FROM` (texts).
  - `BOLT_SINCH_REGION` (either Sinch selection; default `us`; `us`, `eu`, `au`, `br` or `ca`): SMS goes to
    `<region>.sms.api.sinch.com`, mail to `api.eu.mailgun.net` for `eu` and `api.mailgun.net` otherwise.
    A key no selection uses refuses the start. A deployed start refuses without an email provider, and without a phone
    provider when the workspace declares phone sign-up; a loopback origin outside production prints every message not
    configured (and its sign-in code) to the log instead.
- Optional facilities are selected by `BOLT_<FACILITY>_PROVIDER`, with `_ENDPOINT` and `_CREDENTIAL` where the
  provider needs them: `AI_SYS_1` (`openai`, `decisions`), `AI_SYS_2`, `AI_EMBED` (`openai`), `AI_SPEECH`
  (`openrouter`), `GEO` (`nominatim`), `CONVERT` (`norbital`) and `WEB` (`public`). An unregistered provider name
  refuses the start; `AI_SYS_1` and `AI_SYS_2` are configured together. An absent facility answers `Unavailable`.
  Provider selections also need their models: `BOLT_AI_SYS_1_MODEL` accompanies `BOLT_AI_SYS_1_PROVIDER`;
  `BOLT_AI_SYS_2_MODELS` and `BOLT_AI_EMBED_MODELS` map every model class the workspace declares, or
  activation fails; `BOLT_AI_TRANSCRIBE_MODEL` / `BOLT_AI_SPEAK_MODEL` enable speech. An app declaring a
  Turnstile challenge needs `BOLT_TURNSTILE_SITE_KEY` and `BOLT_TURNSTILE_SECRET`. Runtime events
  (§5.12) are log lines carrying each event's JSON, for whatever collects this process's output; nothing here stores
  them, so Studio's runtime log answers unavailable.

The public page reader (`src/web.ts`) reads HTTPS only, pins every checked DNS answer, refuses private
and reserved networks before a socket opens and follows at most five checked redirects.
`readPublicPage` returns an Effect with typed facility failures, including its thirty-second timeout.
