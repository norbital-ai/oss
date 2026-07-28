# Norbital OSS

The open-source workspace framework, UI system, shared libraries, and reference tenant workspaces
used by Norbital.

## Packages

- [`@norbital-ai/pod`](./packages/pod) — tenant workspace authoring SDK, runtime, and Vite plugin
- [`@norbital-ai/ui`](./packages/ui) — Svelte component library and design tokens
- [`@norbital-ai/platform-utils`](./packages/platform-utils) — shared manifests, wire contracts,
  migrations, and tenant database utilities
- [`@norbital-ai/std`](./packages/std) — common schema, date, CEL, finance, and utility modules
- [`@norbital-ai/config`](./packages/config) — shared TypeScript and Svelte configuration

The open-source reference workspaces live in [`template_workspaces/`](./template_workspaces).
They are tested as workspace members but marked private because they are source templates, not npm
packages.

## Development

Requires Node.js 26+ and pnpm 11.15.1.

```sh
pnpm install
pnpm check
```

`pnpm pack:local` creates ignored standalone archives for publication checks and registry
bootstrap testing. No consumer is expected to read this repository through a sibling path.

Run `pnpm changeset` with any change to a publishable package. See
[`RELEASING.md`](./RELEASING.md) for the release workflow.

Template source is published as deterministic root-projected Git refs, while generic builder and
runtime images are published by digest. The provider-neutral catalogue and release contracts are
documented in [`release/README.md`](./release/README.md).

## License

Source-available under the [Apache-2.0 + Commons Clause](./LICENSE). You may
freely use, modify, and redistribute Norbital OSS, including for your own
internal company use. You may not sell the software itself or charge for a
hosted offering, consulting, or support service whose value substantially
derives from its functionality without a separate license from Norbital.
