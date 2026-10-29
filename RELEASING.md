# Releasing

All public packages carry one version, taken from the workspace manifest, and move together.
A package change on `main` publishes the complete set to GitHub Packages so internal package
versions and archive integrity stay coherent.

## Contributor flow

1. Make and verify the package change with `pnpm check`.
2. Keep every public package manifest at the workspace version in the root `package.json`.
3. Merge to `main`. CI runs the unit suite and the package gates; the release workflow starts only
   once CI has passed, on the exact commit CI passed, and builds, packs, and publishes each package
   whose version is not already on the registry, using the attested archives prepared by
   `resolve-published-packages.ts`. It does not re-run CI's unit, lint and type suite; it does run
   `publication:check` again on the packed archives.
4. After the release publishes, re-resolve and commit every consumer lockfile. A consumer manifest
   bumped to the new version while its lockfile still pins the old one fails its frozen install, so the manifest bump and the lockfile
   must land in the same commit — and neither can land before the version exists on the registry.

`readPublicPackageEntries` rejects any package whose version differs from the workspace version —
the set is coherent or it does not publish. No specific version is required, only one shared one.

## Package registry

The workflow defaults the repository variable
`NORBITAL_PACKAGE_REGISTRY` to GitHub Packages (`https://npm.pkg.github.com`). Publication uses
`npm publish --provenance` on the pre-packed archives under `dist/package-archives/`; the resolved
package key is recorded in the job summary as the audit record of exactly which bytes were
published. Set
`NPM_REGISTRY_TOKEN` when publication needs a separate credential (the workflow falls back to the
GitHub token). An already-published version is skipped, not failed — the set converges rather than
turning an ordinary source-only push into a red release. Published archives carry the `realm-v25`
dist-tag; `latest` is not moved, so consumers should pin exact versions. A deployed pin keeps meaning
the bytes it was tested with. Consumers configure the `@norbital-ai`
scope and a read token through `.npmrc`.

## Template releases

Templates are released from their own repositories, whose CI builds each template once and uploads its
release (bundle, source and seed, each named by its digest) to the release store, and which own their
dependency locking. This repository publishes packages
and, separately, the Convert service image.

There is no platform release, no builder image, and no tenant-runtime image. See
[`release/README.md`](./release/README.md) for the complete distribution contract.
