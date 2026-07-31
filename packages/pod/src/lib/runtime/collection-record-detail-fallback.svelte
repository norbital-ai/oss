<script lang="ts">
	import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
	import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
	import { humanize } from '@norbital-ai/std/string';
	import type { Snippet } from 'svelte';
	import {
		CollectionRecordDetailEmpty,
		CollectionRecordDetailTabs,
		getCollectionClientContext,
		resolveCollectionSurface,
		type CollectionSurfaceRegistry
	} from '@norbital-ai/ui/collection-table';
	import { DataRenderer } from '@norbital-ai/ui/data-renderer';
	import { Grid } from '@norbital-ai/ui/layout';
	import type { DetailStackEntry } from '$lib/client/detail/detail_stack.js';
	import { resolveRecordDetailFields } from './collection-record-detail-fields.js';

	let {
		entry,
		manifestContext,
		actions,
		collectionSurfaces,
		close = () => undefined
	}: {
		entry: DetailStackEntry;
		manifestContext: ManifestContext;
		actions?: Snippet;
		collectionSurfaces: CollectionSurfaceRegistry;
		close?: () => void;
	} = $props();

	const collectionName = $derived(entry.collectionName ?? entry.routeKey);
	const recordId = $derived(entry.recordId);
	const collectionMetadata = $derived(
		collectionName ? manifestContext.findCollection(collectionName) : null
	);
	const collectionSurface = $derived(resolveCollectionSurface(collectionSurfaces, collectionName));
	const workspaceClient = $derived(getCollectionClientContext());
	const recordQuery = $derived.by(() => {
		if (!collectionName || !recordId) return null;
		const collectionQuery = workspaceClient.db[collectionName];
		if (!collectionQuery) return null;
		return collectionQuery.findFirst({
			where: { [SYSTEM_COLUMN_NAMES.PKEY]: { eq: recordId } }
		});
	});
	const record = $derived(recordQuery?.current ?? null);
	const fields = $derived(
		collectionMetadata && record
			? resolveRecordDetailFields(
					manifestContext.manifest,
					collectionMetadata,
					manifestContext.columnsFor(collectionName),
					record
				)
			: []
	);
	const recordLabel = $derived(
		record && collectionName
			? manifestContext.getRecordDisplayLabel(record, collectionName).text
			: null
	);
	const errorMessage = $derived(recordQuery?.error?.message);
</script>

{#snippet schemaDetails()}
	<Grid as="dl" gap="sm" minimum="compact">
		{#each fields as field (field.name)}
			<div class:sm:col-span-2={field.kind === 'json'} class="min-w-0 rounded-lg border p-4">
				<dt class="mb-1 text-xs font-medium text-muted-foreground">
					{field.label ?? humanize(field.name)}
				</dt>
				<dd class="min-w-0 text-sm">
					<DataRenderer {field} value={record?.[field.name]} mode="display" />
				</dd>
			</div>
		{/each}
	</Grid>
{/snippet}

{#snippet uiDetails()}
	{#if record && collectionSurface?.representation}
		{@const Representation = collectionSurface.representation}
		<Representation {record} {close} />
	{:else}
		{@render schemaDetails()}
	{/if}
{/snippet}

{#snippet approvalDetails()}
	<CollectionRecordDetailEmpty
		icon="lucide:shield-check"
		title="No approval request"
		description="This record has no registered approval detail surface."
	/>
{/snippet}

<CollectionRecordDetailTabs
	title={recordLabel ?? humanize(collectionName)}
	description={`${humanize(collectionName)} record details`}
	loading={Boolean(recordQuery?.loading && record === null)}
	error={errorMessage ??
		(!collectionMetadata
			? `Collection "${collectionName}" was not found in the workspace manifest.`
			: undefined)}
	found={Boolean(record)}
	{actions}
	ui={uiDetails}
	approval={approvalDetails}
	raw={schemaDetails}
/>
