# Norbital OSS

The open-source workspace framework, UI system, and shared libraries used by Norbital.

Starter workspaces live in their own repository:
[**norbital-ai/templates**](https://github.com/norbital-ai/templates).

## Packages

- [`@norbital-ai/bolt`](./packages/bolt) — tenant workspace authoring SDK, compiler, runtime, and
  client
- [`@norbital-ai/bolt-server`](./packages/bolt-server) — self-host server around the Bolt bundle
- [`@norbital-ai/bolt-protocol`](./packages/bolt-protocol) — wire protocol shared by host and runtime
- [`@norbital-ai/ui`](./packages/ui) — Svelte component library and design tokens
- [`@norbital-ai/std`](./packages/std) — common schema, date, CEL, finance, collection contract, and
  utility modules
- [`@norbital-ai/config`](./packages/config) — shared TypeScript and Svelte configuration

Templates are authored in [`norbital-ai/templates`](https://github.com/norbital-ai/templates),
which is also where `refs/heads/templates/*` is published from. This repository holds no template
source.

## Documentation

Docs live next to the code they describe — there is no root `docs/` folder:

| Area                | Location                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| Bolt framework      | [`packages/bolt/src/`](./packages/bolt/src)                                  |
| UI, std, config     | `packages/<name>/docs/`                                                      |
| Template workspaces | [`norbital-ai/templates`](https://github.com/norbital-ai/templates)          |
| Release contracts   | [`release/README.md`](./release/README.md), [`RELEASING.md`](./RELEASING.md) |

## Development

Requires Node.js 26+ and pnpm 11.15.1.

```sh
pnpm install
pnpm check
```

Every compiled package rebuilds from source during `pnpm pack`; Bolt and UI use `svelte-package`,
while the TypeScript-only packages use `tsc`. Publication checks remove existing build output,
create temporary standalone archives, validate their contents, and delete the archives afterward.
Consumers install released packages from the configured registry; no consumer reads this repository
through a sibling path.

Public packages intentionally remain at `0.0.1` throughout beta. A package change on `main` replaces
the complete fixed-version package set in GitHub Packages; consumers must commit the resulting
lockfile integrity update. See [`RELEASING.md`](./RELEASING.md) for the release workflow.

Template source is published as deterministic root-projected Git refs, each carrying its own
`norbital.template.json` and its own committed `pnpm-lock.yaml`. There is no platform release and no
published image. The provider-neutral distribution contract is documented in
[`release/README.md`](./release/README.md).

## License

Licensed under the [GNU Affero General Public License v3.0](./LICENSE).
If you modify Norbital OSS and make it available to users over a network,
AGPLv3 requires you to offer those users the corresponding source code.
