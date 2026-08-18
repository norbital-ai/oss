# Distribution contracts

Norbital OSS publishes one immutable resource type: exact public package archives for
`@norbital-ai/bolt`, `bolt-protocol`, `bolt-server`, `config`, `std`, and `ui`.

Template source is the other half of the distribution story, and it is published from the template
repositories rather than from here — see [Templates](#templates) below.

There is no platform release, no builder image, no runtime image, and no OCI publication. Those
existed to pin dependencies from outside a template that could not pin its own; a committed lockfile
does that job directly, so the apparatus around it is gone.

There is no prebuilt template bundle and no OSS checkpoint artifact. A compatible host produces one
tenant build bundle from a tenant Git tree; a checkpoint references that bundle rather than storing
a duplicate.

## Three independent trains

Bolt, templates, and tenants do not propagate into one another. They respect each other's APIs and
move only when their own owner moves them.

| Train        | Moves when                                                                            |
| ------------ | ------------------------------------------------------------------------------------- |
| **Bolt**     | changesets → version bump → publish. A normal npm package.                            |
| **Template** | a developer edits source and pushes. It pins its own bolt version until they bump it. |
| **Tenant**   | its owner says so. Forked from a template, managed independently.                     |

The only coupling is **notification**: a tenant can be told its upstream template is N commits
ahead, or that a newer `@norbital-ai/bolt` exists and may break it. Neither acts.

## Templates

Template distribution is **not** owned here any more. Templates live in their own repositories —
[`norbital-ai/templates`](https://github.com/norbital-ai/templates) (public, advertised on the
website) and `norbital-ai/templates-private` (not advertised) — and each carries the tooling that
used to sit in this repository: projection to `refs/heads/templates/<key>`, per-template lockfile
resolution and offline-install verification, standalone projection validation, depset
materialization, and the runtime bundle smoke test.

The contract a host consumes is unchanged, only wider: it resolves the active set with one
`git ls-remote --heads <url> 'refs/heads/templates/*'` **per configured remote** and merges the
results, so template keys must be unique across the remotes. Which repository a template lives in
decides exactly one thing — whether the website advertises it.

See the template repositories' own READMEs for the projection, lockfile, and depset contracts.

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
