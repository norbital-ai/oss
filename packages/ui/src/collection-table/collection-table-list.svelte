<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { Checkbox } from '#lib/checkbox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cover, Inline, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { CollectionRecordMetadataView } from '#lib/collection-record-metadata';
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

<!--
	Records only. This is the narrow half of one collection surface, and the surface renders the
	toolbar and the pagination bar once for both halves — the list used to carry its own copies, which
	is how the same table ended up with two spellings of the same page stepper.
-->
<Cover as="div" gap="sm" class={cn('collection-table-list', className)} aria-busy={loading}>
	<Scroll axis="y" name={t('table.recordsRegion')} class="rounded-md border bg-card">
		{#if loading}
			<div class="divide-y" aria-label={t('table.loading')}>
				{#each Array(8) as _, index (index)}
					<Stack gap="xs" class="p-4">
						<div class="h-4 w-2/3 animate-pulse rounded bg-muted"></div>
						<div class="h-3 w-5/6 animate-pulse rounded bg-muted"></div>
					</Stack>
				{/each}
			</div>
		{:else if error}
			<Inline justify="center" align="center" class="min-h-48 p-6">
				<Stack gap="xs">
					<Icon icon="lucide:alert-circle" class="mx-auto size-5 text-destructive" />
					<p class="text-sm font-medium text-destructive">{t('table.unableToLoadRecords')}</p>
					<p class="text-meta">{error}</p>
				</Stack>
			</Inline>
		{:else if rows.length === 0}
			<Inline justify="center" align="center" class="min-h-48 p-4">
				{#if emptyPlaceholder}
					{@render emptyPlaceholder()}
				{:else}
					<Stack gap="xs" class="text-center">
						<Icon icon="lucide:inbox" class="mx-auto size-6" />
						<p class="text-sm font-medium">{t('common.noResultsFound')}</p>
						<p class="text-meta">{t('table.emptyStateHint')}</p>
					</Stack>
				{/if}
			</Inline>
		{:else}
			<div class="divide-y" role="list">
				{#each rows as row (row.id)}
					{@const { id: recordId } = row}
					{@const isDetailActive = activeRecordId != null && activeRecordId === recordId}
					{@const metadata = getRecordMetadata(row.record)}
					<Inline
						gap="none"
						align="stretch"
						class={cn(
							'relative min-w-0 bg-card transition-colors',
							isDetailActive ? 'bg-accent/50' : row.selected ? 'bg-accent/40' : 'hover:bg-muted/40'
						)}
						data-detail-active={isDetailActive ? 'true' : undefined}
						data-record-id={recordId}
						aria-current={isDetailActive ? 'true' : undefined}
						role="listitem"
					>
						{#if isDetailActive}
							<span class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" aria-hidden="true"
							></span>
						{/if}
						{#if selectable}
							<label class="flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
								<span class="sr-only"
									>{t('table.selectRecordLabel', { label: recordTitle(row.record) })}</span
								>
								<Checkbox
									checked={row.selected}
									{disabled}
									onCheckedChange={() => row.toggleSelection()}
								/>
							</label>
						{/if}
						<a
							href={recordHref(row.record)}
							class="min-w-0 flex-1 p-4 outline-none focus-visible:outline-none focus-visible:ring-0"
							onclick={(event) => {
								event.preventDefault();
								onOpen(row.record);
								if (event.currentTarget instanceof HTMLElement) {
									event.currentTarget.blur();
								}
							}}
						>
							{@render ListCard(row.record)}
						</a>
						<CollectionRecordMetadataView
							{metadata}
							class="my-auto max-w-[min(45%,14rem)] shrink-0 justify-end pr-2"
						/>
						{#if rowActions?.length}
							<Inline gap="xs" class="pr-1">
								{#each rowActions as action}
									{@render action({ row: row.record, hovered: true, metadata })}
								{/each}
							</Inline>
						{/if}
					</Inline>
				{/each}
			</div>
		{/if}
	</Scroll>
</Cover>
