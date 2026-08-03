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
	{ trigger: { collection: 'sites', event: 'create' } },
	async (api, { scope }) => ({ count: await api.db.sites.count({}) })
);
```

Do not put external delivery in transactional hooks.

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
