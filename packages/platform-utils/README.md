# `@norbital-ai/platform-utils`

Portable contracts shared by Pod, tenant workspaces, and compatible hosts.

See the [platform utilities overview](./docs/README.md) for the package goal and ownership boundaries.

Capabilities:

- collection query and mutation types
- manifest parsing and context
- runtime wire and binding contracts
- system collection metadata
- seed planning
- tenant workspace migrations and build output
- tenant database providers

## Public exports

Use the narrowest documented subpath:

- `collection`, `collection/client`, and `collection/schemas`
- `manifest/context`, `manifest/parse`, and `manifest/types`
- `remote`, `remote/collection_wire_schemas`, and `remote/sveltekit-guard.server`
- `runtime/binding` and `runtime/wire`
- `scope/types`
- `seed/authoring`, `seed/execute`, `seed/manifest`, and `seed/plan`
- `storage/minio`
- `system/collections`, `system/column_names`, `system/types`, and `system/workspace-schema`
- `tenant_db/bootstrap`, `tenant_db/provider`, `tenant_db/schema`, and the optional Neon provider
  subpaths
- `tenant_workspace`, `tenant_workspace/source`, `tenant_workspace/build-output`, and migration
  subpaths

The MinIO parser and SvelteKit guard remain host adapters; neither is used for template delivery or
required by Pod's tenant workspace contract.

## Neon provider policy

`NeonTenantDbProvider` explicitly configures every project default and every endpoint it creates to
scale to zero after 300 seconds of inactivity. The provider deliberately leaves Neon's autoscaling
minimum and maximum unset, so this cost-control invariant does not replace the host's intended compute
sizing or plan defaults.

## Development

```sh
pnpm --filter @norbital-ai/platform-utils build
pnpm --filter @norbital-ai/platform-utils lint
pnpm --filter @norbital-ai/platform-utils test
```
