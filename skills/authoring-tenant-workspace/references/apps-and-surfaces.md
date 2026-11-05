# Apps and surfaces

Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').workspace>[0]`, `AppSpec`, `KioskSpec`, `GroupSpec`.

## Workspace and secrets

- `+workspace.ts` declares zone, locale, currency, launcher order (`apps`), `ai` classes and embeddings (the host maps them to providers), `agent`, `csp`, `convert`, `signup` and `connections`.
- `+secrets.ts` is the one place secrets are declared: `UPPER_SNAKE` name, `label`, optional `description`; no defaults or non-secret values. Values are set in Settings and sealed in the tenant database.
- Secret names hold OAuth clients, MCP URLs and credentials, and webhook secrets. An integration's own secret is its `credential`, sealed per instance at pairing.
- Server Effect bodies read declared values through `Config.Redacted(name)` from `effect`, in automations, callbacks and loaders; `Config.option` for optional ones. A required unset value fails. Use `Redacted.value` only where plaintext is needed.
- Keep values out of page data, logs, chat and source. Clients and declaration evaluation get none.

## Apps, groups and pages

- An app is a folder under `src/app/` with `+app.ts` and one `+<page>.page.svelte` per page. A page with no `pages` entry is a build error; key order is nav order.
- A folder holds `+app.ts` or `+group.ts`, never both; only a group holds apps and groups. An app's name is its folder path. `capabilities.apps` admits a name or everything under `<name>/`.
- Every app and group has a `description`.
- A page sits in `AppShell`. Slots: [app-structure.md](app-structure.md). Across pages, nav is `+app.ts` `pages`, never tabs.
- `banner` art is a workspace asset: one wide image (about 1600×800), subject in the centred crop. It is not the template's marketing thumbnail.
- `assets/` holds small workspace files only. Weights and wasm runtimes load in the browser from a public CDN at a pinned version. LLMs go through an integration; never raise a host limit.

## Audiences

- `audience`: `members`, `external`, `all`, or `{ public: [...policies], challenge? }`.
- A public app runs as an anonymous visitor holding exactly those policies: `create` on a submission model and field-listed `read` of published or own rows. The build refuses the rest.
- A portal for people without a workspace login is a kiosk; its `policies` are everything a caller holds on its pages.
- External newcomers join through `signup` or invitation. `signup.policies` are what they hold outside portals: keep that an empty `grants: {}` policy for portal-only customers. Scope rows with `{ var: 'requestor.id' }` or `{ var: 'requestor.party' }`.
- External members open no members app. Staff open a portal only through `capabilities.kiosks`. An external portal's policies list fields, never delete, and hold no `capabilities`.
- A page with `portal: true` renders alone and may be embedded where its `embed` origins admit it. Portals list under the account menu, so link them yourself. `audience` still decides who opens it.

## SSR

- Non-member apps and non-member kiosks use SSR then hydration. A members-only portal stays in the internal SPA.
- Every SSR page needs `+<page>.page.server.ts` and an ordinary `<page>.page.data.ts` exporting its default codec, imported into the server declaration and shared with hydration.
- The loader gets `pathname`, `search`, the admitted actor, clock and read-only caller methods. It cannot write, call facilities, read instance credentials or import Node modules. Its data enters the HTML: return only what the caller may receive; never secrets.
- Render from `data` synchronously; the server `$bolt` rejects workflow execution and reads. Use `bolt.query` after hydration. Never issue a second read before mount or hide loaded data behind loading.
- Keep device effects on client attachments and module-level code free of mounted effects.
- Only the requested page's graph enters its browser bundle; navigation between public pages is a new document request.
- Browser imports cannot reach server role values, `.env`, server-named files or `server/` directories, even transitively. Type-only imports are allowed. Share codecs through browser-safe modules.
- `bolt.fileUrl(file, { preview })` takes an options object; `preview` is 64, 512 or 1024. Public URLs keep their app or kiosk scope and still require file access.
- Embedding: the default admits no origin. Embedded sessions use partitioned cookies per site. The iframe's allow attribute delegates device permissions, never data authority.

## Kiosks

- A kiosk is a standalone chromeless surface at `src/kiosk/<name>/`, top-level, never under `src/app/`. Each page needs a `pages` entry; served at `/kiosk/<name>/<page>`; no `portal` flag.
- `auth`: `members`, `external`, `all`, `none`. Staff open by `capabilities.kiosks`; signed-in externals when `auth` admits them; `none` needs no sign-in.
- `policies` run every read and write on its pages, overriding the requestor, administrators included. An unknown or closed kiosk is refused, never run as the caller.
- Kiosk policies read narrow named outputs (the root lists its fields, the label included), list their columns and never delete; a `none` kiosk's are create-only. The build refuses the rest.

## Anonymous users

- A visitor of a public app or `none` kiosk is a `sys_user` of kind `anonymous`, held by a cookie for 30 unused days. Never a member; it holds exactly the surface's policies; `requestor.id` is that user.
- A public policy reads a model it creates only through an owner ref defaulting to `{ var: 'requestor.id' }`.
- Limits per IP: `act 120/h`, `register 20/h`; past that the page opens with no identity.
- Signing in links the user: a newcomer keeps id and rows; an existing account takes over owner refs unless state locks them. `requestor.visitor` text copies and `created_by` do not move: scope ownership with a `sys_user` ref.
- Phone sign-up: declare `signup` (`via`, `policies`, `party` and its `match` field); the kit's phone verify control is the whole UI. A proven newcomer becomes an external member. Scope rows with `requestor.party` or `requestor.phone`. Sends are capped per workspace per hour.

## Record views

- `+representation.svelte` takes `{ view: RecordView<'<m>'> }` and renders inside `RecordShell`. Without one the shell renders the model's fields.
- A page opens a record through `RecordShell` (`mode="create"` for a create sheet); it never imports a role module.
- A subtitle is field names rendered by kind, never a hand-built string.
