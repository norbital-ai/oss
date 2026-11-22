# Apps and surfaces

Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').workspace>[0]`, `app`, `group`.

## Workspace, secrets & theme

- `+workspace.ts`: `tz`, `locale`, `languages`, `currency`, `apps` order, `theme`, `ai`, `agent`, `csp`, `convert`, `signup`, policy `limits`. Accounts, envoys, chat models and budgets are runtime.
- `+secrets.ts`: `UPPER_SNAKE` names + `label`/`description` (no defaults/values). Read in server Effects via `Config.Redacted(name)` (`Config.option` for optional); unwrap with `Redacted.value` only where plaintext is required. Integration secrets live on per-instance `credential`. Keep secrets out of pages, logs, chat and source.
- **Workspace theme:** override `theme.light` and `theme.dark` tokens in `src/+workspace.ts` (CSS var names without `--`, matching tweakcn: `primary`/`accent`/`brand` + foregrounds + ring, surfaces, sidebar, charts, status; `font-sans`/`font-mono` installed/bundled stacks; `radius`). Omitted tokens keep defaults; never add per-page theme CSS/scripts. For reference-image restyling, put shared palette in `workspace.theme` and preserve layout primitives, logic and authority; preview both themes.

## Apps, groups & pages

- `src/app/<app>/+app.ts` + one `+<page>.page.svelte` per `pages` entry (key order = nav order; `description` required). Folders hold `+app.ts` or `+group.ts`, never both. `capabilities.apps` admits `<name>` or `<name>/`. Across pages, nav is `+app.ts` `pages`, never tabs.
- `banner` is a workspace asset (~1600×800, subject centred; distinct from `docs/screenshots/application.webp`). Keep `assets/` small; load heavy WASM/ONNX weights from a pinned public CDN and LLMs via integrations.

## Audiences, SSR, kiosks & anonymous users

- `audience`: `members`, `external`, `all`, or `{ public: [...policies], challenge? }`.
- Public apps run as anonymous `sys_user` (`kind: 'anonymous'`, 30-day cookie, `actor.id`) holding only `audience.public` policies (`create` on submissions + narrow named output reads for published/own rows; build refuses wider grants; IP limits `act 120/h`, `register 20/h`). Scope own rows with a `sys_user` ref defaulting to `{ var: 'actor.id' }` (signing in transfers owner refs unless locked).
- External members join via invitation or `signup` (`via`, `policies` — keep empty `grants: {}` for portal-only users — `party`, `match` field writable only by staff, `challenge: true` on public/kiosk pages). Scope rows by `actor.party` or `actor.phone`; external portals grant narrow outputs/writes, never delete or `capabilities`.
- `portal: true` renders standalone under the account menu. `embed` allowlists framing origins (default none; partitioned cookies; iframe `allow` never grants data authority).
- **SSR:** public, external and shared apps SSR + hydrate per requested page (`ctx.query` resolves server-side under caller authority; read filters from `ctx.location.pathname`/`search`; keep device work/writes on mount or handlers; no server/env imports in browser graphs; `ctx.file_url(file, { preview: 64 | 512 | 1024 })` keeps auth).
- **Kiosks:** `+app.ts` with `shell: 'kiosk'` renders at `/kiosk/<name>/<page>`. Signed-in kiosks always enforce their declared `policies` (even for admins); public kiosks enforce `audience.public`. Narrow outputs/writes, never delete.

## Record views

- `+representation.svelte` takes `{ view: RecordView<'<m>'> }` inside `RecordShell` (default renders fields). Pages open records via `RecordShell` (`mode="create"` for create), never by importing role modules. Subtitles are field names rendered by kind.
