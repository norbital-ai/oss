# The `bolt` verbs and generated files

A workspace author writes `src/`, `seed/`, `tests/`, `assets/`. The compiler writes `.norbital/`.

## Verbs

| Verb | Does |
| --- | --- |
| `bolt sync` | evaluates declarations, emits literal data types |
| `bolt check` | every error of every stage in one run |
| `bolt build` | bundle, source, seed packs, release digests; generates the next migration |
| `bolt test` | the workspace's Vitest with the kit |
| `bolt seed --bank=<dir>` | the seeder's bank tree in memory, decoded or reset into one demo |
| `bolt dev` | `--tethered` rebuild on save; `--host=<file>` untethered |

- Exit 0 ok, 1 author error, 2 tool failure. `bolt build` is the only gate a host runs.
- `bolt check` stages: discover, names, bundle, evaluate, manifest, seed decode, schema, type check. Inspect type and Svelte warnings separately from the exit code.
- Declarations evaluate twice on a stripped worker with a frozen clock and seeded `Math.random`. A manifest differing between runs is refused.

## Generated files

- `.norbital/` holds the names index, tsconfig, bundle, source, seed packs, `release.json` and cache. It is never edited or committed. The authored `tsconfig.json` only extends its config.
- The names index stores declarations as type text with layer paths. A changed field reaches bodies on the next sync.
- Representations and custom field renderers receive `ctx` as a prop.
- Module initialization must not start mounted work: record components mount on open, but their modules load before the shell.
- SSR pages have independent browser entries and private server files; server files are never browser assets.

## Seeds

Contract: `seeder` and the `bolt seed` verb in the Bolt API reference.

- `seed/public/**/<model>.json[.gz]` (basename is the model) plus `assets.json` and `assets/**` form the `base` pack every release carries. `seed/test/**` in the same shape is the `test` pack. `seed/+seeder.ts` names the private bank tree, read only by `bolt seed`.
- Rows restore through the model engine with no write callback or approval; a pack's `start` automations queue with its rows. Validate executable catalogue defaults at author time.
- Keep `seed/` synthetic; never copy bank or customer rows into it.
- Seed member identities and business records. Never seed teams, policy assignments, approval routes, envoys, credentials or API keys. Accounts are runtime records; source declares no connection slots.
- A pack may carry unpaired `sys_integration` rows (`id, integration, name, owner, active, configuration`). Any other key fails the seed. Pairing and envoy deployment happen at runtime.

## Migrations

- The manifest is the schema. `bolt build` generates the next editable SQL file in `migrations/` and replays the whole history against the declaration. Commit the SQL, `snapshot.json`, `migrations.lock.json` and `physical.json` together.
- Never hand-write a migration file, edit an applied one, or edit the proof. Never edit the live database.
- Hosts apply each file and its checksum in one transaction under an advisory lock; a failed file rolls back whole.
- Destructive blocks need their `-- accept: <step>` line.
- `was` on a field or model preserves data through a rename. A changed inline shape leaves an editable data step.
- Edit an unapplied file's SQL for complex data patterns. The next build refuses any schema differing from the declaration. Write data steps so a second run changes nothing.
- `-- check: <name>` plus one `select` whose rows are violations runs in the file's transaction; any row fails the apply.
- Each file runs within 5 s lock wait, 15 s statement, 20 s call: a backfill finishes in one bounded statement.
- `bolt build --squash=<name>` replaces the schema prefix with a verified baseline; applied databases keep originals in `migrations/archive/`; data steps stay as a suffix. In Studio, `workspace_preview` takes `squash`.

## Forbidden

`schema.ts`, `workspace.ts` outside `src/+workspace.ts`, barrels, `vite.config.ts`, `svelte.config.*`, SvelteKit routes and bare `+page` files, `$lib`, `$app/*`, custom build scripts.
