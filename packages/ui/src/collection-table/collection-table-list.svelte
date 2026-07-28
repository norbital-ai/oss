<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/button';
	import { Checkbox } from '#lib/checkbox';
	import { cn } from '#lib/utils';
	import type { CollectionTableRowActionContext } from './collection-table.types.js';

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
		pageIndex,
		pageCount,
		hasNextPage,
		toolbar,
		toolbarTools,
		ListCard,
		emptyPlaceholder,
		rowActions,
		recordTitle,
		recordHref,
		onOpen,
		onPreviousPage,
		onNextPage,
		activeRecordId = null
	}: {
		rows: readonly ListRow[];
		loading: boolean;
		error?: string;
		selectable: boolean;
		disabled: boolean;
		class?: string;
		pageIndex: number;
		pageCount: number;
		hasNextPage: boolean;
		toolbar: Snippet;
		toolbarTools?: Snippet;
		ListCard: Snippet<[TRow]>;
		emptyPlaceholder?: Snippet;
		rowActions?: readonly Snippet<[CollectionTableRowActionContext<TRow>]>[];
		recordTitle(record: TRow): string;
		recordHref(record: TRow): string | undefined;
		onOpen(record: TRow): void;
		/** Record id currently open in the detail stack; drives the row active indicator. */
		activeRecordId?: string | null;
		onPreviousPage(): void;
		onNextPage(): void;
	} = $props();
</script>

<div
	class={cn(
		'collection-table-list grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden',
		className
	)}
	aria-busy={loading}
>
	<div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2 pb-3">
		<div
			class="flex min-w-0 flex-1 basis-[12rem] items-center gap-1 overflow-x-auto overflow-y-visible overscroll-x-contain"
		>
			{@render toolbar()}
		</div>
		{#if toolbarTools}<div class="ml-auto shrink-0">{@render toolbarTools()}</div>{/if}
	</div>

	<div class="min-h-0 overflow-y-auto overscroll-contain rounded-md border bg-card">
		{#if loading}
			<div class="divide-y" aria-label="Loading records">
				{#each Array(8) as _, index (index)}
					<div class="space-y-2 p-4">
						<div class="h-4 w-2/3 animate-pulse rounded bg-muted"></div>
						<div class="h-3 w-5/6 animate-pulse rounded bg-muted"></div>
					</div>
				{/each}
			</div>
		{:else if error}
			<div class="grid min-h-48 place-items-center p-6 text-center">
				<div>
					<Icon icon="lucide:alert-circle" class="mx-auto size-5 text-destructive" />
					<p class="mt-2 text-sm font-medium text-destructive">Unable to load records</p>
					<p class="mt-1 text-xs text-muted-foreground">{error}</p>
				</div>
			</div>
		{:else if rows.length === 0}
			<div class="grid min-h-48 place-items-center p-4">
				{#if emptyPlaceholder}
					{@render emptyPlaceholder()}
				{:else}
					<div class="text-center text-muted-foreground">
						<Icon icon="lucide:inbox" class="mx-auto size-6" />
						<p class="mt-2 text-sm font-medium">No results found</p>
						<p class="text-xs">Try adjusting your search or filters</p>
					</div>
				{/if}
			</div>
		{:else}
			<div class="divide-y" role="list">
				{#each rows as row (row.id)}
					{@const isDetailActive = activeRecordId != null && activeRecordId === row.id}
					<div
						class={cn(
							'relative flex min-w-0 items-stretch bg-card transition-colors',
							isDetailActive ? 'bg-accent/50' : row.selected ? 'bg-accent/40' : 'hover:bg-muted/40'
						)}
						data-detail-active={isDetailActive ? 'true' : undefined}
						aria-current={isDetailActive ? 'true' : undefined}
						role="listitem"
					>
						{#if isDetailActive}
							<span class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" aria-hidden="true"
							></span>
						{/if}
						{#if selectable}
							<label class="flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
								<span class="sr-only">Select {recordTitle(row.record)}</span>
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
						{#if rowActions?.length}
							<div class="flex shrink-0 items-center pr-1">
								{#each rowActions as action}
									{@render action({ row: row.record, hovered: true })}
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="flex items-center justify-between gap-3 pt-3">
		<Button
			type="button"
			variant="outline"
			size="icon"
			class="size-11"
			aria-label="Previous page"
			disabled={disabled || pageIndex === 0}
			onclick={onPreviousPage}
		>
			<Icon icon="lucide:chevron-left" class="size-4" />
		</Button>
		<p class="text-xs tabular-nums text-muted-foreground">Page {pageIndex + 1} of {pageCount}</p>
		<Button
			type="button"
			variant="outline"
			size="icon"
			class="size-11"
			aria-label="Next page"
			disabled={disabled || !hasNextPage}
			onclick={onNextPage}
		>
			<Icon icon="lucide:chevron-right" class="size-4" />
		</Button>
	</div>
</div>

<style>
	.collection-table-list > :first-child > :first-child :global(button),
	.collection-table-list > :first-child > :first-child :global(a) {
		min-height: 2.75rem;
	}
</style>
