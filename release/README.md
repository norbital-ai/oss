# Distribution contracts

Norbital OSS publishes four independent, immutable resource types:

1. npm packages for `@norbital-ai/config`, `platform-utils`, `pod`, `std`, and `ui`, identified
   by exact registry tarball URL and sha512 SRI;
2. root-projected Git refs for template workspace source;
3. one generic tenant builder image and one generic tenant runtime image;
4. a platform release manifest that pins the package versions, template commits, and image digests.

There is no prebuilt template bundle and no OSS checkpoint artifact. A compatible host produces one
tenant build bundle from a tenant Git tree and a platform release; a checkpoint references that
bundle rather than storing a duplicate.

## Template catalogue and refs

[`templates.json`](./templates.json) is the source catalogue. Its schema is
[`templates.schema.json`](./templates.schema.json). The catalogue owns display metadata,
compatibility, and the active set. `pnpm templates:check` validates declared paths and recomputes
the collection, app, and automation counts from source.

Each active template is projected to repository root with `git subtree split`:

| Template       | Source directory                   | Published ref                       |
| -------------- | ---------------------------------- | ----------------------------------- |
| BCA            | `template_workspaces/bca`          | `refs/heads/templates/bca`          |
| Construction   | `template_workspaces/construction` | `refs/heads/templates/construction` |
| CRM            | `template_workspaces/crm`          | `refs/heads/templates/crm`          |
| HR and payroll | `template_workspaces/hr-payroll`   | `refs/heads/templates/hr-payroll`   |

The projection is deterministic for a source commit and retains per-template ancestry. Consumers
read the catalogue from a configured repository URL, ref, and path, then fetch the exact projected
commit. They do not need a GitHub API and can use any standards-compliant Git server.

Projected manifests contain ordinary public registry ranges rather than `workspace:` or `catalog:`
protocols. Pod is pinned to exactly `0.0.1`, while compatible library packages use explicit SemVer
ranges. Before a ref is published, `validate-template-projections.mjs` copies only tracked template
files into clean standalone roots, installs exact locally packed public archives, runs Pod sync,
type-checks, and builds every template.

`template-refs.yml` publishes the refs on changes to `main`. The underlying command is
provider-neutral:

```sh
node scripts/project-templates.mjs \
  --source-revision HEAD \
  --repository https://git.example.test/norbital/oss.git \
  --push origin \
  --output dist/template-revisions.json
```

All active refs are pushed atomically and fast-forward only. A history rewrite therefore fails
rather than silently replacing an already published template revision or publishing only part of
the active set.

## Platform releases

`publish-platform.yml` builds the builder and runtime images, enforces the configured 500 MiB
uncompressed image ceiling, records their immutable digests, resolves the template projections,
and generates `platform-release.json` against
[`platform-release.schema.json`](./platform-release.schema.json). GitHub Actions publishes that
file as both an attested workflow artifact and an immutable GitHub release asset.

Before image construction, `resolve-published-packages.mjs` reads each exact package version from
the configured npm-compatible registry packument, downloads `dist.tarball`, verifies
`dist.integrity`, and validates the same standalone archive contract as `pnpm publication:check`.
The verified bytes are retained as deterministic package inputs to the builder image; the image
never re-resolves a version from the registry. Credentials are accepted through environment
variables and are never written into the manifest or image. The resulting package release file is
an input to the provider-neutral generator:

```sh
NPM_REGISTRY_TOKEN=... node scripts/resolve-published-packages.mjs \
  --registry https://registry.example.test \
  --output dist/package-release.json \
  --archive-output dist/package-archives

node scripts/generate-platform-release.mjs \
  --source-repository https://git.example.test/norbital/oss.git \
  --source-revision "$SOURCE_SHA" \
  --package-release dist/package-release.json \
  --template-revisions dist/template-revisions.json \
  --builder-image registry.example.test/norbital/builder \
  --builder-digest "sha256:$BUILDER_DIGEST" \
  --runtime-image registry.example.test/norbital/runtime \
  --runtime-digest "sha256:$RUNTIME_DIGEST"
```

[`template-toolchain.package.json`](./template-toolchain.package.json) is the builder-owned union of
external runtime and type-check dependencies declared by every active template. Its versions are
exact, resolved from the repository lockfile, and its 16-hex dependency key is recorded in the
builder image. `pnpm template-toolchain:check` fails whenever an active template manifest or
lockfile changes without regenerating this contract. Template-only libraries such as `exceljs`
therefore remain template dependencies rather than becoming false Pod dependencies, while
no-network tenant builds and checks can still resolve them from the versioned toolchain.

Each package entry carries `{ name, version, tarball, integrity }`, where `integrity` is an exact
sha512 SRI. The 16-hex `packageKey` hashes sorted `{ name, version, integrity }` entries. The
generator derives a 64-hex `buildContractId` from that package content, builder/runtime image
digests, and compiler contract. Provider locations are deliberately excluded from content identity,
so moving identical bytes to a registry mirror does not rebuild tenants. `releaseId` currently
equals the build contract. Template commits are also excluded: advancing a template must not
trigger a same-tree Pod rebuild for every tenant tracking platform updates.

The checked-in GitHub workflow defaults to GitHub Packages and GHCR. These repository variables can
redirect the same pipeline without changing source:

- `NORBITAL_PACKAGE_REGISTRY`
- `NORBITAL_OCI_REGISTRY`
- `NORBITAL_OCI_NAMESPACE`
- `NORBITAL_OCI_USERNAME`
- `NORBITAL_MAX_IMAGE_BYTES`
- `NORBITAL_BENCHMARK_TEMPLATE`

If the package registry requires authentication during image construction, configure the
`NPM_REGISTRY_TOKEN` Actions secret. GitHub Packages can use the workflow token. A non-GHCR OCI
registry can use the `NORBITAL_OCI_TOKEN` secret with `NORBITAL_OCI_USERNAME`.

The builder image contains the exact verified public package archives and exact active-template
dependencies under `/opt/norbital/tenant-toolchain`, including its `.package-key` and
`.template-dependency-key`. It bakes the matching browser platform and manifest into
`/opt/norbital/platform-client`. It has no entrypoint; a host scheduler can keep the container warm
with `sleep infinity` and execute Pod in `/workspace`. A portable Node compile cache under the
toolchain directory is populated while the image is built and reused by later Pod CLI processes,
so independent tenant executions do not repeatedly compile the same immutable module graph. The
runtime image contains only Node, has no entrypoint, and defaults to the already-built tenant bundle
mounted at `/workspace/serve.mjs`; it does not contain Pod or tenant source.

The versioned Node 26 builder labels its platform fingerprint and source revision. The minimal Node
26 runtime only serves the immutable `serve.mjs` emitted by Pod. Hosts may mirror either image; the
platform manifest identifies the executable content by OCI digest, so provider location is not
part of tenant build identity.

Every platform release runs sync, Pod check, and a complete build for every active template in the
digest-pinned builder with no network and a 1 GiB static-verification memory limit. It then runs
every template in a fresh 500 MiB benchmark container. Pod sync first materializes the ignored
generated workspace; the already-proven static checker is not repeated there. The first build
primes compiler caches, and the second measures the same prevalidated
`NORBITAL_POD_SYNCED=1`/`NORBITAL_POD_CHECKED=1` contract used by the tenant build runner. The
release is blocked unless every measured build completes in at most 5,000 ms while the warm-build
container has both `--memory=500m` and `--memory-swap=500m` and no network. The attested
`builder-toolchain-verification.json` and per-template benchmark files record the checks, elapsed
time, and cgroup memory peak when the runner exposes it.
A host must only offer a platform auto-update after the immutable platform manifest exists, so a
builder image that fails this gate is never eligible even if its OCI upload completed.
The evidence format is defined by [`builder-benchmark.schema.json`](./builder-benchmark.schema.json).
