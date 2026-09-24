<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { Checkbox } from '#lib/checkbox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Imposter, Inline, Scroll, Stack } from '#lib/layout';
	import { VirtualList } from '#lib/virtual-list';
	import { cn } from '#lib/utils';
	import {
		CollectionRecordMetadataView,
		collectionRecordLeadingAccent
	} from '#lib/collection-record-metadata';
	import type { ResolvedCollectionRecordMetadata } from '#lib/collection-record-metadata';
	import type { CollectionTableRowActionContext } from '#lib/collection-table/collection-table.types';

	const { t } = useI18n<UiKeys>();

	interface ListRow {
		readonly id: string;
		readonly record: TRow;
		readonly selected: boolean;
		toggleSelection(): void;
	}

	let {
		rows,
		loading,
		error,
		selectable,
		disabled,
		bounded = true,
		class: className,
		ListCard,
		emptyPlaceholder,
		rowActions,
		getRecordMetadata,
		recordTitle,
		recordHref,
		onOpen,
		activeRecordId = null
	}: {
		rows: readonly ListRow[];
		loading: boolean;
		error?: string;
		selectable: boolean;
		disabled: boolean;
		/** When false, the containing record detail owns vertical scrolling. */
		bounded?: boolean;
		class?: string;
		ListCard: Snippet<[TRow]>;
		emptyPlaceholder?: Snippet;
		rowActions?: readonly Snippet<[CollectionTableRowActionContext<TRow>]>[];
		getRecordMetadata(record: TRow): readonly ResolvedCollectionRecordMetadata[];
		recordTitle(record: TRow): string;
		recordHref(record: TRow): string | undefined;
		onOpen(record: TRow): void;
		/** Record id currently open in the detail stack; drives the row active indicator. */
		activeRecordId?: string | null;
	} = $props();
</script>

{#snippet records()}
	{#if loading}
		<Stack gap="none" divided aria-label={t('table.loading')}>
			{#each Array(8) as _, index (index)}
				<Stack gap="xs" class="px-3 py-2.5">
					<div class="h-3.5 w-2/3 animate-pulse rounded bg-muted"></div>
					<div class="h-3 w-5/6 animate-pulse rounded bg-muted"></div>
				</Stack>
			{/each}
		</Stack>
	{:else if error}
		<Stack gap="xs" align="center" justify="center" grow class="min-h-40 p-6 text-center">
			<Icon icon="lucide:alert-circle" class="size-5 text-destructive" />
			<p class="text-sm font-medium text-destructive">{t('table.unableToLoadRecords')}</p>
			<p class="text-meta">{error}</p>
		</Stack>
	{:else if rows.length === 0}
		<Stack gap="xs" align="center" justify="center" grow class="min-h-40 p-4 text-center">
			{#if emptyPlaceholder}
				{@render emptyPlaceholder()}
			{:else}
				<Icon icon="lucide:inbox" class="size-6" />
				<p class="text-sm font-medium">{t('common.noResultsFound')}</p>
				<p class="text-meta">{t('table.emptyStateHint')}</p>
			{/if}
		</Stack>
	{:else}
		<VirtualList
			items={rows}
			key={(row) => row.id}
			estimateSize={52}
			role="list"
			// repository-health:allow UI27 -- VirtualList (virtual-list/, not a primitive) renders the list element; Stack `divided` cannot be that element, and `as`/`ref` do not reach inside it
			class="divide-y"
			itemProps={(row) => ({
				role: 'listitem',
				class: cn(
					'relative flex min-w-0 items-stretch transition-colors',
					activeRecordId === row.id
						? 'bg-accent/50'
						: row.selected
							? 'bg-accent/40'
							: 'hover:bg-muted/40'
				),
				'data-record-id': row.id,
				'data-detail-active': activeRecordId === row.id ? 'true' : undefined,
				'aria-current': activeRecordId === row.id ? 'true' : undefined
			})}
		>
			{#snippet item(row)}
				{@const metadata = getRecordMetadata(row.record)}
				{@const leadingAccent = collectionRecordLeadingAccent(metadata)}
				{#if leadingAccent !== null}
					<Imposter
						as="span"
						placement="start"
						class={cn('inset-y-1 w-1 rounded-r-full', leadingAccent.markerClass)}
						title={leadingAccent.tooltip}
						aria-hidden="true"
					/>
				{:else if activeRecordId === row.id}
					<Imposter
						as="span"
						placement="start"
						layer="under"
						class="inset-y-1.5 w-0.5 rounded-full bg-brand"
						aria-hidden="true"
					/>
				{/if}
				{#if selectable}
					<label class="w-9 shrink-0 cursor-pointer">
						<Inline as="span" justify="center" class="h-full">
							<span class="sr-only"
								>{t('table.selectRecordLabel', { label: recordTitle(row.record) })}</span
							>
							<Checkbox
								checked={row.selected}
								{disabled}
								onCheckedChange={() => row.toggleSelection()}
							/>
						</Inline>
					</label>
				{/if}
				<a
					href={recordHref(row.record)}
					class={cn('min-w-0 flex-1 py-2.5 pr-2 outline-none', !selectable && 'pl-3')}
					onclick={(event) => {
						event.preventDefault();
						onOpen(row.record);
						event.currentTarget.blur();
					}}
				>
					{@render ListCard(row.record)}
				</a>
				<CollectionRecordMetadataView
					{metadata}
					justify="end"
					class="my-auto max-w-[min(45%,14rem)] shrink-0 pr-2"
				/>
				{#if rowActions?.length}
					<Inline gap="none" class="pr-1">
						{#each rowActions as action}
							{@render action({ row: row.record, hovered: true, metadata })}
						{/each}
					</Inline>
				{/if}
			{/snippet}
		</VirtualList>
	{/if}
{/snippet}

<!--
	Records only. The surface renders the toolbar and the pagination bar once for both the wide grid
	and this narrow list. Bounded, the list owns its scrollport; unbounded, it virtualizes against
	the nearest parent `Scroll` (the record detail).
-->
{#if bounded}
	<Scroll
		axis="y"
		name={t('table.recordsRegion')}
		layout="stack"
		class={cn('collection-table-list rounded-md border bg-card', className)}
		aria-busy={loading}
	>
		{@render records()}
	</Scroll>
{:else}
	<div
		class={cn('collection-table-list rounded-md border bg-card', className)}
		role="region"
		aria-label={t('table.recordsRegion')}
		aria-busy={loading}
	>
		{@render records()}
	</div>
{/if}
