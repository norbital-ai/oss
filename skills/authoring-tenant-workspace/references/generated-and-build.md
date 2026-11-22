# The `bolt` verbs, seeds and migrations

Author `src/`, `seed/`, `tests/`, `assets/`; compiler owns `.norbital/` (never edit or commit; authored `tsconfig.json` only extends `.norbital/tsconfig.json`).

## Verbs & build

- `bolt sync` (declarations → types), `bolt check` (discover, names, bundle, evaluate twice deterministically, manifest, seed decode, schema, type check + assertion lint: no `as` except `as const`, no `!`), `bolt build` (bundle, source, seed packs, digests, next migration — the host's gate), `bolt test`, `bolt seed --bank=<dir>`, `bolt dev` (`--tethered` or `--host=<file>`). Exit: 0 ok, 1 author error, 2 tool failure.
- Representations/renderers take `ctx` as prop; module init must not start mounted work. SSR pages emit independent browser entries and private server files.
- **Forbidden:** `schema.ts`, `workspace.ts` outside `src/+workspace.ts`, barrels, `vite.config.ts`, `svelte.config.*`, SvelteKit routes / bare `+page`, `$lib`, `$app/*`, custom build scripts.
- Compiled JS/CSS are fingerprinted immutable assets; live cutover closes the old generation and reloads clients (respecting unsaved forms) while discarding old data caches.

## Seeds

- `seed/public/**/<model>.json[.gz]` (+ `assets.json`, `assets/**`) builds the `base` pack; `seed/test/**` builds `test`; `seed/+seeder.ts` maps private bank trees for `bolt seed` only. Never copy bank/customer rows into `seed/`.
- Seeds restore without callbacks/approvals. Seed members and business records; never seed teams, policies, approval routes, envoys, credentials or API keys. Unpaired `sys_integration` rows (`id, integration, name, owner, active, configuration`) are allowed.

## Migrations

- Manifest is the schema; `bolt build` generates editable SQL under `migrations/` and verifies full replay. Commit SQL, `snapshot.json`, `migrations.lock.json` and `physical.json` together. Never hand-create or edit applied migrations/proofs or live DBs.
- Apply runs one transaction per file under an advisory lock (5s lock wait, 15s statement, 20s call). Destructive steps need `-- accept: <step>`; `was` preserves renames; `-- check: <name>` + violation `SELECT` fails apply if any row returns; make data steps idempotent.
- `bolt build --squash=<name>` (or `workspace_preview` `squash`) baselines prefix and archives originals under `migrations/archive/`.
