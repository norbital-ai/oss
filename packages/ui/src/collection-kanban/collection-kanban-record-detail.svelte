<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends Extract<keyof TCollections, string>"
>
	import type {
		CollectionDbClient,
		CollectionDefinition,
		CollectionRegistry,
		CollectionRow
	} from '@norbital-ai/platform-utils/collection';
	import { resolveRecordLabel } from '@norbital-ai/platform-utils/manifest/context';
	import { humanize } from '@norbital-ai/std/string';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Grid } from '#lib/layout';
	import { CollectionForm } from '../collection-form/index.js';
	import { DataRenderer } from '../data-renderer/index.js';
	import CollectionRecordDetailEmpty from '../collection-table/collection-record-detail-empty.svelte';
	import CollectionRecordDetailTabs from '../collection-table/collection-record-detail-tabs.svelte';
	import CollectionTableDetailRegistration from '../collection-table/internal/collection-table-detail-registration.svelte';
	import type {
		CollectionTableDetailRenderContext,
		CollectionTableNavigation
	} from '../collection-table/collection-table-navigation.svelte.js';
	import { getCollectionSurfaceRuntime, resolveCollectionSurface } from '#lib/collection-runtime';

	type Row = CollectionRow<TCollections[TName]>;

	let {
		client,
		collection,
		definition,
		recordIdField,
		resolvedDetailRouteKey,
		navigation,
		activeRecordId,
		activeRecord,
		activeRecordLoading,
		activeRecordError,
		approvalLoading,
		approvalRequest,
		refresh
	}: {
		client: CollectionDbClient<TCollections>;
		collection: TName;
		definition: CollectionDefinition<TCollections[TName]>;
		recordIdField: string;
		resolvedDetailRouteKey: string;
		navigation: CollectionTableNavigation;
		activeRecordId?: string;
		activeRecord?: Row;
		activeRecordLoading: boolean;
		activeRecordError?: string;
		approvalLoading: boolean;
		approvalRequest?: object;
		refresh(): Promise<void>;
	} = $props();
	const surfaceRuntime = getCollectionSurfaceRuntime();
	const { t } = useI18n<UiKeys>();
	const collectionSurface = $derived(
		resolveCollectionSurface(surfaceRuntime?.surfaces, String(collection))
	);
</script>

{#snippet uiDetails()}
	{#if activeRecord && collectionSurface?.representation}
		{@const Representation = collectionSurface.representation}
		{#key activeRecordId}
			<Representation record={activeRecord} close={() => navigation.pop()} {refresh} />
		{/key}
	{:else if activeRecord && activeRecordId}
		<!-- Default detail surface (RFC V.3/V.6): a schema-derived form bound to the record. -->
		{#key activeRecordId}
			<CollectionForm
				{client}
				{collection}
				recordId={activeRecordId}
				defaultValues={activeRecord}
			/>
		{/key}
	{:else}
		<CollectionRecordDetailEmpty
			icon="lucide:panel-top-dashed"
			title={t('table.noCustomView')}
			description={t('table.noCustomViewDesc')}
		/>
	{/if}
{/snippet}

{#snippet approvalDetails()}
	{#if approvalLoading}
		<p class="text-sm text-muted-foreground">{t('kanban.approvalLoading')}</p>
	{:else if approvalRequest}
		<Grid as="dl" minimum="card" gap="md">
			{#each Object.entries(approvalRequest) as [key, value] (key)}
				<div class="min-w-0 border-b pb-3">
					<dt class="text-xs font-medium text-muted-foreground">{humanize(key)}</dt>
					<dd class="mt-1 break-words text-sm">
						{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—')}
					</dd>
				</div>
			{/each}
		</Grid>
	{:else}
		<CollectionRecordDetailEmpty
			icon="lucide:shield-check"
			title={t('table.noApprovalRequest')}
			description={t('table.noApprovalRequestDesc')}
		/>
	{/if}
{/snippet}

{#snippet rawDetails()}
	{#if activeRecord}
		<Grid as="dl" minimum="card" gap="sm">
			{#each definition.fields as field (field.name)}
				<div class="min-w-0 rounded-lg border bg-card p-4">
					<dt class="text-xs font-medium text-muted-foreground">
						{field.label ?? humanize(field.name)}
					</dt>
					<dd class="mt-1 text-sm">
						<DataRenderer {field} value={Reflect.get(activeRecord, field.name)} mode="display" />
					</dd>
				</div>
			{/each}
		</Grid>
	{/if}
{/snippet}

{#snippet recordSurface({ recordId, actions }: CollectionTableDetailRenderContext)}
	<CollectionRecordDetailTabs
		title={activeRecord
			? (resolveRecordLabel(definition.recordLabel ?? null, activeRecord) ??
				String(Reflect.get(activeRecord, recordIdField) ?? humanize(String(collection))))
			: humanize(String(collection))}
		description={t('table.recordDetails', { name: humanize(String(collection)) })}
		loading={recordId !== activeRecordId || activeRecordLoading}
		error={activeRecordError}
		found={Boolean(activeRecord)}
		{actions}
		banner={collectionSurface?.banner ?? null}
		ui={uiDetails}
		approval={approvalDetails}
		raw={rawDetails}
	/>
{/snippet}

<CollectionTableDetailRegistration
	{navigation}
	routeKey={resolvedDetailRouteKey}
	renderDetail={recordSurface}
/>
