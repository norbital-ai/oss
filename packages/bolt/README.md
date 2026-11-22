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
- `@norbital-ai/bolt/errors` — typed runtime failure and refusal classes
- `@norbital-ai/bolt/page` — page context types and device helpers
- `@norbital-ai/bolt/engine`, `/artifact`, `/host-api`, `/protocol` — host-side runtime contracts (agent runtime under `src/engine/agent/`: turn loop, tool calls, I/O, lifecycle, messages, queue, tools)
- `@norbital-ai/bolt/docs` — the API reference and authoring skills as data (the agent's `skill` tool reads the compiled skills)
- `@norbital-ai/bolt/tooling` — internals bolt-cli builds on; not an API

The API reference, generated from the TSDoc on these exports, is published as `@norbital-ai/bolt/docs` and rendered at
<https://norbital.ai/docs/api-reference>.
