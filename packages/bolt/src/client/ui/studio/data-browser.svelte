<script lang="ts">
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import type { WorkspaceClient } from './workspace-client.js';

	/**
	 * Records of one collection, read the way every workspace surface reads them.
	 *
	 * The rows come through the workspace client's own `db[collection].findMany`, which is the
	 * `collections.findMany` command — the same authorized path an authored app uses, carrying the
	 * caller's credential and passing through the read predicate and field masking. The Studio has no
	 * privileged query of its own, and a host plugin invocation would have been a weaker subject than
	 * the operator standing in front of it.
	 *
	 * The table itself is the shared one. What a column looks like is decided by the field's declared
	 * kind and the workspace's own representation, so a `custom()` value renders here exactly as it
	 * does in the app that owns it.
	 */
	let {
		client,
		collection,
		fields = []
	}: {
		client: WorkspaceClient;
		collection: string;
		fields?: ReadonlyArray<CollectionField>;
	} = $props();
</script>

{#if fields.length === 0}
	<p class="text-meta">
		No compiled field descriptions for <code>{collection}</code>, so there is nothing to lay a table
		out from. The catalog ships with the workspace build.
	</p>
{:else}
	{#key collection}
		<CollectionTable
			{client}
			{collection}
			view={`studio:data-browser:${collection}`}
			features={{ search: fields.some((field) => field.search === true), filter: true }}
			class="min-h-0"
		>
			{#snippet columns({ Column })}
				{#each fields as field (field.name)}
					<Column name={field.name} hideable />
				{/each}
			{/snippet}
		</CollectionTable>
	{/key}
{/if}
