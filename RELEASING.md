# Releasing

All public packages intentionally use the fixed version `0.0.1` while Norbital is in beta. A package
change on `main` replaces the complete seven-package set in GitHub Packages so internal package
versions and archive integrity stay coherent.

## Contributor flow

1. Make and verify the package change with `pnpm check`.
2. Keep every public package manifest at exactly `0.0.1`.
3. Merge to `main`. CI runs the unit suite and the package gates; the release workflow starts only
   once CI has passed, on the exact commit CI passed, and builds, packs, and publishes each package
   whose version is not already on the registry, using the attested archives prepared by
   `resolve-published-packages.mjs`. It does not re-run CI's checks.
4. Re-resolve and commit every consumer lockfile because replacing fixed-version archives changes
   their integrity hashes.

The release workflow and script tests reject a public package version other than `0.0.1`. Normal
SemVer releases can replace this policy when the beta period ends.

## Package registry

The workflow defaults the repository variable
`NORBITAL_PACKAGE_REGISTRY` to GitHub Packages (`https://npm.pkg.github.com`). Publication uses
`npm publish --provenance` on the pre-packed archives under `dist/package-archives/`; the resolved
package key is recorded in the job summary as the audit record of exactly which bytes were
published. Set
`NPM_REGISTRY_TOKEN` when publication needs a separate credential (the workflow falls back to the
GitHub token). An already-published version is skipped, not failed — the set converges rather than
turning an ordinary source-only push into a red release. Consumers configure the `@norbital-ai`
scope and a read token through normal npm/pnpm configuration. The fixed-version replacement policy
depends on GitHub Packages' delete-and-republish behavior and is intentionally limited to the beta
period.

## Template refs

Templates are published from their own repositories, which own the projection to
`refs/heads/templates/<key>` and their own dependency locking. This repository publishes packages
only.

There is no platform release, no builder image, and no runtime image. See
[`release/README.md`](./release/README.md) for the complete distribution contract.
