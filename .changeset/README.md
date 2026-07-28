# Changesets

Every pull request that changes a publishable package should include a changeset:

```sh
pnpm changeset
```

Select each affected `@norbital-ai/*` package, choose the SemVer bump, and describe what changed,
why, and any consumer migration required. Template-only and documentation-only changes do not need
a changeset.
