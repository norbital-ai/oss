# `@norbital-ai/bolt`

Bolt is the workspace framework: what a workspace declares with and what hosts load — declarations, page SDK,
shell client, protocol and the engine. A workspace is a source tree of `+`-files; the `bolt` CLI
([`@norbital-ai/bolt-cli`](../bolt-cli), a devDependency) checks it, builds it and tests it, and a host serves the
resulting artifact. This package carries no compiler, CLI, test kit or guest runner.

```sh
bun add --exact @norbital-ai/bolt
bun add --exact --dev @norbital-ai/bolt-cli
bunx bolt check
bunx bolt build
bunx bolt test
```

Entries:

- `@norbital-ai/bolt` — declaration functions and types
- `@norbital-ai/bolt/page` — the Page SDK (`$bolt` in pages) and Device
- `@norbital-ai/bolt/engine`, `/artifact`, `/host-api`, `/protocol`, `/facilities`, `/node`, `/guest-hooks` —
  host-side runtime contracts and Node adapters
- `@norbital-ai/bolt/docs` — the API reference and authoring skills as data (the agent's `docs` tool reads it)
- `@norbital-ai/bolt/tooling`, `/tooling/browser` — internals bolt-cli builds on; not an API

Read [the Bolt documentation](./docs/README.md) for terms, authoring, pages, hosts and tests. The
generated API reference is published as `@norbital-ai/bolt/docs` and rendered at
<https://norbital.ai/docs/api-reference>.
