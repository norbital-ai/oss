# Distribution contracts

Norbital OSS publishes two independent, immutable resource types:

1. exact public package archives for `@norbital-ai/config`, `platform-utils`, `pod`, `std`, and `ui`;
2. root-projected Git refs for template workspace source, each carrying its own committed
   `pnpm-lock.yaml`.

There is no platform release, no builder image, no runtime image, and no OCI publication. Those
existed to pin dependencies from outside a template that could not pin its own; a committed lockfile
does that job directly, so the apparatus around it is gone.

There is no prebuilt template bundle and no OSS checkpoint artifact. A compatible host produces one
tenant build bundle from a tenant Git tree; a checkpoint references that bundle rather than storing
a duplicate.

## Three independent trains

Pod, templates, and tenants do not propagate into one another. They respect each other's APIs and
move only when their own owner moves them.

| Train        | Moves when                                                                           |
| ------------ | ------------------------------------------------------------------------------------ |
| **Pod**      | changesets → version bump → publish. A normal npm package.                           |
| **Template** | a developer edits source and pushes. It pins its own pod version until they bump it. |
| **Tenant**   | its owner says so. Forked from a template, managed independently.                    |

The only coupling is **notification**: a tenant can be told its upstream template is N commits
ahead, or that a newer `@norbital-ai/pod` exists and may break it. Neither acts.

## Template catalogue and refs

There is no separate catalogue file. A template declares itself by carrying
`norbital.template.json` at the root of its own tree, so the picker metadata travels with the
`git subtree split` projection and lands in every tenant fork — nothing has to stay in sync across
two files. `pnpm templates:check` discovers every workspace on disk and recomputes the collection,
app, and automation counts from source.

| Template       | Source directory                   | Published ref                       |
| -------------- | ---------------------------------- | ----------------------------------- |
| Field Operations | `template_workspaces/field-operations` | `refs/heads/templates/field-operations` |
| Construction   | `template_workspaces/construction` | `refs/heads/templates/construction` |
| CRM            | `template_workspaces/crm`          | `refs/heads/templates/crm`          |
| HR and payroll | `template_workspaces/hr-payroll`   | `refs/heads/templates/hr-payroll`   |
| Reclamation    | `template_workspaces/reclamation`  | `refs/heads/templates/reclamation`  |

The projection is deterministic for a source commit and retains per-template ancestry. A consumer
resolves the active set with one `git ls-remote --heads <url> 'refs/heads/templates/*'` round trip
and fetches the exact projected commit. No provider API, no mirror, no local clone of the whole
repository.

Projected manifests contain ordinary public registry versions rather than `workspace:` or `catalog:`
protocols, and pod is pinned to an exact version. Before a ref is published,
`validate-template-projections.mjs` copies only tracked template files into clean standalone roots,
installs exact locally packed public archives, runs Pod sync, type-checks, and builds every
template. It deliberately installs with `--no-frozen-lockfile` because it substitutes local
unpublished archives for the registry versions the committed lockfile describes; lockfile freshness
and offline installability belong to `pnpm templates:lock:verify`.

`template-refs.yml` publishes the refs on changes to `main`. The underlying command is
provider-neutral:

```sh
node scripts/project-templates.mjs \
  --source-revision HEAD \
  --repository https://git.example.test/norbital/oss.git \
  --push origin \
  --output dist/template-revisions.json
```

All refs are pushed atomically and fast-forward only. A history rewrite therefore fails rather than
silently replacing an already published template revision or publishing only part of the set.

## Template lockfiles

Each template commits a `pnpm-lock.yaml` resolved as a standalone project — outside this pnpm
workspace, so `@norbital-ai/*` come from the registry rather than workspace links.
It also carries its own `pnpm-workspace.yaml`. That policy exempts only explicitly reviewed,
exact-version Norbital releases from pnpm's minimum-release-age gate; third-party packages and
future Norbital versions remain subject to the gate until the template deliberately trusts them.

```sh
pnpm templates:lock          # resolve and write
pnpm templates:lock:check    # fail on drift (part of `pnpm check`)
pnpm templates:lock:verify   # warm one shared store, then install offline with no credentials
```

`templates:lock:verify` is the load-bearing gate: it proves the committed lockfile is what a host
actually installs, by warming one shared content-addressed store over the network and then
installing with credentials removed and `--offline`. A shared store across templates also exercises
cross-template package reuse.

Running it is a template developer's deliberate act when **they** choose to bump dependencies. It is
never triggered by a pod publish.

## Depsets and the store

A **depset** is `node_modules` for exactly one lockfile, addressed by the hash of that lockfile.
`scripts/lib/depset.mjs` implements the host half:

- `warmStore` — `pnpm fetch` into the shared content-addressed store. The only step that touches the
  network, and the only step that needs registry credentials.
- `materialize` — `pnpm install --offline --frozen-lockfile` into `node_modules/<lockHash>`,
  idempotent, and published by rename so a failed install never leaves a half-materialized depset
  visible.

`node_modules` is a hardlink farm into the store, so N trees sharing a package is one copy on disk.
A CRM tenant contains CRM's dependencies and nothing else — there is no curated union, so
`exceljs` no longer travels to templates that never asked for it.

This mirrors Core's `sandbox/toolchain.server.ts`; the two must agree on `lockHash` or a
host-materialized depset would not be reusable.

## Budgets

Three numbers, measured separately, never compared:

| Budget             | Where                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `compileMs`        | `benchmark-builder.mjs` — `vite build` against a materialized depset on a fixed CI runner. Evidence: [`builder-benchmark.schema.json`](./builder-benchmark.schema.json). |
| `deployCacheHitMs` | live SLO, measured against a real tenant deploy                                                                                                                          |
| `deployColdMs`     | live SLO, measured against a real tenant deploy                                                                                                                          |

Conflating the first with the last is what let an acceptance run report 5807 ms against a 5 s gate
that had never measured the same thing.

`smoke-runtime-bundle.mjs` proves the bundle contract: a build against a materialized depset
produces a bundle that boots and emits its ready frame. The bundle format is the only cross-version
contract left now that there are no images, so it is versioned and asserted in CI. Evidence:
[`runtime-smoke.schema.json`](./runtime-smoke.schema.json).

## Package archives

`resolve-published-packages.mjs` reads each exact package version from an npm-compatible registry
packument, downloads `dist.tarball`, and verifies `dist.integrity`. Each entry carries
`{ name, version, tarball, integrity }` where `integrity` is an exact sha512 SRI, and the 16-hex
`packageKey` hashes the sorted entries. Credentials are accepted through environment variables and
are never written into any published file.

Two repository variables configure the pipeline:

- `NORBITAL_PACKAGE_REGISTRY`
- `NORBITAL_PACKAGE_SOURCE` (`workspace` or `registry`)

If the package registry requires authentication, configure the `NPM_REGISTRY_TOKEN` Actions secret.
GitHub Packages can use the workflow token.
