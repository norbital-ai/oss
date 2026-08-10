# Apps and Server Roles

## Apps and groups

Every application is `src/apps/**/+<app>.svelte`; filename and group directory own their IDs. Metadata in
`<svelte:head>` is static: literal title, optional description, literal `pod:icon`, and optional static
`pod:thumbnail` / `pod:banner` URLs. There is no layout metadata.

```svelte
<script lang="ts">
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
</script>

<svelte:head>
	<title>Operations</title>
	<meta name="description" content="Manage daily operations" />
	<meta name="pod:icon" content="lucide:briefcase" />
	<meta name="pod:thumbnail" content="https://cdn.example.com/operations-card.webp" />
	<meta name="pod:banner" content="https://cdn.example.com/operations-banner.webp" />
</svelte:head>

<Stack gap="lg">
	<PageHeader title="Operations" description="Manage daily operations." />
	<CollectionTable collection="sites">
		{#snippet columns({ Column })}
			<Column name="name" />
			<Column name="client_name" />
			<Column name="house_type" />
		{/snippet}
	</CollectionTable>
</Stack>
```

An optional group directory contains `+group.ts`:

```ts
import { group } from '@norbital-ai/pod/authoring';

export default group({ label: 'Operations', icon: 'lucide:briefcase' });
```

### App media — icons, thumbnails, banners

These fields are **in-product** app chrome. They are not the template's website marketing image —
that is `assets/thumbnail.svg` at the template root (see
[template-repository.md](template-repository.md#marketing-thumbnail-declare-once)).

| Field           | Where it renders                                                                                             | Required |
| --------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `pod:icon`      | Sidebar, overview app cards, omni finder; opaque chip on the shell app media header when a banner is present | **yes**  |
| `pod:thumbnail` | `Frame ratio="banner"` (2:1) on the workspace overview; omni finder tile                                     | no       |
| `pod:banner`    | Always-visible compact shell chrome (`AppMediaHeader`): full-bleed image + dark scrim + title/description    | no       |

Not every app needs a thumbnail or banner. Overview cards keep a `Frame ratio="banner"` media slot
with a website-style gradient and app-icon fallback when `pod:thumbnail` is missing or fails to load;
the omni finder shows the app icon in the same 6×6 tile a thumbnail would occupy — so grids and rows
stay aligned whether or not an app ships images. App banners are omitted entirely when `pod:banner`
is missing or fails to load. When present, the shell renders a fixed Airbnb-style media header
(image + bottom-weighted dark scrim + icon chip + localized title/description). Copy always sits on
the scrim — never on the raw banner art — so contrast does not depend on light or dark imagery.
Apps with a banner should not repeat the same title block in `PageHeader`; keep `PageHeader` only
for in-app actions (scope pickers) or dynamic titles.

**Shipping images with a template.** Commit image files under `assets/` in the template workspace
and reference them with the seed-asset URL — no external CDN needed:

```text
<key>/assets/app-media/operations-banner.svg
```

```svelte
<meta
	name="pod:thumbnail"
	content="/api/template-seed-assets/<key>/app-media/operations-banner.svg"
/>
<meta name="pod:banner" content="/api/template-seed-assets/<key>/app-media/operations-banner.svg" />
```

Any file under `assets/` is served by Core at `/api/template-seed-assets/<key>/<path>` (PNG, JPEG,
WebP, GIF, SVG, IFC, PDF, …). Reuse one wide image (e.g. 1600×800) for both thumbnail and banner:
the overview `Frame ratio="banner"` crops it 2:1 and the shell media header crops it `object-top`
into a fixed compact strip. Keep the interesting composition in the top ~260px of the art.
Template assets are the standard place for this; a URL from any stable origin works the same.

### Record detail banners (`+representation.svelte`)

The collection-owned `+representation.svelte` may also declare a static `pod:banner` meta. The
compiler reads it and the record detail sheet renders it as a fixed-height image above the sheet
header — on both table and kanban detail surfaces. It is optional and independent of app media.

```svelte
<svelte:head>
	<meta
		name="pod:banner"
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

`CollectionTable`, `CollectionKanban`, and `CollectionForm` get the unified client from Pod context. Tables
always use an explicit typed `columns` snippet. A duplicate collection surface needs an explicit unique
`view`. Query options are reactive. Use the collection-owned `+representation.svelte` only for a genuine
override; schema-derived defaults otherwise remain the single source of form/detail behavior. It imports
generated `RepresentationProps` from adjacent `./$types.js` and branches on nullable `record` for create
versus existing-record display/edit.

## Client API

```ts
import { client } from '$pod/client';

const sites = client.db.sites.findMany({ limit: 50, after });
await client.db.sites.create({ name: 'North site' });
const forecast = await client.invoke.compute_forecast({ site_id: '…' });
```

Reads are reactive queries, mutations are promises, and mutations invalidate related queries. Use opaque
cursors (`after`), query-level grouping/aggregation, and collection filters rather than broad in-memory work.
Server roles use the same database method names with promises.

## Automation

`src/automation/+daily_site_digest.ts`:

```ts
import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation({ schedule: '0 6 * * *' }, async (api) => {
	const sites = await api.db.query.sites.findMany({ limit: 250 });
	return { count: sites.length };
});
```

Automations run after commit, are durable and idempotent, and never repeat their filename as an ID. Use a
schedule or collection event trigger:

```ts
export default defineAutomation(
	{ trigger: { collection: 'sites', event: 'created' } },
	async (api, { scope }) => ({ count: await api.db.sites.count({}) })
);
```

Automations and server handlers may make one schema-validated inference over explicitly selected workspace
images. Pass only `document_asset` IDs already associated with the record being processed; Pod re-checks
asset access and rejects non-images, more than eight images, or more than 20 MiB total:

```ts
const result = await api.ai({
	model: 'stepfun/step-3.7-flash',
	prompt: 'Read the visibly printed site name and unit number. Use null when absent.',
	images: [{ assetId: scope.incoming_record.document_asset_id, detail: 'high' }],
	schema: z.object({
		site_name: z.string().nullable(),
		unit_number: z.string().nullable()
	})
});
```

AI and external delivery stay outside transactional hooks. Trigger a post-commit automation when the work
depends on a committed record or file.

## Remotes

`src/remotes/+compute_forecast.ts`:

```ts
import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Api } from './$types.js';

export default defineQueryHandler({
	schema: z.object({ site_id: z.string() }),
	handler: async ({ site_id }, api: Api) =>
		api.db.site_visits.count({ where: { site_id: { eq: site_id } } })
});
```

Remotes are imperative request/response calls; reactive reads belong to `client.db`. The filename becomes the
generated `client.invoke` property. Use `defineQueryHandler` for reactive, read-only server computation and
`defineCommandHandler` for imperative work that may mutate data.

## Optional seed

`src/+seed.ts` may default-export tenant fixture behavior. Keep Core reset data, policy seed, and sensitive
statutory seed in Core when they require system facilities. Author at most one tenant seed role.
