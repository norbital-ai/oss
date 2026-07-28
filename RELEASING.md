# Releasing

Changesets records release intent in pull requests, maintains package changelogs and versions in a
release pull request, and publishes merged releases from GitHub Actions.

## Contributor flow

1. Make and verify the package or template change with `pnpm check`.
2. Run `pnpm changeset` when a publishable package changed.
3. Commit the generated `.changeset/*.md` file with the change.
4. Merge to `main`. The release workflow opens or updates the `Version packages` pull request.
5. Merge that pull request when the listed versions are ready to publish.

Package versions are independent. When a released package changes an internal `workspace:*`
dependency, Changesets applies the configured patch bump to affected dependents.

## Package registry

The workflow uses standard npm protocol and defaults the repository variable
`NORBITAL_PACKAGE_REGISTRY` to GitHub Packages (`https://npm.pkg.github.com`). GitHub's workflow
token publishes there; set `NPM_REGISTRY_TOKEN` when the configured registry needs a separate
credential. Consumers configure the `@norbital-ai` scope and a read token through normal npm/pnpm
configuration. No application code depends on GitHub's API, so Verdaccio, Artifactory, npmjs, or
another compatible registry can replace it without a code change.

## Template refs

The `Publish template refs` workflow projects each active `template_workspaces/<key>` directory to
`refs/heads/templates/<key>`. It publishes source commits, not template archives or prebuilt tenant
bundles. Catalogue metadata and the active set live in
[`release/templates.json`](./release/templates.json).

## Platform release

After the package versions in `main` are available from the configured registry, dispatch
`Publish platform release` with a new human release name, or push a matching `platform-v*` tag.
The workflow:

1. verifies every standalone npm archive;
2. installs the exact package versions into the generic builder image;
3. publishes builder and minimal runtime images to GHCR with SBOM and provenance;
4. enforces the configured 500 MiB image ceiling;
5. resolves exact template commits;
6. publishes an attested platform release manifest as a GitHub release asset.

Never reuse a platform release name or tag. The manifest derives its immutable 64-hex build
contract from the package coordinates and OCI digests. Core pins that contract and both image
digests for existing tenants, so a new Pod version or image is always a new release. See
[`release/README.md`](./release/README.md) for provider-neutral inputs and the complete contract.
