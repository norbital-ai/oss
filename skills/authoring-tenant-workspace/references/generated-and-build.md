# The `bolt` Verbs and Generated Files

A workspace author writes `src/`, `seed/`, `tests/` and `assets/`. The compiler writes `.norbital/`.
How a host later publishes or routes the artifact is not this skill.

## Authoring verbs

```bash
bolt sync [dir]                  # evaluate declarations and emit literal data types
bolt check [dir]                 # every error of every stage in one run
bolt build [dir]                 # .norbital/bundle, source, seed/base (from seed/public/), seed/test (from seed/test/), release.json digests
bolt test  [dir] [-- vitest args]
bolt seed  [dir] --bank=<dir> [--target=<origin> --tenant=<handle>]  # the seeder's bank tree in memory: decoded, or reset into one demo (Bolt docs/seeding.md)
bolt dev   [dir] [--tethered | --host=<file> [--port=<n>]]  # tethered: rebuild on save + page HMR for local Colony; --host: untethered dev server
```

Exit 0 ok, 1 author error, 2 tool failure. `bolt check` runs discover → names → bundle → evaluate →
manifest → seed decode → schema → the type check (one TypeScript type service over the workspace's own `node_modules`, plus Svelte compiler warnings),
and reports every error at once. The audit runs only in Colony (Studio's Audit rules, Norbius's `workspace_diagnose`), never as part of
a check; its allowance must name a rule that fires on its line. Inspect reported type/Svelte warnings
separately rather than assuming an exit code proves every presentation concern resolved.
`bolt build` is the only gate a host runs.

Declarations are evaluated at build on a worker thread stripped to a guest's globals, with a frozen clock and a seeded `Math.random`, twice: a declaration
whose manifest hash differs between the runs (reads the clock, `Math.random`, the network) is refused.

## Generated files (never edited)

```text
.norbital/
├── names.ts, names.client.ts   # path-derived declaration data as literal types; bodies omitted
├── tsconfig.json               # the authored tsconfig.json only extends this
├── representations.check.ts
├── bundle/                     # what a host runs (manifest, guest, client, server, assets, migrations)
├── source/                     # the source Studio edits (no tests)
├── seed/                       # base and test packs (a release carries base)
├── release.json                # each part's digest; written last
└── cache/**
```

The names index stores each declaration's fields, inputs, outputs and exposure as type text,
including each model's declared layer paths and the model behind each (`ReadPath<'orders'>`,
`WritePath<'orders', 'create'>`), without importing its own source or inferring body returns. `bolt sync` regenerates it;
`bolt check` syncs first and every `bolt dev` rebuild syncs on save. A changed field becomes visible to bodies
on the next sync. The compiler also emits render wrappers and client styles beneath cache.
Ignore `.norbital/` as a whole; none of it is committed.

The internal SPA opening overlay waits for every emitted main-thread workspace module, including
representations and integration setups, and its CSS before the shell mounts. Record components
still mount only when opened; imported module initialization must not start mounted work.
Representations can import `$bolt` directly. Custom field renderers register with the shell;
capture `useBolt()` from `@norbital-ai/ui` during component initialization when a renderer needs
the device or translated text. Type-only `$bolt` imports do not evaluate the page SDK.

Public/external SSR pages have independent browser entries under `artifact/client/public/` and
private guest programs, maps and byte assets under `artifact/server/`. Required `artifact.json`
`pages` entries name each route's client entry/CSS and server file/hash; `hashes.server` covers
the server tree. These private files are never browser assets. SSR loaders and components share
an ordinary `<page>.page.data.ts` codec; see [apps-and-server-roles.md](apps-and-server-roles.md).

## Identity and configuration seeds

Seed member identities and appropriate initial business records through the template's existing
reader contract. Teams, policy links and inline approval routes belong to source declarations;
do not author runtime team, policy-assignment or approval-route seed objects. Supported business
catalogues can have initial defaults in packs. Envoys are source (`src/agent/envoy/`) and named
instances come from `+workspace.ts` `connections`; neither is seeded. A pack may carry unnamed
`sys_integration` rows (`id, integration, name, owner, active, configuration`) when a sync
target's key needs an instance; any other key (`envoy`, `named`, `status`), or an id that is a
connection slot, fails the seed. Credentials and API keys are paired or issued at runtime and never
seeded. Validate executable catalogue defaults at author time because restore bypasses model write
callbacks.

## Schema changes

The manifest declares the schema. `bolt build` generates the next editable SQL file in `migrations/`
and verifies the complete history by replaying it against the declaration. Commit the SQL,
`snapshot.json`, `migrations.lock.json` and the generated `physical.json` proof together.
`bolt check` verifies the history and its physical definitions at every prefix; regenerate the
proof through the normal build rather than editing it by hand.
Hosts apply each file and its checksum record in one transaction; an applied file never changes.
Destructive blocks require their explicit `-- accept: <step>` line before a build can verify them.

Use `was` on a field or model to preserve its data through a rename. A changed inline shape leaves
an editable data step followed by validation that names the offending row count. Author backfills
in the generated next migration; never edit the live database by hand.

Edit an unapplied migration's SQL freely for complex data patterns (split a column, derive values,
reshape inline JSON). The next `bolt build` replays the edited history, refuses any schema that
differs from the declaration and rewrites the lock and `physical.json`; it can never drift from
source. Write data steps so a second run changes nothing (`where` they skip transformed rows).
To prove the data afterwards, add `-- check: <name>` followed by one `select` whose rows are the
violations (`select id from employment_profile where nationality !~ '^[A-Z]{2}$';`). It runs in
the file's transaction; any row fails the apply and rolls the whole file back, naming the check.
Idempotency is per file: the ledger runs each file once, in one transaction with its receipt,
under an advisory lock; a failed file rolls back whole. Each file runs within the host's 5 s lock
wait, 15 s statement and 20 s call bounds, so a backfill must finish in one bounded statement.
When history grows long, `bolt build --squash=<name>`
replaces the schema prefix with a verified baseline for fresh databases; applied databases keep
their originals from `migrations/archive/`, and data steps stay as an unchanged suffix.
No environment needs to be current first: a database partway through finishes the archived
originals. In Studio, a preview with `squash` runs this build and commits the result to the change.

## Forbidden

`schema.ts`, `workspace.ts` (outside `src/+workspace.ts`), barrels, `vite.config.ts`,
`svelte.config.*`, SvelteKit routes and bare `+page` files, `$lib`, `$app/*`, custom build scripts,
unverified or rewritten applied migrations, and anything under `.norbital/`.
