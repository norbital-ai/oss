# Generated Files, Builds, and Refresh

## Source-to-runtime map

```text
oss/packages/* ──build──► yalc (local) or registry release (deployed)
       │                              │
       ├────────► Colony + Website node_modules
       └────────► Template node_modules ──bolt sync──► immutable tenant artifact
                                                        │
templates/* ─────────────────────────────────────────────┘
                                                        ▼
                                               Colony publishes + routes
```

| Tree                    | Owns                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `oss/packages/*`        | Bolt compiler/runtime/protocol, UI, std, config package source                                |
| `templates*/*`          | Tenant source, assets, migrations, template metadata                                          |
| `seed_bank`             | Per-template fixture trees (`<collection>.json` per collection, asset media) loaded by Colony |
| `norbital/apps/colony`  | Hosting, compilation orchestration, releases, routes, tenant DBs                              |
| `norbital/apps/website` | Marketing/docs UI; public template pages fetched at build time                                |

Saving source changes only its owner. A tenant changes only after `bolt sync` emits a new artifact
and Colony publishes and routes it.

## Generated files

`bolt sync` validates the filesystem, preserves the last valid generated modules on structural
failure, and owns:

```text
.norbital/
├── config/doctor/              # committed: doctor.config.mts + YAML extensions
├── diagnosis/                  # ignored
├── dist/                       # ignored client build (workspace.js + assets/)
├── artifact/                   # ignored portable server artifact (bundle.mjs, bundle-entry.mjs)
├── generated/                  # ignored: models, types, collections, client, i18n-messages, app.css
├── migrations/                 # committed migration history
├── types/**/$types.d.ts        # ignored
└── tsconfig.json               # ignored
```

Never edit generated output. Ignore generated paths individually; never ignore `.norbital/` as a
whole because migrations and doctor configuration are committed. The authored `tsconfig.json` extends
`.norbital/tsconfig.json`.

## Local package propagation

Local OSS changes cross five boundaries. One command covers the first four:

```sh
pnpm run env -- link
```

1. Build `oss/packages/<name>/build`.
2. Publish that build into the yalc store.
3. Copy it into each consumer's `.yalc/`.
4. Hand `node_modules` back to pnpm (`yalc add --pure` + install) so it re-materializes its
   virtual-store copy.
5. Run `bolt sync`, then restart Colony so its bootstrap publishes and routes the new artifact.

`env -- link` ends by verifying that every workspace resolves through pnpm's store and actually
imports, so a missed hop fails the command instead of surfacing later as an edit that did nothing.

The realm command performs all five for Colony and templates and also links OSS packages into the
website:

```bash
# Colony must be stopped; --ui refuses to run over an existing :5173 process.
pnpm --dir norbital run env -- dev --ui
pnpm --dir norbital run env -- dev --ui --template=<directory-or-handle>
```

For an OSS change used only by Colony/Website, `pnpm --dir norbital run env -- link` establishes or
updates the pure links. Restart the website after linking; Vite dependency optimization is not
package HMR. Run `pnpm --dir norbital run env -- retreat` before a release build or commit so exact
registry pins and lockfiles are restored in Colony, the website and both template repositories.

## Local refresh matrix

| Changed                                      | Automatic while dev server runs | Required action                                     |
| -------------------------------------------- | ------------------------------- | --------------------------------------------------- |
| Colony route/component/server module         | Usually Vite HMR                | Reload; restart for `.env`, bootstrap, dependencies |
| Website route/component/server module        | Usually Vite HMR                | Reload                                              |
| Any OSS package consumed by a template       | No                              | realm `env -- dev --ui`; hard-refresh tenant        |
| OSS `config`, `std`, or `ui` used by website | No                              | `norbital env -- link`; restart website             |
| Template source, asset, migration, or i18n   | No                              | `pnpm sync`; restart Colony through realm command   |
| Template manifest / catalogue membership     | No                              | restart Colony                                      |
| Template README/thumbnail on local website   | No local source path            | publish public template refs; rebuild website       |

Colony's Vite graph does not import template source. A generated bundle appearing on disk does not
change the artifact already routed to a tenant.

`env:reset` is not a refresh. A normal Colony restart recompiles and reroutes while preserving tenant
data, but Studio's persisted source snapshot remains unchanged. Use reset only when intentionally
replacing that snapshot and accepting recreation of the seeded database.

## Staging and production

Yalc never crosses an environment boundary.

| Change                   | Staging/production path                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OSS package              | publish one coherent six-package version → update exact pins/locks in Norbital and affected templates → publish template refs → deploy              |
| Template                 | merge to the template repository `main` → projection workflow validates, publishes the immutable build package, then moves `refs/heads/templates/*` |
| Colony                   | deploy committed Norbital build to staging (`master`) → verify → promote the same tree to production (`production`)                                 |
| Website                  | deploy committed website build through the same staging/production branch policy                                                                    |
| Template website content | publish the public template projection, then rebuild/redeploy the prerendered website                                                               |

Remote template refresh affects catalogue reads and new provisioning. Existing tenants retain their
source snapshot and routed artifact until the host rebuilds them. There is no non-destructive
`tenant:update`. Advance a tenant with `pnpm run env -- reset` (Colony down for a local target;
signed operations for staging/production). Do not invent a second update command.

## Verification

In the selected template:

```bash
pnpm sync
pnpm lint
```

`pnpm sync` is the build: it regenerates types, builds the browser client, emits migrations, and
writes the portable artifact. The template packages currently have no separate `build` script.

For repository gates, run the relevant template repository check and focused OSS tests. A green
template build does not prove the running tenant changed; verify the routed tenant after Colony
bootstrap or deployment.

## Forbidden legacy authoring

Never author `schema.ts`, `workspace.ts`, collection `*.schema.ts`, `defineTable`, `defineSchema`,
`QueryRow`, global `NorbitalAuthoring` augmentation, `$tenant`, collection/app barrels,
`collections/**/*.schema.ts` globs, `apps/*/App.svelte`, `$lib`, `$app/*`, `@sveltejs/kit`, routes,
`+page` files, `svelte.config.*`, duplicate base CSS, or custom tenant build scripts.
