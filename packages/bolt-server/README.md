# @norbital-ai/bolt-server

`bolt start`: one Bolt workspace artifact served from one process (RFC §5.11.6), and the self-host
adapters of the engine's host ports that another host may import.

- `start(config)` activates the artifact against its database, files, secrets and facilities and serves
  it; `main(argv, env)` decodes `BOLT_*` configuration and runs `start` until SIGTERM or SIGINT, then drains.
- Ports: `localFiles`, `s3Files`, `inProcessDeadlines` (one unrefed timer, no polling), `emailTransport`,
  `webPush`; the host messaging factory `transactional`, and the channel
  providers (`baileys`, `twilioWhatsapp`, `telegram`, `slack`, `discord`, `wechat`, `mailbox`), are re-exported from
  `@norbital-ai/providers`.
- Channels read no env: an administrator picks each channel's provider and enters its own credentials at
  `/__bolt/transports/<channel>`, sealed in the secrets store (`BOLT_MASTER_KEY`); each channel's webhook is
  `/hooks/bolt.<transport>/<channel>` (paths under it, such as an email channel's `/oauth/callback` and open pixel,
  reach the same link). An email channel is the tenant's own mailbox over IMAP + SMTP: a password, or OAuth through
  the tenant's own Microsoft or Google app registration (redirect URI `<webhook>/oauth/callback`).
- Host messaging (sign-in codes, invitations; never a channel): email and phone are chosen separately.
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
- Optional providers (AI, geocoding, web reads) are configured or absent; an absent
  one answers `Unavailable`.

The public page reader (`src/web.ts`) reads HTTPS only, pins every checked DNS answer, refuses private
and reserved networks before a socket opens, follows at most five checked redirects and answers a
refused read as a rejected promise, never a process-level error.
