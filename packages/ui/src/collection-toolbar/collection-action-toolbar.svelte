<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends CollectionToolbarName<TCollections>, TRow extends object = CollectionRow<TCollections[TName]>"
>
	import type {
		CollectionDefinition,
		CollectionFilter,
		CollectionRegistry,
		CollectionRow,
		CollectionType
	} from '@norbital-ai/std/collection';
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { getCollectionClientForSurface } from '#lib/collection-runtime';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster, Inline, Scroll, Stack } from '#lib/layout';
	import { Tooltip } from '#lib/tooltip';
	import CollectionToolbarQueryControls from './collection-toolbar-query-controls.svelte';
	import CollectionToolbarOperations from './collection-toolbar-operations.svelte';
	import CollectionToolbarAction from './collection-toolbar-action.svelte';
	import { collectionOperationsAvailable } from './collection-operations-available.js';
	import type {
		CollectionActionToolbarProps,
		CollectionToolbarName
	} from '#lib/collection-toolbar/collection-toolbar.types';

	let {
		client,
		collection,
		query,
		title,
		about,
		navigation,
		disabled = false,
		features = {},
		initialFilters = [],
		filterPersistenceKey,
		operations,
		actions
	}: CollectionActionToolbarProps<TCollections, TName, TRow> = $props();

	const { t } = useI18n<UiKeys>();
	// svelte-ignore state_referenced_locally -- a mounted collection surface keeps one generated client.
	const workspaceClient = getCollectionClientForSurface(client, 'CollectionActionToolbar');
	const definition = $derived(
		workspaceClient.collections[String(collection)] as CollectionDefinition<
			CollectionType<TRow, object>
		> // stupidity: boundary-cast — the generated client and runtime manifest share collection keys.
	);

	// Only the caller's opt-out. Whether the collection has anything to search is the schema's
	// answer, taken inside the control from the fields carrying `search: true`.
	const searchEnabled = $derived(features.search !== false);
	const filterEnabled = $derived(features.filter !== false);
	const operationsVisible = $derived(
		operations != null &&
			(collectionOperationsAvailable({
				exportCount: operations.exportPipelines?.length ?? 0,
				importCount: operations.importPipelines?.length ?? 0,
				integrationCount: operations.integrations?.length ?? 0,
				deletion: operations.deletion != null
			}) ||
				operations.selectionControls != null)
	);

	function applyFilters(next: readonly CollectionFilter[]): void {
		query.setFilters(next);
	}
</script>

<!--
	One toolbar for every collection surface.

	It used to take a `view` snippet and an `actions` snippet and render whatever it was handed, which
	made the position of the search box a decision each caller took separately — and they took it
	differently, so the same collection filtered from the left as a table and from the right as a
	board. Search, filters and operations are now the toolbar's own furniture in the toolbar's own
	order; what a caller supplies is what only the caller can know: the scope it is pinned to, and
	the actions it can run.
-->
<Cluster gap="sm" align="center" justify="between" data-collection-action-toolbar>
	<Scroll axis="x" name={t('table.toolbarRegion')} grow class="min-w-0">
		<Inline gap="sm" fill class="min-w-0">
			{#if navigation}{@render navigation()}{/if}
			{#if title}<h2 class="shrink-0 truncate text-sm font-semibold">{title}</h2>{/if}
			{#if about}
				<Tooltip align="start" contentClass="max-w-sm space-y-2" delayDuration={100}>
					{#snippet trigger({ props })}
						<Button
							{...props}
							type="button"
							variant="ghost"
							size="icon"
							class="size-8"
							aria-label={t('table.aboutCollection')}
						>
							<Icon icon="lucide:info" class="size-4" />
						</Button>
					{/snippet}
					{#snippet content()}
						{#if about.description}<p>{about.description}</p>{/if}
						{#if about.appliedContent || (about.applied && about.applied.length > 0)}
							<Stack gap="xs">
								<p class="font-medium">{t('table.appliedByView')}</p>
								{#if about.appliedContent}
									{@render about.appliedContent()}
								{:else if about.applied}
									<Stack as="ul" gap="xs">
										{#each about.applied as applied (applied)}
											<Inline as="li" align="start" gap="xs" class="text-xs">
												<Icon icon="lucide:filter" class="mt-0.5 size-3 shrink-0 opacity-70" />
												<span>{applied}</span>
											</Inline>
										{/each}
									</Stack>
								{/if}
							</Stack>
						{/if}
					{/snippet}
				</Tooltip>
			{/if}
			<CollectionToolbarQueryControls
				{definition}
				collections={workspaceClient.collections}
				{disabled}
				{searchEnabled}
				{filterEnabled}
				initialSearch={query.search}
				{initialFilters}
				{filterPersistenceKey}
				onSearchChange={(search) => query.setSearch(search)}
				onFilterChange={applyFilters}
			/>
			{#if operations && operationsVisible}
				<CollectionToolbarOperations
					collectionName={String(collection)}
					exportPipelines={operations.exportPipelines ?? []}
					importPipelines={operations.importPipelines ?? []}
					integrations={operations.integrations ?? []}
					deletion={operations.deletion}
					selectedRows={operations.selectedRows ?? []}
					selectionControls={operations.selectionControls}
					disabled={disabled || (operations.disabled ?? false)}
				/>
			{/if}
		</Inline>
	</Scroll>
	{#if actions}
		<Inline gap="xs" shrink={false}>
			{@render actions({
				Action: CollectionToolbarAction,
				query
			})}
		</Inline>
	{/if}
</Cluster>
