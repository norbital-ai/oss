# Distribution contracts

Norbital OSS publishes four independent, immutable resource types:

1. npm packages for `@norbital-ai/config`, `platform-utils`, `pod`, `std`, and `ui`;
2. root-projected Git refs for template workspace source;
3. one generic tenant builder image and one generic tenant runtime image;
4. a platform release manifest that pins the package versions, template commits, and image digests.

There is no prebuilt template bundle. There is also no OSS checkpoint artifact. The private host
produces one tenant build bundle from a tenant Git tree and a platform release; a checkpoint only
references that bundle, so storing another checkpoint copy would duplicate the same artifact.

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

The generator has no GitHub dependency. All endpoints and identities are inputs:

```sh
node scripts/generate-platform-release.mjs \
  --source-repository https://git.example.test/norbital/oss.git \
  --source-revision "$SOURCE_SHA" \
  --package-registry https://registry.example.test \
  --template-revisions dist/template-revisions.json \
  --builder-image registry.example.test/norbital/builder \
  --builder-digest "sha256:$BUILDER_DIGEST" \
  --runtime-image registry.example.test/norbital/runtime \
  --runtime-digest "sha256:$RUNTIME_DIGEST"
```

The generator derives a 64-hex `buildContractId` from exact package coordinates, package registry,
builder/runtime image digests, and compiler contract. `releaseId` currently equals that immutable
build contract. Template commits are deliberately excluded: advancing a template must not trigger
a same-tree Pod rebuild for every tenant tracking platform updates. Templates retain their own
exact refs and revisions in the catalogue.

The checked-in GitHub workflow defaults to GitHub Packages and GHCR. These repository variables can redirect
the same pipeline without changing source:

- `NORBITAL_PACKAGE_REGISTRY`
- `NORBITAL_OCI_REGISTRY`
- `NORBITAL_OCI_NAMESPACE`
- `NORBITAL_OCI_USERNAME`
- `NORBITAL_MAX_IMAGE_BYTES`
- `NORBITAL_BENCHMARK_TEMPLATE`

If the package registry requires authentication during image construction, configure the
`NPM_REGISTRY_TOKEN` Actions secret. GitHub Packages can use the workflow token. A non-GHCR OCI
registry can use the `NORBITAL_OCI_TOKEN` secret with `NORBITAL_OCI_USERNAME`.

The builder image contains the exact public package versions under
`/opt/norbital/tenant-toolchain`, including its `.package-key`, and bakes the matching browser
platform into `/opt/norbital/platform-client`. It has no entrypoint; Core keeps the container warm
with `sleep infinity` and executes Pod in `/workspace`. The runtime image contains only Node, has no
entrypoint, and defaults to the already-built tenant bundle mounted at `/workspace/serve.mjs`; it
does not contain Pod or tenant source.

Every platform release also runs an active catalogue template twice in the digest-pinned builder.
The first build primes the generated workspace and compiler caches; the second is the measured warm
build. The release is blocked unless that build completes in at most 5,000 ms while the container
has both `--memory=500m` and `--memory-swap=500m` and no network. The attested
`builder-benchmark.json` records elapsed time and the cgroup memory peak when the runner exposes it.
Core must only offer a platform auto-update after the immutable platform manifest exists, so a
builder image that fails this gate is never eligible even if its OCI upload completed.
The evidence format is defined by [`builder-benchmark.schema.json`](./builder-benchmark.schema.json).
