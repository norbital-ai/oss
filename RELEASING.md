# Releasing

All public packages intentionally use the fixed version `0.0.1` while Norbital is in beta. A package
change on `main` replaces the complete five-package set in GitHub Packages so internal package
versions and archive integrity stay coherent.

## Contributor flow

1. Make and verify the package or template change with `pnpm check`.
2. Keep every public package manifest at exactly `0.0.1`.
3. Merge to `main`. The release workflow builds all five packages, removes their prior registry
   versions, and publishes one new `0.0.1` set sequentially.
4. Re-resolve and commit every consumer lockfile because replacing fixed-version archives changes
   their integrity hashes.

The release workflow and script tests reject a public package version other than `0.0.1`. Normal
SemVer releases can replace this policy when the beta period ends.

## Package registry

The workflow defaults the repository variable
`NORBITAL_PACKAGE_REGISTRY` to GitHub Packages (`https://npm.pkg.github.com`). GitHub's workflow
token deletes and republishes the five repository-owned packages there; set `NPM_REGISTRY_TOKEN`
when publication needs a separate credential. Consumers configure the `@norbital-ai` scope and a
read token through normal npm/pnpm configuration. The fixed-version replacement policy depends on
GitHub Packages' delete-and-republish behavior and is intentionally limited to the beta period.

## Template refs

Templates are published from their own repositories, which own the projection to
`refs/heads/templates/<key>` and their own dependency locking. This repository publishes packages
only.

There is no platform release, no builder image, and no runtime image. See
[`release/README.md`](./release/README.md) for the complete distribution contract.
