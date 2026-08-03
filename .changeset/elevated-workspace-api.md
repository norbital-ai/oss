---
'@norbital-ai/pod': minor
---

Expose the elevated server API to workspace code as `getElevatedApi()` from
`@norbital-ai/pod/authoring`.

Tenant code could previously have elevated writes or reads, never both. An `after` hook receives
`AfterHookApi`, whose `db` is an `ElevatedMutationApi` — permission-bypassing writes and no `query`.
A remote command handler receives `BeforeApi` — `query`, but ordinary permission-checked writes.
Anything that reads previous state and writes a derived record from it could satisfy neither, and
both workarounds fail in the same direction: a command handler writing unelevated is refused for any
role whose policy grants read on the derived collection but not create, and a hook reaching for
`api.db.query` calls a method that is not on the object it was handed.

`getElevatedApi()` returns the `AfterApi` the runtime already builds internally, which carries both
halves. It is loaded on call rather than at module scope, so `@norbital-ai/pod/authoring` stays free
of `node:async_hooks` for workspace definitions that are also read in the browser.

Elevation bypasses policy for every read and write made through it. It is for records the workspace
itself authors — a derived projection, a computed rollup, an audit row — not for carrying out
something a user asked for on their own behalf.
