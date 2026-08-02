<script lang="ts">
	import type {
		CollectionClient,
		CollectionRow,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import type { PlatformCollections } from '@norbital-ai/platform-utils/system/collections';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Stack } from '@norbital-ai/ui/layout';

	type PolicyRow = CollectionRow<PlatformCollections['policy']>;
	let { client }: { client: CollectionClient<ErasedCollectionRegistry> } = $props();
</script>

<Stack gap="sm">
	<p class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
		Policies are declared in workspace source and reconciled into this tenant database. Assign them
		to teams here; edit their grants in the workspace policy files.
	</p>
	<CollectionTable
		{client}
		collection="policy"
		view="workspace-settings-policies"
		query={{ orderBy: { name: 'asc' }, limit: 200 }}
		title="Roles & grants"
		description="The effective policies stored for this tenant."
		features={{ search: true, filter: true, bulk: false, create: false }}
		class="h-[min(39rem,calc(100dvh-17rem))] min-h-[26rem]"
	>
		{#snippet columns({ Column })}
			<Column name="name" label="Policy" minWidth={180} card="title" />
			<Column name="key" label="Key" minWidth={150} card="subtitle" />
			<Column name="description" label="Description" minWidth={260} />
			<Column name="is_active" label="Active" width={100} card="badge" />
			<Column
				name="accessible_applications"
				label="Applications"
				width={130}
				render={({ row }) =>
					Array.isArray(row.accessible_applications) ? row.accessible_applications.length : 0}
			/>
			<Column
				name="grants"
				label="Grants"
				width={100}
				render={({ row }) => (Array.isArray(row.grants) ? row.grants.length : 0)}
			/>
		{/snippet}
	</CollectionTable>
</Stack>
