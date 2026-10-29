# `@norbital-ai/bolt-cli`

Bolt's tooling: the compiler, the `bolt` command and the test kit. A workspace takes it as an exact devDependency at
its `@norbital-ai/bolt` release (`bolt templates lock` writes it from that release's `toolchain.json`); it never enters
a release, and no host loads it at run time.

```sh
bun add --exact @norbital-ai/bolt
bun add --exact --dev @norbital-ai/bolt-cli
bunx bolt check
bunx bolt build
bunx bolt test
```

- `bolt` — `sync`, `check`, `build`, `test`, `dev`, `seed` on one workspace, and `templates` (`check`, `lock`, `test`,
  `verify`, `publish`) from a template repository root ([the dev loop](../bolt/docs/dev-loop.md)).
- `@norbital-ai/bolt-cli/test` and `/test/browser` — the test kit: `TestWorkspace.layer(options)` and the Effect Vitest
  helpers, and the shell controls mounted in a browser test. Guest code runs on the kit's own runner.
- `@norbital-ai/bolt-cli/guests` — `nodeGuests(options?)`, a guest runner (`HostPorts.guests`) as `node:vm` contexts in
  this process, metered against each session's CPU budget: operator-trusted code only, with no memory cap and no
  security boundary. bolt-server, `bolt dev` and the test kit run on it; a multi-tenant host brings native isolates.

The compiler bundles Bolt's own modules (the shell, the page SDK, the declaration edge) from the `@norbital-ai/bolt` it
resolves; in the oss checkout, running from source, it bundles Bolt's source beside it. Its view of Bolt's internals is
`@norbital-ai/bolt/tooling`, which is not an API.
