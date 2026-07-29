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

The `Publish template refs` workflow projects each `template_workspaces/<key>` directory to
`refs/heads/templates/<key>`. It publishes source commits, not template archives or prebuilt tenant
bundles. Picker metadata lives in each template's own `norbital.template.json`, so it projects with
the template rather than sitting in a catalogue that has to be kept in sync.

## Template dependencies

A template pins its own dependencies in a committed `pnpm-lock.yaml` and pins its own
`@norbital-ai/pod` version. Nothing propagates a bump into it — a developer commits one when they
choose to:

```sh
pnpm templates:lock          # resolve and write
pnpm templates:lock:check    # fail on drift (part of `pnpm check`)
pnpm templates:lock:verify   # prove the lockfile installs offline from a warm store
```

Publishing a new pod version does not touch any template, and does not rebuild any tenant. A tenant
is _told_ a newer pod exists and that adopting it may break its template; adopting it is a commit in
the tenant's own tree, and `git revert` is the rollback.

There is no platform release, no builder image, and no runtime image. See
[`release/README.md`](./release/README.md) for the complete distribution contract.
