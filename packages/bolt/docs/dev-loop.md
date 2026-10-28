# The template dev loop

Every verb runs inside the workspace (or takes its directory as the first argument). Exit codes: 0 ok, 1 author
error, 2 tool failure. Templates install with bun (`bun install --frozen-lockfile`); `bolt` is the workspace's own
pinned copy.

| Verb | What it does | When |
| --- | --- | --- |
| `bolt dev` (no host file, or `--tethered`) | tethered: one build, a rebuild on every settled edit, pages served from source for the host | while editing, with local Colony |
| `bolt dev` with `norbital.host.ts` (or `--host=<file>`) | untethered dev server on your own `Facilities`, pages hot reloaded | while editing, without Colony |
| `bolt check` | every error of every stage, then the type check | before a commit; CI |
| `bolt test` | the workspace's Vitest with the test kit, seeded from `seed/test/` | before a commit; CI |
| `bolt build` | the release: `.norbital/{bundle,source,seed}` and `release.json` | CI |

## `bolt dev`, tethered (the default)

Without a host file, `bolt dev` builds once, then rebuilds once per burst of edits under `src/`, `seed/` and
`migrations/*.sql` (150 ms debounce). A failed rebuild prints its errors and the loop goes on. No build type-checks (`bolt check` and CI own
that), and an unchanged migration history skips its replay.

It also serves the internal SPA from source: a Vite dev server on `127.0.0.1` (a free port) under
`/__bolt/dev/<directory>/`, the document at that base, modules and the hot-update WebSocket beneath it. It records itself in
`.norbital/dev.json` (`origin`, `base`, and `artifact`, the hash of the build whose pages it serves) after each good build,
and removes the record when it stops. A host that finds a record whose `artifact` is the release it serves takes that
release's document from the dev server and routes the base to it.

| Edit | Result |
| --- | --- |
| a page or component `.svelte` only the internal SPA reaches | Vite hot update in the open tab; the rebuild keeps the bundle's client and source copy, so the artifact hash holds |
| `+model.ts`, automations, policies, server or public pages, `seed/`, `migrations/*.sql` | a new build and artifact hash; the host cuts over and reloads open pages |

In the realm, `env start` runs one `bolt dev --tethered` per template checkout, so a `norbital.host.ts` there is ignored. Local Colony serves each checkout's
`.norbital/`, follows a new artifact hash onto the template's demo workspace (same schema: no pause, then a reload) and,
in its local composition only, serves the record's document and proxies its base. No reset.

## `bolt dev` with a host file, untethered

```bash
bolt dev --port=5180 --bank=<seed bank checkout>   # the workspace's norbital.host.ts
bolt dev --host=./dev.host.ts                       # another host file
```

The workspace's `norbital.host.ts` (or the file `--host` names) default-exports a `Facilities` record ([hosts](./hosts.md)). Each build is migrated on that host's
`database` and activated through the needs check, so a bundle needing a member the file leaves `off` refuses to
start, naming it. Served at `http://127.0.0.1:<port>` (default 5180).

| Edit | Result |
| --- | --- |
| a page or component `.svelte` in the internal SPA | Vite hot update; no rebuild of the browser build |
| `+model.ts`, automations, policies, other declarations | manifest and guest rebuilt, the workspace reactivated, `reloaded` printed |
| `seed/`, `migrations/*.sql` | rebuilt and reactivated |

It serves through the engine path bolt-server takes (`serveRelease`): deadline wakes, the cron clock and integration
links over the file's optional `serving` providers. A converter, geocoder and web reader come from `serving` too; it
serves no bundler or browser.

## `bolt check`

`bolt sync` first (`.norbital/names.ts`), then discover → names → bundle → evaluate → manifest → seed decode →
schema and migration history → one type check over the workspace's own `node_modules`. It reports every error in one
run; `--json` also writes them as one JSON line on stderr.

## `bolt test`

```bash
bolt test [dir] [vitest args…]       # e.g. bolt test . tests/payroll.test.ts
```

The workspace's own Vitest, in process, with the kit preconfigured: Svelte compiled, `@norbital-ai/bolt/test` and
`$bolt` resolved, forks without per-file isolation, a one-minute hang guard and the test lint. It needs no prior `bolt build`.
`TestWorkspace.layer({ root })` seeds from the template's `test` pack: synthetic rows authored under `seed/test/`,
built once per source hash. It never loads `base` or the bank's `sample`. The suite proves the template's own
mechanisms; see the `authoring-test-suites` skill.

## `bolt build`

```bash
bolt build [dir] [--bank=<seed bank checkout>] [--squash=<name>]
```

Writes `.norbital/bundle/` (what a host runs), `.norbital/source/` (the authored tree without tests),
`.norbital/seed/<pack>/` (`base` from `seed/`, `test` from `seed/test/`, `sample` from the bank with `--bank`) and,
last, `.norbital/release.json` naming each part's digest. It generates the next migration when the schema changed
and replays the history. An unchanged seed input reuses the built packs. See [releases](./releases.md).
