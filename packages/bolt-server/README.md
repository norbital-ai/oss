# @norbital-ai/bolt-server

The self-host server shell around one immutable Bolt bundle: it loads the bundle, forms the
facility bindings the embedder supplies, serves the HTTP and sync transports, and runs the
scheduler tick. Colony is the multi-tenant host built on the same pieces.

## Tenant work cannot crash or wedge the host

Guest code never shares a failure path with this process. On Colony it runs in isolates; on this
server it runs behind the same facility contract. Every host facility a guest can reach is guarded
(`src/facilities/boundary.ts`): a binding that throws before returning a promise, rejects, or
answers with something that is not a facility result is that one call's `Failure`, and nothing
else. Every call runs in an async scope, so a failure raised later by work the facility started (a
socket it opened emitting `error` with no listener, which Node raises at process level) is still
attributed to that call and contained. The process policy (`installProcessShutdown` in
`src/app.ts`) is the last line: a failure that escapes every boundary is logged with its stack,
`/readyz` flips to 503 at once, the graceful stop gets five seconds, and then the process is
killed with a signal rather than walked through Node's exit path, which has hung with the port
still listening. A crashed host restarts under the container's restart policy; a wedged host
cannot exist. `src/facilities/web.ts` is the case that taught this: a DNS answer the container
could not route failed inside a synchronous `lookup` callback before `http` had attached its
socket listener, and the uncaught error took the whole host down for three hours.
