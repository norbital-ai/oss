---
'@norbital-ai/platform-utils': minor
'@norbital-ai/pod': minor
---

Reorganize the package source layout and finish the HTTP-native tenant runtime transport.

- `src/lib/` is flattened to `src/`: the folder existed only for the svelte-package convention, and
  the build (`svelte-package -i src`) emits the same `build/` tree, so every published specifier is
  unchanged. The `$lib/*` alias and the `#lib/*` imports map are repointed accordingly.
- The browser UI moves out of the mislabelled `runtime/` and the client-state modules out of
  `client/` into `src/ui/` — `state/`, `shell/`, `collection/`, `agent/`, `settings/`, `sync/`,
  `subservices/` — with `src/ui/public.ts` as the `@norbital-ai/pod/client` entry. The
  `./client/platform`, `./client/runtime`, and `./client/agent` exports follow their files
  (`build/ui/shell/mount-client.js`, `build/ui/state/client.js`,
  `build/ui/agent/agent-chat-panel.svelte`).
- `bin/invocation/standalone.ts` is reduced to a re-export; the standalone server it contained
  (`pod start`, migrate, seed, invite, static assets, jobs/channels/webhooks) now lives in
  `src/serve/standalone.ts` beside the hosted adapter.
- The tenant runtime now serves HTTP directly (`src/serve/hosted.ts`, `src/serve/node-http.ts`)
  instead of the stdio duplex frame protocol; the host reaches it over `/_pod/bootstrap`,
  `/_runtime/*`, and `/_host/*` routes carrying the shared host token. The standalone runner shares
  the same `handlePodRequest`/`handlePodHostCommand` pipeline through `src/serve/node-http.ts`.
- The serving layer is consolidated into one HTTP server core — `src/serve/server.ts`
  (`createPodHttpServer`, absorbing `src/serve/node-http.ts`) — with two adapters in front of it:
  the hosted adapter (`src/serve/hosted.ts`, which also absorbs `src/serve/bindings.ts`) and the
  standalone adapter (`src/serve/standalone.ts`, whose whole request pipeline now delegates to the
  core, passing the bundled runtime entry it already loaded). The `startPodHttpServer` export the
  generated `serve.mjs` calls is unchanged.
- The CLI-side helpers move out of `bin/invocation/` into `src/host/` —
  `host-config.ts` → `host/config.ts`, `jobs.ts` → `host/jobs.ts`,
  `webhook-inbound.ts` → `host/webhook-inbound.ts` — leaving `bin/` with the CLI entry and the
  standalone re-export only. The `pod` bin path (`build/bin/invocation/index.js`) and the
  `@norbital-ai/pod/host` public surface are unchanged.
- `src/remote/approval_request/` flattens to `src/remote/` root files
  (`approval_request.remote.ts`, `approval_request.runtime.server.ts`, `approval_request.schema.ts`).
- The two serving adapters are renamed to deployment modes so they read as one server with two ways
  to run it: `src/serve/guest.ts` → `src/serve/hosted.ts` (Cube microVM, remote facilities) and
  `src/serve/self-hosted.ts` → `src/serve/standalone.ts` (`pod dev`/`pod start`, in-process
  facilities), both over the shared `src/serve/server.ts` core; the generated `serve.mjs` entry and
  the `startPodHttpServer` contract are unchanged.
- `src/server/` loses its thin folders: `run/env.ts`, `run/host_plugins.ts`, and `run/facilities.ts`
  move up to `server/env.ts`, `server/host-plugins.ts`, and `server/facilities.ts` so `run/` holds
  only the run pipeline; `audit/audit_event.server.ts` moves up to `server/audit_event.server.ts`;
  `notifications/channels.ts` merges into `notifications/notification-outbox.server.ts`.
