---
'@norbital-ai/platform-utils': minor
'@norbital-ai/pod': minor
---

Make the host-owned stdio channel the only way a hosted guest reaches its host

**Breaking for hosted deployments.** A hosted guest no longer speaks HTTP to its host, so this
version of `@norbital-ai/pod` cannot run under a host that has not learned the stdio wire. Standalone
and self-hosted workspaces (`pod dev`, `pod start`) are untouched — nothing about that path changes.

A hosted guest reaches its host for every facility call — the database above all, once per SQL
statement while a request is being served. It used to do that over its own outbound HTTP
connections, which requires the sandbox to have a way out. It does not: on a sealed sandbox the
egress allow rule is programmed into the firewall and the traffic still does not arrive. So the
outbound client is deleted rather than deprecated. There was no deployment it could serve and
keeping it would have meant keeping a second code path that only ever fails, silently and late.

`platform-utils` carries the length-prefixed frame codec both ends share. Pod speaks it over the
guest process's own stdin and stdout. The direction of requests is unchanged — the guest still asks,
because it must — but the channel is opened by the host, so the guest never dials out and the
sandbox can be closed.

A host must now:

- start the guest process with a writable stdin and a readable stdout, and speak frames over them;
- push a `configure` frame carrying `hostPlugins` before the guest will bind its port, and answer
  each `binding` request frame with a `binding` response correlated by `id`;
- wait for the guest's `ready` frame rather than for the process to exist, since a process that
  started and a runtime that can answer are different things;
- stop setting `NORBITAL_CORE_URL` and `NORBITAL_BINDING_SECRET`, which are no longer read. The
  channel the host opened is itself the capability; a shared secret over a host-opened pipe proved
  nothing. `POD_HOST_TOKEN` is still required and still faces the other way, gating inbound traffic
  from the host's proxy;
- read the guest's diagnostics on stderr. stdout carries frames and nothing else: the real stdout is
  claimed before the workspace bundle is imported and `process.stdout.write` is pointed at stderr, so
  a `console.log` anywhere in the process — including in a dependency — cannot corrupt the stream.

`NORBITAL_RUNTIME_TRANSPORT` is gone with the transport it selected.
