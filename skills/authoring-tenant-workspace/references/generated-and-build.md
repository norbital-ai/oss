# Generated Files and Build

## Contents

- [Generated files and diagnostics](#generated-files-and-diagnostics)
- [Build lifecycle](#build-lifecycle)
- [Forbidden legacy authoring](#forbidden-legacy-authoring)
- [Verification](#verification)

## Generated files and diagnostics

`pod sync` discovers source and atomically writes `.norbital/` only when the structure is valid. Structural
failure updates diagnostics while preserving the previous generated modules:

```text
.norbital/
├── diagnosis/                  # ignored
│   ├── structure.json
│   └── diagnostics.json
├── dist/                       # ignored build output
├── generated/
│   ├── models.ts
│   ├── registry.ts
│   ├── apps.ts
│   ├── workspace.ts
│   └── client.ts
├── migrations/                 # committed migration history
├── types/**/$types.d.ts        # ignored
└── tsconfig.json               # ignored
```

Ignore generated paths explicitly; never ignore `.norbital/` as a whole:

```gitignore
.norbital/diagnosis/
.norbital/dist/
.norbital/generated/
.norbital/types/
.norbital/tsconfig.json
```

The authored `tsconfig.json` extends `.norbital/tsconfig.json`. The generated config owns paths relative to
itself and must not declare `baseUrl`.

## Build lifecycle

`vite build` performs one fail-safe path through `pod()`:

1. Compile and validate the filesystem.
2. Preserve last-valid generated modules and stop on structural diagnostics.
3. Run native TypeScript and Svelte checks.
4. Build the generated server workspace, then the client and app loaders.
5. Generate Drizzle migrations from the registry and Pod system tables.
6. Write runtime, static, SQL, and migration artifacts under `.norbital/dist/` while preserving committed
   history under `.norbital/migrations/`.

The Vite plugin owns Svelte, Tailwind, environment builders, runtime shims, and output paths.

## Forbidden legacy authoring

Never author `schema.ts`, `workspace.ts`, collection `*.schema.ts`, `defineTable`, `defineSchema`, `QueryRow`,
global `NorbitalAuthoring` augmentation, `$tenant`, collection/app barrels, `collections/**/*.schema.ts` globs,
or `apps/*/App.svelte`.

Also forbid `$lib`, `$app/*`, `@sveltejs/kit`, routes, `+page` files, `svelte.config.*`, duplicate base CSS, and
custom build scripts inside tenant workspaces. Internal Core system-database `.schema.ts` modules are separate
infrastructure.

## Verification

```bash
# In the selected public OSS template workspace, call quality_audit first.
pnpm sync
pnpm lint
pnpm build
```

`quality_audit` scans authored source only. Its implementation and policy remain host-owned outside
the tenant repository; only structured reports are written to `.norbital/diagnosis/quality-audit/`.
Do not change generated `.norbital/**` to silence an audit finding.

## Live org checkpoint (local Core)

Template `pnpm build` validates source; it does **not** replace the checkpoint attached to a seeded
local organization. Publish the OSS package/template release, update Core’s immutable release inputs,
then deploy:

```bash
# Core (`pnpm dev`) must be running
pnpm tenant:update --org=<org-slug>
pnpm tenant:update --org=<org-slug> --template=<slug>
```

Then hard-refresh the tenant app. Prefer this over `pnpm env:reset --target dev` unless you need a reseed. Details:
root `README.md` and `.agents/context/AGENTS.md`.

Do not add template-specific deployment, data patch, or customer import scripts. Author repeatable seed
behavior in the workspace/Core seed plan and deploy every seeded tenant through `tenant:update`.
