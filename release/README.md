# Distribution contracts

Norbital OSS publishes one immutable resource type: exact public package archives for
`@norbital-ai/bolt`, `bolt-protocol`, `bolt-server`, `config`, `std`, and `ui`.

Template source is the other half of the distribution story, and it is published from the template
repositories rather than from here — see [Templates](#templates) below.

There is no platform release, no builder image, no runtime image, and no OCI publication. Those
existed to pin dependencies from outside a template that could not pin its own; a committed lockfile
does that job directly, so the apparatus around it is gone.

There is no prebuilt template bundle and no OSS Preview artifact. A compatible host produces one
tenant build bundle from the exact commit being previewed; Review reuses that same bundle rather
than storing or provisioning a duplicate.

## Three independent trains

Bolt, templates, and tenants do not propagate into one another. They respect each other's APIs and
move only when their own owner moves them.

| Train        | Moves when                                                                            |
| ------------ | ------------------------------------------------------------------------------------- |
| **Bolt**     | a change lands on `main` → publish the seven-package set, attested per archive.       |
| **Template** | a developer edits source and pushes. It pins its own bolt version until they bump it. |
| **Tenant**   | its owner says so. Forked from a template, managed independently.                     |

The only coupling is **notification**: a tenant can be told its upstream template is N commits
ahead, or that a newer `@norbital-ai/bolt` exists and may break it. Neither acts.

## Templates

Template distribution is **not** owned here any more. Templates live in their own repositories —
[`norbital-ai/templates`](https://github.com/norbital-ai/templates) (public, advertised on the
website) and `norbital-ai/templates-private` (not advertised) — and each carries the tooling that
used to sit in this repository: projection to `refs/heads/templates/<key>`, per-template lockfile
resolution and offline-install verification, and standalone projection validation.

The contract a host consumes is unchanged, only wider: it resolves the active set with one
`git ls-remote --heads <url> 'refs/heads/templates/*'` **per configured remote** and merges the
results, so template keys must be unique across the remotes. Which repository a template lives in
decides exactly one thing — whether the website advertises it.

See the template repositories' own READMEs for the projection and lockfile contracts.

## Package archives

`resolve-published-packages.mjs` resolves and verifies the release set. From the registry source it
reads each exact package version from an npm-compatible registry packument, downloads
`dist.tarball`, and verifies `dist.integrity`; from the workspace source it packs each public
package from source in a staging directory and computes the sha512 integrity of its own archives.
Each entry carries `{ name, version, tarball, integrity }` where `integrity` is an exact sha512 SRI,
and the 16-hex `packageKey` hashes the sorted name/version/integrity content identity. The release
workflow records that key in its job summary — it changes with any change to built output, so it is
an audit record of what was published rather than a value that can be asserted against a constant —
then publishes each archive with `npm publish --provenance`; a version already on the registry is
skipped so the set converges without a failed release. Credentials are accepted through environment
variables and are never written into any published file.

Two repository variables configure the pipeline:

- `NORBITAL_PACKAGE_REGISTRY`
- `NORBITAL_PACKAGE_SOURCE` (`workspace` or `registry`)

If the package registry requires authentication, configure the `NPM_REGISTRY_TOKEN` Actions secret.
GitHub Packages can use the workflow token.
