# Apps and Server Roles

## The workspace (`src/+workspace.ts`)

```ts
import { workspace } from '@norbital-ai/bolt';
export default workspace({
	tz: 'Asia/Singapore',
	locale: 'en-SG',
	currency: 'SGD',
	apps: ['sales', 'hr/kiosk'], // launcher order
	ai: {
		models: ['default', 'fast'],
		default: 'default',
		embeddings: ['photos']
	},
	agent: { triage: false }, // optional: opt the in-app agent out of triage
	csp: { connect: ['https://models.example'] }, // origins pages may fetch
	connections: {
		// named integration instances: the slot is the sys_integration id source addresses
		mail: { integration: 'email' },
		field_ops_whatsapp: {
			integration: 'whatsapp',
			envoy: 'field_ops_whatsapp'
		}
	}
});
```

`src/+secrets.ts` declares the workspace's secrets, the one place they are declared. Each entry is
a `label` and an optional `description`; there are no defaults and no non-secret values. Values are
supplied in Settings → Secrets and sealed in the tenant database, never committed or read from
host-global settings. Secret names hold OAuth clients (a definition's `oauth`, on the `calendar`
and `http` drivers), MCP URLs and credentials, and webhook verification secrets; an integration's
own secret is its `credential`, sealed per instance at pairing. A Google sign-in (Gmail, Google
Calendar) needs no tenant OAuth client: the host provides one (below), so declare `oauth` only to
use the workspace's own. Names are `UPPER_SNAKE`.

```ts
// src/+secrets.ts
import { secrets } from '@norbital-ai/bolt';
export default secrets({
	ROUTES_CLIENT_ID: { label: 'Routes API OAuth client ID' },
	ROUTES_CLIENT_SECRET: { label: 'Routes API OAuth client secret' },
	HQ_URL: { label: 'HQ MCP server', description: 'The streamable-HTTP endpoint.' }
});
```

`ai` names model classes and embedding names; the host maps them to provider models.

## Apps, pages and groups

An app is a folder under `src/app/` with `+app.ts` and one `+<page>.page.svelte` per page:

```ts
// src/app/sales/+app.ts
import { app } from '@norbital-ai/bolt';
export default app('sales', {
	title: 'app.sales.title',
	description: 'app.sales.description',
	icon: 'lucide:briefcase',
	banner: 'assets/app-media/sales.webp', // optional card and hero art
	audience: 'members', // | 'external' | 'all' | { public: ['careers_visitor'], challenge?: 'turnstile' }
	pages: {
		board: { title: 'Board' },
		list: { title: 'List', section: 'Reports' }
	} // key order is nav order
});
```

A page file with no `pages` entry is a build error (`app/page-unlisted`). A folder holds either an
app (`+app.ts`) or a group (`+group.ts`), never both; an app's name is its folder path
(`hr_controller/kiosk`), and a policy's `capabilities.apps` admits a name or everything under a
`<name>/` prefix.

```ts
// src/app/hr_controller/+group.ts
import { group } from '@norbital-ai/bolt';
export default group('hr_controller', {
	label: 'HR',
	description: 'People and payroll.',
	icon: 'lucide:users',
	defaultChild: 'payroll'
});
```

Every app and group carries a `description`: it is the manifest's only account of what the surface is
for, and an overview card that prints nothing is a failed surface.

A page is an ordinary Svelte component in `AppShell` (`@norbital-ai/ui/layout`), with `icon`,
`title`, `description`, optional `banner` / `thumbnail`, `variant` and an `actions` snippet placed
beside the hero title. The hero **is** the page header: never repeat the title in a heading beneath
it. The page scope pickers (company, site, period) go in that `actions` snippet and every view of the
page reads them; operations go in the view's toolbar actions. Do not add another scope or action bar
above the surface.

**Media.** `banner` artwork is a workspace asset (`assets/**`, shipped in the artifact). Reuse one
wide image (about 1600×800) for card and hero: the card crops it 2:1 and the hero crops it
`object-center`, so keep the subject clear in the centred crop. The template's marketing
`assets/thumbnail.svg` is a separate file ([template-repository.md](template-repository.md)).

**Large dependencies.** `assets/` holds small workspace-specific files only. A page that runs a model in the
browser fetches its weights and runtime (ONNX, wasm) from their public host or a CDN at a pinned version or commit
(`https://cdn.jsdelivr.net/npm/<package>@<version>/…`); they never ship in the artifact. LLMs and other large models
are reached through an integration with a hosted provider, never run on the host, whose memory and CPU are capped.

**Public apps.** `audience: { public: [...] }` pages run as an anonymous visitor (below) holding exactly
those policies: `create` on a submission model and field-listed `read` on published catalogue rows or
its own rows, nothing else (the build refuses the rest, and a name that is no policy). Contact forms, job
applications and registrations live here.

**Portals carry their policies.** Build a public-facing surface people use without a workspace
login as a kiosk (below): its `policies` are everything a caller holds on its pages.

```ts
// (a) no sign-in: a visitor holds exactly `site_visitor` as its anonymous user (visitor-shaped)
export default kiosk('site', { ...card, auth: 'none', policies: ['site_visitor'], pages });
// (b) sign-in: every external who signs in holds exactly `account_holder` here, as themselves
export default kiosk('account', { ...card, auth: 'external', policies: ['account_holder'], pages });
```

For (b) a signed-out visitor is sent to `/sign-in?next=…` and comes back signed in (an anonymous user
they held from a public page links to that account, below). Newcomers join by
the workspace's `signup` (its `policies` are what they hold _outside_ portals — keep that an empty
`grants: {}` policy for portal-only customers) or by invitation as external members. Scope their rows
with `{ var: 'requestor.id' }` or `{ var: 'requestor.party' }`. They open no members app; staff open
the portal only by a held `capabilities.kiosks`; administrators run inside as its policies too. An
external portal's policies list their fields, never delete, and hold no `capabilities` (build
`access/kiosk-grant`).

**Portals.** A page with `portal: true` renders alone (no sidebar, banner, tabs or agent) and may be
embedded in an allowed website's `<iframe>` when its `embed` origins admit it. The default has
no embedding origins; every other page remains same-origin. A portal is the same
page wherever it is used: a device kiosk in a members app, a customer-facing page in an external or
public app. The app's `audience` still decides who opens it. Portals are listed under the account menu's
Portals, never as sidebar rows or tabs, so link portal pages to each other yourself.

```ts
pages: { book: { title: 'app.portal.tab_book', icon: 'lucide:calendar-plus', portal: true, embed: ['https://partner.example'] } }
```

### Public and external rendering

Apps whose audience is not `members`, and kiosks whose auth is not `members`, use SSR followed by
hydration. A members-only portal remains in the internal SPA: `portal` controls chrome and
framing, while audience/auth selects rendering and admission.

Every SSR page requires `+<page>.page.server.ts` beside `+<page>.page.svelte`, plus an ordinary
`<page>.page.data.ts` exporting its default data codec. Import that exact codec into the server
declaration; the compiler uses it for both server output and browser hydration. For an orders
page whose caller policy admits the selected order numbers:

```ts
// src/app/sales/list.page.data.ts
import { Schema } from 'effect';
export default Schema.Struct({ numbers: Schema.Array(Schema.String) });

// src/app/sales/+list.page.server.ts
import { pageServer } from '@norbital-ai/bolt';
import data from './list.page.data.js';
export default pageServer({
	data,
	load: function* (_request, ctx) {
		const { orders } = yield* ctx.query({
			orders: { fields: ['number'], limit: 20 }
		});
		return { numbers: orders.rows.map((row) => row.number) };
	}
});
```

```svelte
<!-- src/app/sales/+list.page.svelte -->
<script lang="ts">
	import type Data from './list.page.data.js';
	let { data }: { data: typeof Data.Type } = $props();
</script>

{#each data.numbers as number}<p>{number}</p>{/each}
```

The loader receives workspace-relative `request.pathname`/`search`, the admitted actor, clock and
read-only caller methods. It cannot write, call facilities, read credentials or import Node
modules. Public-app visitor policies and kiosk assigned policies remain the authority; SSR does
not elevate them. Return only information the admitted caller may receive: data enters the HTML.

Render the initial content synchronously from `data`. The server `$bolt` supports display
metadata, translation, links and file URLs; it rejects workflow execution and reads during
rendering. Render codec-typed loader data synchronously, then use unified `bolt.query` for
reactive reads after hydration. Do not issue a second browser read before mount, mirror the
answer in a competing state machine or hide available data behind loading. Keep device effects
on client-owned attachments.

Only the requested SSR page's wrapper, codec and dependency graph enter its browser bundle and
CSS. It does not initialize the internal shell, unrelated pages, sessions or Norbius. Navigation
between public pages makes a new document request. Members-only SPA entry instead keeps its
opening overlay until every emitted main-thread workspace module and stylesheet initializes.
Keep module-level code free of mounted effects.

Browser imports cannot reach server role values, `.env`, server-named files or `server/`
directories, including through transitive helpers, raw imports or URL imports. Type-only imports
are permitted. Share codecs and public constants through ordinary browser-safe modules; never
reexport the server loader to the browser.

For stored images, `bolt.fileUrl(file, { preview: 64 })` requests a bounded image preview;
`preview` accepts `64 | 512 | 1024`. Omit options for the original file. The option is an object,
not a numeric second argument. Public URLs preserve their app/kiosk scope and still require file access.

Portals and kiosks declare `embed: ['https://partner.example']` to permit those origins; the
default admits no embedding origins. Other pages restrict ancestors to the workspace origin.
Embedded sessions use SameSite=None, Secure and Partitioned cookies, isolating each embedding
site. The iframe's allow attribute delegates camera/geolocation permissions, never data authority. Native facilities must be supplied
to the current document; a page does not inherit an embedding parent's globals.

## Kiosks (`src/kiosk/`)

A kiosk is a standalone chromeless surface, rooted at `src/kiosk/<name>/` — never under `src/app/`:

```ts
// src/kiosk/clock/+kiosk.ts
import { kiosk } from '@norbital-ai/bolt';
export default kiosk('clock', {
	title: 'app.kiosk.title',
	description: 'app.kiosk.description',
	icon: 'lucide:clock',
	auth: 'none', // who may open it: 'members' | 'external' | 'all' | 'none' (no sign-in)
	policies: ['kiosk_clock'], // assigned policies, with no administrator bypass
	embed: ['https://partner.example'], // omit for no cross-origin embedding
	pages: { clock: { title: 'app.kiosk.clock', icon: 'lucide:clock' } }
});
```

Each `+<page>.page.svelte` in the folder needs a `pages` entry (key order is nav order). Kiosk pages
are always chromeless and served at `/kiosk/<name>/<page>`, so they take no `portal` flag and kiosks
list under the account menu's Kiosks.

`auth` answers "required authentication or not": staff open by a held policy's
`capabilities.kiosks` naming it, every signed-in external opens one whose `auth` admits externals,
and `'none'` opens for anyone with no sign-in. `policies` answers what it
may do inside: every read and standard write on kiosk pages runs as those assigned policies, overriding
the requestor's own rights — a public kiosk whose requestor holds no policy still reads and writes
through them. A kiosk's policies read narrow named outputs (the root lists its fields, the label
included), list their create/update columns and never delete; a `'none'` kiosk's are visitor-shaped
(creates only). The build refuses the rest.

Requests name the kiosk (`Bolt-Kiosk` header, `?kiosk=` on the live stream, which sends no headers);
the host substitutes the assigned-policies authority per request — members and administrators alike run
inside as the kiosk, never themselves. An unknown kiosk or one not open to the caller is refused outright,
never run as the caller.

## Anonymous users (`{ var: 'requestor.id' }`)

A visitor of a public app or an `auth: 'none'` kiosk is an anonymous user, as in Firebase anonymous
auth: opening the page mints a `sys_user` of kind `anonymous` held by the visitor cookie (30 days
unused, then pruned). It is never a member (no People row, no members app) and holds exactly the
surface's policies; its `requestor.id` is that user, so it owns what it creates:

```ts
// orders.owner: a sys_user ref filled from the writer
relationships: { owner: { to: 'sys_user', optional: true, default: { var: 'requestor.id' } } }
// orders' narrow output for visitors: its root lists its fields, the label included
outputs: { visitor: { orders: { fields: ['number', 'note'] } } }
// the shop's policy: the visitor adds orders (owner left to its default) and reads back only its own
orders: {
	outputs: { visitor: { orders: { where: { owner: { eq: { var: 'requestor.id' } } } } } },
	create: { columns: { orders: ['note'] } }
}
```

The build lets a public policy read a model it creates only through such an owner ref. Its acts are
limited per IP like every visitor limit (`act 120/h`); minting is capped per IP (`register 20/h`), past which the page
opens with no identity and owns nothing. Signing in or up from that browser links it: a newcomer's
account keeps the same id and rows; an existing account takes over every owner ref (unless the row's
state locks it) and the anonymous user retires. Text copies of the id (`requestor.visitor`) and
`created_by` are not moved: scope ownership with a `sys_user` ref. One browser, one anonymous user; an
embedded kiosk gets one per embedding site (partitioned cookies).

**Customers who sign up on a site.** Declare `signup` in `+workspace.ts` (`via: ['phone']`, the
`policies` a newcomer holds, and the `party` model whose `match` field holds their number). A site
page verifies the number itself: `<PhoneVerify session={bolt.session} />` from `@norbital-ai/ui` is the
whole control (number with Send code, then the code beside Verify). A proven newcomer becomes an
external member holding those policies, and the page reloads as them. A public app whose policy names
the app (`capabilities.apps: ['portal']`) shows that member their own data; everyone else, staff
included, stays the app's visitor. Scope a customer's rows with `{ eq: { var: 'requestor.party' } }`, and a
row they file under their own number with `{ phone: { eq: { var: 'requestor.phone' } } }`. The member is
bound to their `party` record as soon as one holds their number. Sign-up texts cost money: they are
capped per workspace per hour, and an administrator can close sign-up in the command center's People.

## Record views

`src/data/model/<m>/+representation.svelte` takes `{ view: RecordView<'<m>'> }` and renders inside
`RecordShell` (record label, UI and Approval tabs, history). Without one, `RecordShell` renders the
model's fields. A page opens a record with `RecordShell of="<m>" id={id}` and a create sheet
with `RecordShell of="<m>" mode="create"`; it never imports a role module. `RecordShell` takes
`title subtitle icon badge hint actions trailing tabs` (each tab `{ name, title, body, icon?,
keepAlive? }`). Without `title` the sheet is titled by the record's label; `subtitle` may be a list of
field names, each rendered by its kind — never a hand-built string. `CustomView` shows the kit's empty
state; pass `empty` to replace it. `RunsFor` names runs by `title`, else `automations.<key>.label`.

## Model effects (`effect` in `+model.ts`)

Work that follows a committed write lives on the model:

```ts
model('leave_entries', {
	// fields, read, create, update, delete, notify …
	effect: {
		created: function* (rows, ctx) {
			yield* ctx.notify(
				rows.map((row) => ({
					to: [{ team: 'hr_managers' }],
					title: 'Time off recorded',
					once: row.id
				}))
			);
		},
		updated: function* (changes, ctx) {
			const approved = changes.filter(({ before, after }) => before.state !== after.state);
			// …
		},
		deleted: function* (rows, ctx) {}
	}
});
```

- Each verb runs after the commit, once per committed batch, as a durable run named
  `<model>.effect.<verb>`: queued in `sys_run`, retried 3 times on a transient failure, listed in
  the Command center's runs, never rate limited. Its ctx is an automation's (`EffectCtx`).
- `created` receives the new rows, `deleted` the stored rows, `updated` `[{ before, after }]` for
  writes that changed a stored field. Filter in code; re-read only fields the images lack.
- It runs as the **writer**: the member, envoy, portal visitor, or automation run (its `policies`)
  whose write committed. It holds no policy of its own: the rows are the root fields of the writer's
  output of the model (`default` when it holds it, else the first named output it holds), and every
  read and write needs the writer's own grants. Work that needs other authority is an automation
  the effect schedules (`ctx.schedule` needs no start grant); that run holds its own `policies` with
  the writer as its `requestor`.
- Writes it makes run effects in turn, one level deeper; past 8 levels the effect run is recorded
  failed (`depth`) instead of running, which ends a loop.
- Effects follow every commit, including provisional approval writes and their rollback (run as the
  approver). When work must wait for approval, use the approval lifecycle or the native outbox.
- A delayed follow-up is `ctx.schedule(name, input, { at, key })` from the effect.
- Bodies are safe to run twice: key acts with `once`, schedules with `key`, notices with `once`.

## Automations (`src/automation/+<name>.automation.ts`)

```ts
import { automation } from '@norbital-ai/bolt';
export default automation('time_off_digest', {
	description: 'Summarizes the last day of committed time off entries for HR.',
	on: { cron: '0 18 * * *' },
	policies: ['hr_automation'],
	retry: { attempts: 3, backoff: '5min' },
	concurrency: { max: 1 },
	run: function* (_, ctx) {
		const { leave_entries: entries } = yield* ctx.query({
			leave_entries: { where: { created_at: { gte: { var: 'now - days(1)' } } } }
		});
		yield* ctx.progress({ ratio: 0, text: `${entries.rows.length} committed entries` });
		yield* ctx.notify(
			entries.rows.map((row) => ({
				to: [{ team: 'hr_managers' }],
				title: 'Time off recorded',
				link: { model: 'leave_entries', id: row.id },
				once: row.id
			}))
		);
	}
});
```

Declare the example's team and policy in source. An automation is a job the reserved system
identity runs with its declared `policies` (required, non-empty): it runs on `cron`, on a `webhook`,
when started, or when code schedules it, and every run holds exactly those policies whoever started
it. The run records its trigger (`sys_run.trigger`, `ctx.run.trigger`): `{ kind: 'person', actor,
agent? }` for a manual start (`agent` when Norbius started it in a conversation for them), else
`{ kind: 'system', cause }` with `cron`, `webhook`, `effect` (`model`, `verb`, `records`) or
`schedule` (`by`: the scheduling run). The trigger is never authority: `requestor.*` in a run names
the system identity, so a requestor-scoped grant matches nothing and a `requestor.id` ref default
does not apply. "A customer may cancel their own booking" is a check in the body: read the booking
under the run's policies and refuse unless `trigger.kind === 'person'` and its customer is
`trigger.actor.party`. `policy.automations` grants manual starts only (a person in the UI or the
agent); `ctx.schedule` needs none. Delegations lend
explicit generated verbs without widening unrelated access. Automations cannot approve. A run has 10,000 crossings and a progress-refreshed idle deadline.
Test with native TestWorkspace.

Rate limits apply to manual starts only: the `start` callable, Run now and the agent. Declare the
automation's own `limit` (`limit: '10/min'`, counted per starter; default `'30/min'`); a start beyond it
answers `429 rateLimited` with `Retry-After`. Cron, webhook and model effect runs, and every act a run's
body performs, are never rate limited: run budgets bound them. A start over HTTP is also an act, so the
starter's policy `act` limit applies to that request too.

### Reruns

A run the process drops (crash, redeploy, cutover) goes back to `queued` and reruns **from the
start**, up to 3 times; a retry also starts over. Nothing is replayed: `sys_run` is the only
tracking, and an `ctx.ai.*`, `ctx.request` or `ctx.web.*` call is asked (and paid for) again.
Inferences rerun with the run that called them. Chat sessions are the exception: they resume from
their saved turns. So every body must be safe to run twice:

- upsert by a natural key instead of creating, or pass `ctx.act(verb, input, { once: '<key>' })`;
- check a status before a send, mail or notify, and record that it happened in the same write;
- give `ctx.schedule` a `key` so a rerun replaces rather than duplicates.

A long wait holds its isolate until the answer arrives.

Every body receiving `ctx` is a generator. Its members already return Effects: yield them
directly, recover the specific typed failure with `Effect.catchTag`, and return the declared
output. Do not wrap them in `tryPromise` or run an Effect inside the body; Bolt owns the one
invocation edge. Pure helpers stay plain. Guest helpers use `Effect.fnUntraced` or
`Effect.fnUntracedEager`; avoid constructing traced workflows at module scope. Use explicit
concurrency for batched crossings. Keep the host's finite decoders and scoped finalizers at their
actual boundary. Guests execute from source; tenant-produced native snapshots are never restored.
Exercise the built artifact through the native host to prove initialization and execution.

Batch actual native read endpoints with `RequestResolver`; use `Cache` for shared lookup results,
including concurrent requests for the same key. A catalogue snapshot cache belongs to one operation
and retains that operation's original values and failures; refreshing or evicting it halfway through
the batch changes business behavior. Test priming, duplicate lookups, shared failures and completion
of concurrent work before returning the first refusal in input order. HR's entity reader and
payroll batch adapter exercise these contracts.

- Triggers are literals: `{ cron, tz? }`, `{ webhook: '/path', verify: { scheme, secret } }`. A row
  write runs its model's `effect` (below), never an automation.
- **Business I/O runs in automations**: `ctx.request(<connection or instance>, op)`, `ctx.web.read`,
  `ctx.files.*`, `ctx.convert.document` (Markdown/HTML to a target the workspace declares in
  `workspace({ convert: { to: ['pdf', 'docx'] } })`; optional, so recover `Unavailable` with `Effect.catchTag`), `ctx.ai.sys_1.decide`, `ctx.ai.sys_2.infer`, `ctx.ai.embed`,
  `ctx.ai.transcribe` / `ctx.ai.speak` (diarized speech to text, text to speech stored as a file; optional, so recover `Unavailable` with `Effect.catchTag`),
  `ctx.geo.*`, `ctx.send(<connection or instance>, message)`. Integration bodies call
  `ctx.request(op)` on their own instance. Recover `Unavailable` explicitly when absence is allowed; other typed facility failures
  propagate unless the workflow has a specific recovery.
- Programmatic work is `ctx.schedule(name, input, { at?, key? })` from an automation, and
  `bolt.start(name, input)` from a page, which returns a start Effect with `id` and `automation` properties a page shows with `RunStatus`.
  A run's declared `output` is readable on the run.
- `ctx.ai.sys_1.decide({ state, questions })` asks keyed `noul` / `choice` / `score` questions over
  text-only state and returns typed answers; `ctx.ai.sys_2.infer` is the LLM. Neither falls back to
  the other. For structured research, `sys_2.infer({ initial, output, ... })` starts with a complete answer in memory and exposes draft tools `read`, `find`, `edit`, `diff` and `submit`. Paths are JSON Pointers in which an item of a keyed list (`{ kind: 'list', key: 'code', ... }`) is addressed by its key, never its index. Supply a concise presentation in the prompt; tool paths address the original answer. Large reads are bounded, so read child paths. Request `rules` (CEL over the output's top-level properties) make an unfinished draft fail `invalid` instead of returning the initial answer. `jsonDiff(before, after, output)` gives the same keyed change list host-side. Transient provider failures retry within the same infer invocation and preserve the transcript and edited answer.
  `tools: ['read', ...hostTools]` lets the model read workspace records as the run's policies
  (their granted outputs) across turns before it answers (e.g. three-way matching: pull the supplier's open
  `purchase_orders` and `goods_receipts`, then validate the invoice's figures); bound it with `steps`.
  The draft reader is then `read_answer`.

## Policies (`src/access_control/policy/`)

```ts
// src/access_control/policy/+sales_rep.policy.ts
import { policy } from '@norbital-ai/bolt';
export default policy({
	description: 'Sales representatives: their own accounts and orders.',
	grants: {
		accounts: {
			read: { accounts: { where: { owner: { eq: { var: 'requestor.id' } } } } },
			update: {
				check: function* (changes, ctx) {
					const me = ctx.actor.kind === 'member' ? ctx.actor.id : null;
					return changes.every((c) => c.before.owner === me)
						? ctx.allow()
						: ctx.deny('Only your own accounts can change.');
				}
			}
		},
		orders: {
			read: true,
			create: {
				columns: { orders: ['account', 'notes'] },
				check: function* (rows, ctx) {
					// a relation-hop scope is one keyed read over the whole batch
					const { accounts } = yield* ctx.db.query({
						accounts: { where: { id: { in: rows.map((r) => r.account) } }, fields: ['owner'] }
					});
					const me = ctx.actor.kind === 'member' ? ctx.actor.id : null;
					const mine = new Set(accounts.rows.filter((a) => a.owner === me).map((a) => a.id));
					const at = rows.findIndex((r) => !mine.has(r.account));
					return at < 0
						? ctx.allow()
						: ctx.deny('Orders go on your own accounts.', { row: at, field: 'account' });
				}
			}
		}
	},
	automations: ['orders_duplicate', 'quote_pdf'],
	capabilities: { apps: ['sales'] },
	limits: { act: '600/min' }
});
```

A policy is named by its file under `src/access_control/policy/`. Teams use
`src/access_control/team/+team.ts` and link exact handles to authored policies:

```ts
import { team } from '@norbital-ai/bolt';
export default team({
	sales: ['sales_rep'],
	managers: { name: 'Managers', parent: null, policies: ['manager'] },
	branch: { name: 'Branch', parent: 'managers', policies: [] }
});
```

A bare policy list uses its handle as the display label. A structured entry can supply `name`,
`parent` and `policies`; the parent graph scopes `teamTree` without passing policies down. Member
identities select existing source handles. Teams and policies have no runtime editing UI.
`sys_team` is only a read-only generated source catalogue for native FK/query compatibility, with
no authored seed rows or authority from mutable records. Do not author `sys_assignment` objects.

`limits` throttle requests per holder: `act`, `read` (`/q`, live registrations and page loaders),
`upload`, `convert`, `agent` (posts to Norbius and filter descriptions), visitor `register`, and envoy
traffic. A bare rate counts per member, and per IP for visitors; `{ rate, per: 'ip' }` only on a public
audience's policy.
Undeclared, members get `act 600/min`, `read 3000/min`, `upload 120/min`, `convert 30/min`, `agent 100/h`;
visitors, all per IP: `act 120/h`, `read 600/min`, `upload 20/h`, `register 20/h` (minting
anonymous users). Every refusal is `429 rateLimited` with
`Retry-After` and one message the shell translates. Limits never apply to automation bodies; an
automation's manual starts use its own `limit` (above).

Grants are layer maps typed from the model's declaration. `read` grants the `default` output and
`outputs: { <name>: … }` named ones; each names per path of that output a `where` (`true` reads the
output unfiltered); a deeper layer's `where` filters that layer only. The model fixes each output's
fields: a policy filters rows and never changes a shape, so a narrower audience gets a narrower
named output. Every member reads `sys_user` output `directory` (id, name); a read of `sys_user`
without a `default` grant names `output: 'directory'`. A holder that only lists stored files grants
`sys_file: { outputs: { meta: … } }` (id, name, mime) instead of its `default`. The root's policy alone guards the access point and every layer under it. A write
grant is `true` or `{ columns?, check? }`: `columns` per path is checked before any guest code,
then `check` judges the batch and returns a verdict. Approval is its `approve` verdict:

```ts
update: {
  columns: { expenses: ['title', 'amount'] },
  check: function* (changes, ctx) {
    return changes.some((c) => c.set.amount !== undefined)
      ? ctx.approve((flow) => flow.step('Manager review', { teams: ['managers'] }).supersededBy(['directors']))
      : ctx.allow();
  }
}
```

`check` receives create trees, `{ before, set }` per update (`before` the stored tree of the layers
the update declares) or the stored rows a delete removes, reads at most twice through
`ctx.db.query` as the workspace and performs no writes or I/O. Steps name teams or individual
users, run in order, and are snapshotted on the request. Use the flow's if/else for conditions and
`ctx.deny(message, { row, path, field })` for refusal. Among the holder's policies any allow
executes; otherwise the first approve in the team's policy order opens its flow; otherwise the
first deny refuses. A routed write commits
provisionally with a lock and checkpoint. Reject restores it; requestChanges keeps the data for
the requester, whose Save resubmits and reevaluates the flow. Decisions are approve, reject or
requestChanges; reasons replace independent comments, and withdrawal is unavailable. Reuse
the native timeline, request selector and record controls. Teams/policies/routes stay source.

## Agents and envoys

- `src/agent/+agent.md` is the in-app agent's brief for staff; `+agent.external.md` is the brief for
  external members. A brief describes work and evidence, never grants authority. The agent has no
  authority of its own: its reads and writes follow the identity it runs as, through the same
  access points and policies as a person. Its `read` tool takes the same read request as
  `ctx.query`; its `act` takes one callable with an array input per call. Agent configuration
  only scopes which tools that identity may use; there are no agent-only computations.
- A workspace skill is a folder, `src/agent/skill/<name>/`: `+skill.md` (`description:` frontmatter
  and `##` sections) plus any scripts and vendored pure-JavaScript packages (`node_modules/…`), at
  most 10 MiB and no links. The agent runs a script as written with `run_js { file: '<name>/<path>',
args, files }`: its tree is read-only at `/app`, named conversation files at `/in/<name>`, and
  `/out` becomes the person's files; Node built-ins other than `fs`, `path`, `buffer`, `process` and
  `util` fail by name, and `fetch` exists only for a run granted `http`. MCP declarations live in
  `src/agent/mcp/+<name>.mcp.ts`. Policies grant skills, MCP servers and host tools (including
  `http` for scripts) through `capabilities`.
- An envoy is the workspace agent as it answers senders on a conversation instance. One role per
  `src/agent/envoy/+<id>.envoy.ts`; the id is the file name:

```ts
// src/agent/envoy/+field_ops_whatsapp.envoy.ts
import { envoy } from '@norbital-ai/bolt';
export default envoy({
	name: 'Norbital', // what people call it: a message naming it is addressed to it
	audience: 'private', // 'private': members matched by handle | 'public': anyone
	policies: ['field_ops_whatsapp'], // non-empty: a group turn's whole authority
	groupMessages: 'mention_or_reply', // default; 'disabled' | 'all'
	delegation: 'disabled',
	triage: {}, // System 1 triage where the host binds it; false answers every addressed message
	dm: 'union', // default; 'envoy' holds a DM to the envoy's policies alone
	task: 'Answer questions about job assignments and keep them up to date from what people report.'
});
```

- **Deployment** is `sys_integration.envoy` on a workspace (owner `null`) instance of a
  conversation definition, so an instance has at most one envoy; `active: false` pauses it. A
  `+workspace.ts` connection's `envoy` is the default the release writes when it creates the slot;
  a runtime change is kept by later releases. `bolt check` refuses `envoy` on a connection that
  carries no conversation. Do not seed envoys or add a runtime editor for their authority.
- **Admission.** `private` admits only a sender whose handle matches a member: `sys_user.phone`
  (WhatsApp, a custom chat with `handle: 'phone'`), `sys_user.email`, `sys_user.telegram`. An
  unrecognised sender gets one fixed notice per 15 minutes in their own DM. `public` admits anyone.
  Slack, Discord and WeChat carry no member handle, so a private envoy there admits nobody. Email
  is always addressed; group chat messages follow `groupMessages`.
- **Authority.** A group turn, or an unlinked sender's DM, holds the envoy's `policies` alone, every
  requestor variable `null` except `{ var: 'requestor.instance' }`. A linked member's DM under `dm: 'union'`
  holds the envoy's policies and the member's own (admin bypass included), operands bound to the
  member. Under `dm: 'envoy'` it holds the envoy's policies alone with operands bound to the member,
  admin false, no member routes, tools or automations, and `history`'s 'mine' stays on the
  instance. Limits are always the envoy's; envoy actors never decide approvals.
- **`{ var: 'requestor.instance' }`** is the instance the turn arrived on (or that a remote sync run is
  for), `null` for every other actor, so it fails closed. It types only against an FK to
  `sys_integration`. One envoy on two instances, one per legal entity, scoped by the instance:

```ts
// src/data/model/entity/+model.ts, inside fields
hotline: { kind: 'ref', to: "sys_integration", optional: true, onDelete: "setNull", where: { integration: { eq: "whatsapp" } } },
// src/data/model/payslip/+model.ts: the payslip fields a hotline reads, as a named output
outputs: { hotline: { payslip: { fields: ["salary_from", "salary_to", "status", "currency", "gross", "total_deductions", "net", "paid_at"] } } },
// src/access_control/policy/+payroll_hotline.policy.ts, with the envoy's dm: 'envoy'
payslip: {
  outputs: { hotline: { payslip: {
    where: {
      employment_id: {
        is: {
          employee_id: { is: { user_id: { eq: { var: "requestor.id" } } } },
          company_id: { is: { hotline: { eq: { var: "requestor.instance" } } } },
        },
      },
    },
  } } },
},
```

Precedent: the hr-payroll payroll hotline. `src/agent/envoy/+payroll_hotline.envoy.ts` is a
`private` envoy with `dm: 'envoy'`, `groupMessages: 'disabled'` and `triage: false`.
`src/access_control/policy/+payroll_hotline.policy.ts` is its whole authority; no team holds it.
It declares no connection: HR picks an entity's WhatsApp instance as `entity.hotline` and deploys
the envoy with an ordinary `sys_integration` update.

## Integration definitions, connections and instances

The connection lives in `src/integration/<name>/+integration.ts` as
`integration('<name>', spec)`. It declares description, driver, typed configuration, credentials
or OAuth, webhook verification, optional rate and an inline test generator. Models hold their
own syncs; transport definitions do not own business projections or callbacks attached later.
Built-in conversation definitions reserve whatsapp/email/telegram/slack/discord/wechat names.
Provider code owns custom conversation codecs and authentication protocols.

```ts
export default integration('crm', {
	description: 'The CRM account.',
	driver: 'http',
	credential: { apiKey: { kind: 'text' }, signingSecret: { kind: 'text' } },
	http: { baseUrl: 'https://api.crm.example', auth: { bearer: 'apiKey' } },
	webhook: { verify: { scheme: 'standard', secret: 'signingSecret' } },
	rate: '10/s',
	test: function* (ctx) {
		yield* ctx.request({ path: '/health' });
	}
});
```

A model's remote sync names with: crm, inline read/write and optional every/partitions. Read
returns source rows with $id/$version/$deleted and cursor/more. Write receives committed op,
row, changed fields and remote id/version, and returns the acknowledged id/version or null.
The engine owns webhook hints, paging, retention recovery, no-echo, approval timing, retry,
idempotency, conflict rollback and dead letters. A connection's rate paces every request.
See [model syncs](models-and-modeling.md#syncs).

An instance is one sys_integration row: integration, name, owner, envoy, active, configuration
and host-written status. Configuration is decoded on every write and defaults are present in
bodies. A named workspace connections slot creates its instance with that slot as id; unnamed
instances are created through ordinary grants. Pairing, pause, configuration and envoy deployment
remain runtime. Credentials stay sealed host-side and never enter configuration, seeds, status,
browser data or guest contexts.

A personal instance has an owner and is scoped to that member. It syncs, does not send conversation
messages and deploys no envoy. A workspace instance may deploy one source envoy role. Management
uses sys_integration grants; pair/unpair/test/status authorize as update on that instance. Use
native Settings and account-menu Connections, not another template-owned account model or UI.
`bolt.integration(instance)` exposes those typed Effect operations and a status Stream; an
optional +integration.svelte provides setup through the supplied controller.

Automations call ctx.request(connectionOrInstance, operation) and ctx.send for conversations.
Remote syncs and integration test use ctx.request(operation) on their own instance. HTTP paths
stay under the declared HTTPS base URL. SQL Server uses structured `DatabaseRequest` operations:
`read` declares table/columns/filters, `call` names a procedure with typed arguments through native RPC,
CDC pages declare their projection and cursor, and `insertOnce` supplies an immutable key/fingerprint
and header/children/procedure declaration. Store owns their native compilation and the host bounds
execution. See Bolt's `docs/integration-providers.md` for the request contract.
Decode external answers once, retain typed failures, and catch Unavailable only
when missing integration service is an allowed business condition. A response that later edits
a previously read row must carry its observed revision.

OAuth has one redirect URI per workspace, <public URL>/hooks/oauth/callback; state routes it to
the paired instance. HTTP/calendar definitions may name workspace secret client credentials;
the host can supply its own Google client. Tokens refresh host-side. A record's instance ref
pins its target definition with where and carries InstanceId for that definition.

Keep template-specific SQL, CDC retention, header/line assembly and business interpretation in
template source. Providers supply bounded I/O; the engine owns scheduling and durable exchange.
Neither provider code nor platform code should encode a template's domain rules.

## Seeds (`seed/`)

Contract: Bolt `docs/seeding.md`. Public rows: `seed/public/**/<model>.json[.gz]` (basename = model),
`seed/public/assets.json` + `seed/public/assets/**`, the `base` pack every release carries. Test rows:
`seed/test/**` in the same shape, the `test` pack the template's own tests seed from. The optional
`seed/+seeder.ts` (`seeder({ bank?: { tree, start? } })`) names the private bank tree; only
`bolt seed --bank=<checkout>` reads its `rows/**`, as stored, in memory, into one demo. Seed rows restore through the model engine: no write callback or approval; a
pack's `start` automations queue with its rows. Keep `seed/` invented and synthetic; never copy
seed-bank or customer rows into it.
