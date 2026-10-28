# `@norbital-ai/bolt`

Bolt is the workspace framework: declarations, compiler, engine, page SDK, shell client and test kit.
A workspace is a source tree of `+`-files; the `bolt` CLI checks it, builds it, tests it, and a host
serves the resulting artifact.

```sh
bun add --exact @norbital-ai/bolt
bunx bolt check
bunx bolt build
bunx bolt test
```

Entries:

- `@norbital-ai/bolt` — declaration functions and types
- `@norbital-ai/bolt/page` — the Page SDK (`$bolt` in pages) and Device
- `@norbital-ai/bolt/engine`, `/artifact`, `/host-api`, `/protocol` — host-side runtime contracts
- `@norbital-ai/bolt/test` and `/test/browser` — the workspace test kit

Read [the Bolt documentation](./docs/README.md) for terms, authoring, pages, hosts and tests. The
generated API reference is published as `@norbital-ai/bolt/docs` and rendered at
<https://norbital.ai/docs/api-reference>.
