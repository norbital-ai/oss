# Apps and surfaces

Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').workspace>[0]`, `Parameters<typeof import('@norbital-ai/bolt').app>[0]`, `Parameters<typeof import('@norbital-ai/bolt').group>[0]`.

## Workspace and secrets

- `+workspace.ts` declares zone, locale, currency, launcher order (`apps`), `theme`, `ai` classes and embeddings (the host maps them to providers), `agent`, `csp`, `convert`, `signup` and rate `limits` per policy. Accounts and envoys are runtime records; administrators choose chat models and spending limits in Settings.
- `+secrets.ts` is the one place secrets are declared: `UPPER_SNAKE` name, `label`, optional `description`; no defaults or non-secret values. Values are set in Settings and sealed in the tenant database.
- Secret names hold OAuth clients, MCP URLs and credentials, and webhook secrets. An integration's own secret is its `credential`, sealed per instance at pairing.
- Server Effect bodies read declared values through `Config.Redacted(name)` from `effect`, in automations, callbacks and syncs; `Config.option` for optional ones. A required unset value fails. Use `Redacted.value` only where plaintext is needed.
- Keep values out of page data, logs, chat and source. Clients and declaration evaluation get none.

## Workspace theme

Set `theme.light` and `theme.dark` in `src/+workspace.ts` to customize the shared shell, applications, record sheets and public pages. Omitted tokens keep Bolt's defaults. Overrides compile into the workspace CSS and follow its normal preview and release; no per-page theme script is needed.

The workspace API reference includes a complete declaration example. Set each mode's primary colour, its readable foreground and matching focus ring together; override other semantic roles only as needed.

`primary` styles primary actions; `accent` styles hover and selection. `brand`, `brand-foreground`, `brand-text` and `brand-muted` control the chromatic action and brand treatments. Background, card, popover, secondary, muted, sidebar, chart and status tokens have their semantic roles; pair each surface with its foreground. Colour, sidebar and chart token names match tweakcn's CSS variables, without `--`. Copy the desired values into the light/dark maps rather than importing an entire stylesheet.

`font-sans` and `font-mono` accept installed or bundled font stacks; they do not download fonts. `radius` controls the kit's shared radius scale. Use semantic component variants throughout the app so the theme applies consistently. Preview both modes, including controls, charts, focus rings and readable foreground contrast. Keep tenant names, customer data and credentials out of theme source and documentation.

For a reference-image request, inspect every attachment using its complete file ID. Distinguish the requested layout from its palette: layout uses the existing page/record primitives; shared colours belong in `workspace.theme`. Preserve calculations, data reads, authority and approvals when restyling. Explain the changes and open the current change's preview for review. Theme customization is supported by the workspace declaration; do not tell the user it requires a platform-wide UI change.

## Apps, groups and pages

- An app is a folder under `src/app/` with `+app.ts` and one `+<page>.page.svelte` per page. A page with no `pages` entry is a build error; key order is nav order.
- A folder holds `+app.ts` or `+group.ts`, never both; only a group holds apps and groups. An app's name is its folder path. `capabilities.apps` admits a name or everything under `<name>/`.
- Every app and group has a `description`.
- A page sits in `AppShell`. Slots: [app-structure.md](app-structure.md). Across pages, nav is `+app.ts` `pages`, never tabs.
- `banner` art is a workspace asset: one wide image (about 1600×800), subject in the centred crop. It is not the template's image (`docs/screenshots/application.webp`).
- `assets/` holds small workspace files only. Weights and wasm runtimes load in the browser from a public CDN at a pinned version. LLMs go through an integration; never raise a host limit.

## Audiences

- `audience`: `members`, `external`, `all`, or `{ public: [...policies], challenge? }`.
- A public app runs as an anonymous visitor holding exactly those policies: `create` on a submission model and declared output grants for published or own rows. The build refuses the rest.
- A public app can use the kiosk shell. The policies in `audience.public` govern access inside it.
- External newcomers join through `signup` or invitation. `signup.policies` are what they hold outside portals: keep that an empty `grants: {}` policy for portal-only customers. Scope rows with `{ var: 'actor.id' }` or `{ var: 'actor.party' }`.
- External members open no members app. Staff open a signed-in kiosk through `capabilities.apps`. An external portal's policies grant narrow outputs and write columns, never delete, and hold no `capabilities`.
- A page with `portal: true` renders alone and is listed under the account menu. The app’s `embed` allows the named sites to frame any of its pages. `audience` decides who opens each page.

## SSR

- Apps with a public, external or shared audience use SSR then hydration. A members-only portal stays in the internal SPA.
- Use `ctx.query` for initial and live data. The engine resolves the reads used during server rendering under the caller's authority and passes their answers to hydration.
- Use `ctx.location.pathname` and `ctx.location.search` for a public page's filters. Run device work and writes on mount or in handlers.
- Keep device effects on client attachments and module-level code free of mounted effects.
- Only the requested page's graph enters its browser bundle; navigation between public pages is a new document request.
- Browser imports cannot reach server role values, `.env`, server-named files or `server/` directories, even transitively. Type-only imports are allowed. Keep shared helpers in browser-safe modules.
- `ctx.file_url(file, { preview })` takes an options object; `preview` is 64, 512 or 1024. Public URLs keep their app or kiosk scope and still require file access.
- Embedding: the default admits no origin. Embedded sessions use partitioned cookies per site. The iframe's allow attribute delegates device permissions, never data authority.

## Kiosks

- Declare an app in `src/app/<name>/+app.ts` with `shell: 'kiosk'` for a shared device. Its pages render alone at `/kiosk/<name>/<page>`.
- A signed-in kiosk uses `policies` as the authority for every read and write, including those by administrators. A public kiosk uses `audience.public`.
- Kiosk policies read narrow named outputs, list write columns and never delete. Public kiosk policies follow the same visitor restrictions as other public apps.

## Anonymous users

- A visitor of a public app is a `sys_user` of kind `anonymous`, held by a cookie for 30 unused days. Never a member; it holds exactly the surface's policies; `actor.id` is that user.
- A public policy reads a model it creates only through an owner ref defaulting to `{ var: 'actor.id' }`.
- Limits per IP: `act 120/h`, `register 20/h`; past that the page opens with no identity.
- Signing in links the user: a newcomer keeps id and rows; an existing account takes over owner refs unless state locks them. `actor.visitor` text copies and `created_by` do not move: scope ownership with a `sys_user` ref.
- Phone sign-up: declare `signup` (`via`, `policies`, `party` and its `match` field, and `challenge: true`, since each stranger's code is paid for); the kit's phone verify control is the whole UI. A challenged sign-up happens on a public app or kiosk page, never the workspace sign-in page. A proven newcomer becomes an external member. Scope rows with `actor.party` or `actor.phone`. The link lasts only while the record holds that number: changing it moves access to the new holder at once, so the match field is authority, and only staff may write it. Sends are capped per workspace per hour.

## Record views

- `+representation.svelte` takes `{ view: RecordView<'<m>'> }` and renders inside `RecordShell`. Without one the shell renders the model's fields.
- A page opens a record through `RecordShell` (`mode="create"` for a create sheet); it never imports a role module.
- A subtitle is field names rendered by kind, never a hand-built string.
