# @norbital-ai/bolt-server

`bolt start`: one Bolt workspace artifact served from one process (RFC §5.11.6), and the self-host
adapters of the engine's host ports that another host may import.

- `start(config)` activates the artifact against its database, files, secrets and facilities and serves
  it; `main(argv, env)` decodes `BOLT_*` configuration and runs `start` until SIGTERM or SIGINT, then drains.
- Ports: `localFiles`, `s3Files`, `inProcessDeadlines` (one unrefed timer, no polling), `emailTransport`
  and `mailPort`, `whatsappTransport`, `telegramTransport`, `webPush`.
- Optional providers (AI, geocoding, web reads, channel transports) are configured or absent; an absent
  one answers `Unavailable`.

The public page reader (`src/web.ts`) reads HTTPS only, pins every checked DNS answer, refuses private
and reserved networks before a socket opens, follows at most five checked redirects and answers a
refused read as a rejected promise, never a process-level error.
