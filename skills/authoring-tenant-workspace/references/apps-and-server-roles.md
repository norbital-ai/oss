# Apps and Server Roles

## Apps and groups

Every application is `src/apps/**/+<app>.svelte`; filename and group directory own their IDs. Metadata in
`<svelte:head>` is static: literal title, optional description, literal `bolt:icon`, and optional static
`bolt:thumbnail` / `bolt:banner` URLs. There is no layout metadata.

```svelte
<script lang="ts">
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
</script>

<svelte:head>
	<title>Operations</title>
	<meta name="description" content="Manage daily operations" />
	<meta name="bolt:icon" content="lucide:briefcase" />
	<meta name="bolt:thumbnail" content="https://cdn.example.com/operations-card.webp" />
	<meta name="bolt:banner" content="https://cdn.example.com/operations-banner.webp" />
</svelte:head>

<Cover as="main">
	<Bound size="full" inset>
		<CollectionTable collection="sites">
			{#snippet columns({ Column })}
				<Column name="name" />
				<Column name="client_name" />
				<Column name="house_type" />
			{/snippet}
		</CollectionTable>
	</Bound>
</Cover>
```

`Cover` owns the available app height and clips it once. `Bound size="full" inset` supplies the one
content inset; `CollectionTable` remains the only scroll owner. Do not wrap the table in `Scroll`, a
second padded container, or an unbounded `Stack`.

An optional group directory contains `+group.ts`:

```ts
import { group } from '@norbital-ai/bolt/authoring';

export default group({
	label: 'Operations',
	description: 'Day-to-day site running: jobs, visits, and the people assigned to them.',
	icon: 'lucide:briefcase'
});
```

The app `description` meta and the group `description` are both **required** — they are the manifest's
only account of what an application is for, and the studio's application list is built from them.

### App media — icons, thumbnails, banners

These fields are **in-product** app chrome. They are not the template's website marketing image —
that is `assets/thumbnail.svg` at the template root (see
[template-repository.md](template-repository.md#marketing-thumbnail-declare-once)).

| Field            | Where it renders                                                                                             | Required |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `bolt:icon`      | Sidebar, overview app cards, omni finder; opaque chip on the shell app media header when a banner is present | **yes**  |
| `bolt:thumbnail` | `Frame ratio="banner"` (2:1) on the workspace overview; omni finder tile                                     | no       |
| `bolt:banner`    | Always-visible compact shell chrome (`AppMediaHeader`): full-bleed image + dark scrim + title/description    | no       |

Not every app needs a thumbnail or banner. Overview cards keep a `Frame ratio="banner"` media slot
with a website-style gradient and app-icon fallback when `bolt:thumbnail` is missing or fails to load;
the omni finder shows the app icon in the same 6×6 tile a thumbnail would occupy — so grids and rows
stay aligned whether or not an app ships images. App banners are omitted entirely when `bolt:banner`
is missing or fails to load. When present, the shell renders a fixed Airbnb-style media header
(image + bottom-weighted dark scrim + icon chip + localized title/description). Copy always sits on
the scrim — never on the raw banner art — so contrast does not depend on light or dark imagery.

### App identity is rendered once

The media header **is** the app's header. An app must not repeat its own title or description in a
`PageHeader` underneath it — that is the same identity twice, one directly above the other.

A scope picker is the reason apps used to do it anyway: `PageHeader` was the only thing that could
hold a control, and it renders a title as soon as you give it one. Hand the control to the shell
instead and it lands at the trailing edge of the media header:

```svelte
<script lang="ts">
	import AppHeaderActions from '@norbital-ai/bolt/client/app-header-actions';
	import { Combobox } from '@norbital-ai/ui/combobox';
</script>

<AppHeaderActions>
	<Combobox ariaLabel="Legal entity" options={companyOptions} bind:value={companyId} />
</AppHeaderActions>
```

The controls sit on the dark scrim, so keep them compact and self-labelling — an `ariaLabel` and a
placeholder rather than a stacked visible label. An app that registers actions but ships no
`bolt:banner` still gets the header, on its base wash, so the controls have somewhere to live.
Reach for `PageHeader` only for a heading the manifest cannot know, such as a dynamic record title.

**Shipping images with a template.** Commit image files under `assets/` in the template workspace
and reference them with the seed-asset URL — no external CDN needed:

```text
<key>/assets/app-media/operations-banner.svg
```

```svelte
<meta
	name="bolt:thumbnail"
	content="/api/template-seed-assets/<key>/app-media/operations-banner.svg"
/>
<meta
	name="bolt:banner"
	content="/api/template-seed-assets/<key>/app-media/operations-banner.svg"
/>
```

Any file under `assets/` is served by the host at `/api/template-seed-assets/<key>/<path>` (PNG, JPEG,
WebP, GIF, SVG, IFC, PDF, …). Reuse one wide image (e.g. 1600×800) for both thumbnail and banner:
the overview `Frame ratio="banner"` crops it 2:1 and the shell media header crops it `object-top`
into a fixed compact strip. Keep the interesting composition in the top ~260px of the art.
Template assets are the standard place for this; a URL from any stable origin works the same.

### Record detail banners (`+representation.svelte`)

The collection-owned `+representation.svelte` may also declare a static `bolt:banner` meta. The
compiler reads it and the record detail sheet renders it as a fixed-height image above the sheet
header — on both table and kanban detail surfaces. It is optional and independent of app media.

```svelte
<svelte:head>
	<meta
		name="bolt:banner"
		content="/api/template-seed-assets/<key>/record-media/employments-banner.svg"
	/>
</svelte:head>
```

The same seed-asset pattern applies: commit the image under the template's `assets/` directory
(e.g. `assets/record-media/<collection>-banner.svg`) and point at its
`/api/template-seed-assets/<key>/…` URL. A missing or dynamic banner is ignored — the sheet header
renders without one.

The shell owns document scroll and one app query container. Use `Stack`, `Inline`, `Cluster`, `Split`,
`Grid`, `Columns`, `Cover`, `Center`, and `Frame` for composition. Create local scrolling only with named,
explicit `<Bound><Scroll>…</Scroll></Bound>`. Do not use raw structural flex/grid, generic overflow clipping,
or flex/min-size chains. See the layout section in [SKILL.md](../SKILL.md#apps-layout-and-collection-surfaces).

`CollectionTable`, `CollectionKanban`, and `CollectionForm` get the unified client from Bolt context. Tables
always use an explicit typed `columns` snippet. A duplicate collection surface needs an explicit unique
`view`. Query options are reactive. Use the collection-owned `+representation.svelte` only for a genuine
override; schema-derived defaults otherwise remain the single source of form/detail behavior. It imports
generated `RepresentationProps` from adjacent `./$types.js` and branches on nullable `record` for create
versus existing-record display/edit.

## Client API

```ts
import { client } from '$bolt/client';

const sites = client.db.sites.findMany({ limit: 50, after });
await client.db.sites.create({ name: 'North site' });
const forecast = await client.invoke.compute_forecast({ site_id: '…' });
```

Reads are reactive queries, mutations are promises, and mutations invalidate related queries. Use opaque
cursors (`after`), query-level grouping/aggregation, and collection filters rather than broad in-memory work.

`create` and `update` answer with the **stored row**, not with the values that were handed in: a
record is not what the form posted once a column default, a generated column and a
`perRecord.before` hook have run, and a caller that put its own argument into a store was holding a
record that had never existed. The browser does not mint the primary key either — the server assigns
it. `create` also accepts a **graph**: a key naming a declared `many` relation carries the records
that belong to this one, and the server writes the parent and its children in one transaction,
filling each child's foreign key from the id it assigns the parent.

Server roles reach the same collections under the same names, but through Effects rather than
promises — `yield* api.db.query.<collection>.findMany(...)`, `yield* api.db.<collection>.create(...)`.

## Automation

`src/automation/+daily_site_digest.ts`:

```ts
import { defineAutomation } from '@norbital-ai/bolt/authoring';
import { Effect } from 'effect';

export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{
		description:
			'Counts every active site each morning so the ops desk opens on a fresh roll-call.',
		handler: (api) =>
			Effect.gen(function* () {
				const sites = yield* api.db.query.sites.findMany({ limit: 250 });
				return { count: sites.length };
			})
	}
);
```

The spec is always an object and its `description` is mandatory — it is what the manifest, and so the
studio, says this automation is for. Automations run after commit, are durable and idempotent, and never
repeat their filename as an ID. The runtime executes them — schedule triggers run on cron; a collection
event trigger runs whenever a row changes, receiving the triggering row as `scope.incoming_record`:

```ts
export default defineAutomation(
	{ trigger: { collection: 'sites', event: 'created' } },
	{
		description: 'Recounts sites whenever one is added, so the desk total never drifts.',
		handler: (api, { scope }) =>
			Effect.gen(function* () {
				const count = yield* api.db.query.sites.count({});
				return { count, site: scope.incoming_record.norbital_id };
			})
	}
);
```

`kind: 'agent'` is not a `defineAutomation` body — interactive chat and channels use
`AgentAutomationSpec` on `src/+agent.ts` instead. When a handler or hook needs model judgement, call
`api.infer({ schema, prompt, model?, images? })` — an Effect `Schema.Schema` for `schema` (never
zod), and optionally the workspace images the turn should see. It is a single schema-validated turn:
it offers no tools, owns no transcript, and never reaches authoring, a sandbox, MCP, or a write.

```ts
import { Effect, Schema } from 'effect';

export default defineAutomation(
	{ schedule: '0 3 * * 1' },
	{
		description:
			'Weekly statutory alignment check — rule-based drift detection, optional successor copies, AI-written report.',
		handler: (api) =>
			Effect.gen(function* () {
				const findings = detectDrift(/* bounded reads */);
				const report = yield* api.infer({
					schema: Schema.Struct({
						summary: Schema.String,
						highlights: Schema.Array(Schema.String)
					}),
					prompt: `Summarize these findings in prose:\n${findings.map((f) => `- ${f}`).join('\n')}`
				});
				return { summary: report.summary, highlights: report.highlights };
			})
	}
);
```

Automations and hooks may make schema-validated inference over explicitly selected workspace
images. Pass only `document_asset` IDs already associated with the record being processed — the id a
`file()` column holds. Bolt resolves each asset's stored bytes and mime type, inlines them on the
turn, and refuses a non-image, more than eight images, or more than 20 MiB in total rather than
dropping any of them silently:

```ts
const result =
	yield *
	api.infer({
		model: 'stepfun/step-3.7-flash',
		prompt: 'Read the visibly printed site name and unit number. Use null when absent.',
		images: [{ assetId: scope.incoming_record.document_asset_id, detail: 'high' }],
		schema: Schema.Struct({
			site_name: Schema.NullOr(Schema.String),
			unit_number: Schema.NullOr(Schema.String)
		})
	});
```

Heavy durable infer belongs in a post-commit automation. Hooks may call `api.infer` for judgement
on the write path (for example a photo), but they still must not queue work or send email.

Timeout is host policy. The host admits each function — including reads — and kills the guest when
the timeout fires. An automation can take longer overall because if the
work is not finished, the host calls the same function again. `api.infer` yields: pre-inference
writes roll back, the host runs the model, and a later admit resumes the handler with the stored
result. The successful writes commit when the function returns. Keep the authored handler straightforward;
do not add home-grown queues, timers or retry tables.

Interactive chat and channel inbound start the same way: persist the user turn, then admit the loop
function. Authors never choose a queue.

## Remotes

`src/remotes/+compute_forecast.ts`:

```ts
import { defineQueryHandler } from '@norbital-ai/bolt/authoring';
import { Effect, Schema } from 'effect';
import type { Api } from './$types.js';

export default defineQueryHandler({
	description: 'Counts the visits recorded against one site, for the site header badge.',
	schema: Schema.Struct({ site_id: Schema.String.check(Schema.isUUID()) }),
	handler: ({ site_id }, api: Api) =>
		Effect.gen(function* () {
			const count = yield* api.db.query.site_visits.count({
				where: { site_id: { eq: site_id } }
			});
			return count;
		})
});
```

`description` is required on both handler kinds and reaches `manifest.handlers`: a remote's name is
author-chosen and its payload schema describes the request, not the effect. Remotes are imperative
request/response calls; reactive reads belong to `client.db`. The filename becomes the
generated `client.invoke` property. Use `defineQueryHandler` for reactive, read-only server computation and
`defineCommandHandler` for imperative work that may mutate data. Payload schemas are Effect `Schema`
(`Schema.Struct`, `Schema.Union`, `Schema.Literals`, …) — the authoring boundary adapts them to
`~standard` for dispatch validation, so there is no zod in authoring.

## Optional seed

`src/+seed.ts` may default-export tenant fixture behavior. Keep Colony reset data, policy seed, and sensitive
statutory seed in Colony when they require system facilities. Author at most one tenant seed role.
