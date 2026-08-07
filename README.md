# Norbital OSS

The open-source workspace framework, UI system, and shared libraries used by Norbital.

Starter workspaces live in their own repository:
[**norbital-ai/templates**](https://github.com/norbital-ai/templates).

## Packages

- [`@norbital-ai/pod`](./packages/pod) — tenant workspace authoring SDK, runtime, and Vite plugin
- [`@norbital-ai/ui`](./packages/ui) — Svelte component library and design tokens
- [`@norbital-ai/platform-utils`](./packages/platform-utils) — shared manifests, wire contracts,
  migrations, and tenant database utilities
- [`@norbital-ai/std`](./packages/std) — common schema, date, CEL, finance, and utility modules
- [`@norbital-ai/config`](./packages/config) — shared TypeScript and Svelte configuration

`template_workspaces/` is a retained copy, not the source of truth. Templates are authored in
[`norbital-ai/templates`](https://github.com/norbital-ai/templates), which is also where
`refs/heads/templates/*` is published from. The copy here exists only until the Pod test suites
that boot a real workspace are moved onto a vendored fixture.

## Documentation

Docs live next to the code they describe — there is no root `docs/` folder:

| Area                            | Location                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Pod framework                   | [`packages/pod/docs/`](./packages/pod/docs)                                  |
| UI, std, config, platform-utils | `packages/<name>/docs/`                                                      |
| Template workspaces             | [`norbital-ai/templates`](https://github.com/norbital-ai/templates)          |
| Release contracts               | [`release/README.md`](./release/README.md), [`RELEASING.md`](./RELEASING.md) |

## Development

Requires Node.js 26+ and pnpm 11.15.1.

```sh
pnpm install
pnpm check
```

Every compiled package rebuilds from source during `pnpm pack`; Pod and UI use `svelte-package`,
while the TypeScript-only packages use `tsc`. Publication checks remove existing build output,
create temporary standalone archives, validate their contents, and delete the archives afterward.
Consumers install released packages from the configured registry; no consumer reads this repository
through a sibling path.

Run `pnpm changeset` with any change to a publishable package. See
[`RELEASING.md`](./RELEASING.md) for the release workflow.

Template source is published as deterministic root-projected Git refs, each carrying its own
`norbital.template.json` and its own committed `pnpm-lock.yaml`. There is no platform release and no
published image. The provider-neutral distribution contract is documented in
[`release/README.md`](./release/README.md).

## License

Licensed under the [GNU Affero General Public License v3.0](./LICENSE).
If you modify Norbital OSS and make it available to users over a network,
AGPLv3 requires you to offer those users the corresponding source code.
