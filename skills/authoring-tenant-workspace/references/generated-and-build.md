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
| `templates*/*`          | Tenant source, assets, migrations, template metadata; target committed `.norbital/shared` Skill packages |
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
whole because migrations and doctor configuration are committed. The active toolchain/Effect RFCs
add one more explicit exception: `.norbital/shared/**` is committed tenant Skill source, whereas
`.norbital/personal/**` remains ignored and is never a build/release input. The compiler does not yet
accept the new Skill layout, so this is a pending cutover contract, not permission to add a second
source shape. The authored `tsconfig.json` extends `.norbital/tsconfig.json`.

## Local package propagation

Local OSS changes cross package and artifact boundaries. The light command stops after package
propagation:

```sh
pnpm run env -- link
```

1. Build `oss/packages/<name>/build`.
2. Publish that build into the yalc store and stage it for Colony's guest package overlay.
3. Copy it into each consumer's `.yalc/`.
4. Hand `node_modules` back to pnpm (`yalc add --pure` + install) so it re-materializes its
   virtual-store copy.

`env -- link` verifies those package boundaries, but it does not run `bolt sync`, publish a new
tenant artifact, or change a routed tenant. Use the full command when the running tenant must see a
change:

```sh
pnpm --dir norbital run env -- dev --template=<key>
pnpm --dir norbital run env -- dev --ui --template=<key>
```

`dev` performs propagation plus template sync/build; `--ui` additionally starts fresh local Colony.
Without `--ui`, restart/operate Colony through its normal local process after the build completes.

`env -- link` ends by verifying that every workspace resolves through pnpm's store and actually
imports, so a missed hop fails the command instead of surfacing later as an edit that did nothing.

Colony unit tests can consume the yalc overlay (`file:.yalc/`) while `package.json` still pins the
last published version. Guest-store flatten compares the local overlay against a **published**
manifest of the same version. If that version is unpublished (today: local `0.0.14` with no
registry `0.0.14`), flatten treats every dependency as changed and can fail on nested
multi-version closures such as `runed@0.25` vs `runed@0.37`. Do not weaken flatten to paper over
that. Do not Vite-alias Colony at `oss/packages`. `env -- link` is the overlay; `env -- reset`
destroys tenant databases and is not a refresh.

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
| Any OSS package consumed by a template       | No                              | `pnpm --dir norbital run env -- dev --ui`; hard-refresh tenant |
| OSS `config`, `std`, or `ui` used by website | No                              | `pnpm --dir norbital run env -- link`; restart website |
| Template source, asset, migration, or i18n   | No                              | `pnpm --dir norbital run env -- dev --ui --template=<key>` |
| Tenant `.norbital/shared/**` Skill (RFC target) | No                           | same `env -- dev` path after the toolchain cutover  |
| Personal `.norbital/personal/**` Skill (RFC target) | no tenant artifact         | owner source adapter on the next run; no `env` command |
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
