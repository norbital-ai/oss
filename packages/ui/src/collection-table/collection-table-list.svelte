<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/button';
	import { Checkbox } from '#lib/checkbox';
	import { Cluster, Cover, Inline, Scroll, Stack } from '#lib/layout';
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

{#snippet listToolbar()}
	<Cluster gap="sm" align="center" justify="between">
		<Scroll axis="x" name="Collection toolbar" grow class="collection-table-list-toolbar min-w-0">
			<Inline gap="xs">
				{@render toolbar()}
			</Inline>
		</Scroll>
		{#if toolbarTools}
			<Inline gap="xs">
				{@render toolbarTools()}
			</Inline>
		{/if}
	</Cluster>
{/snippet}

<Cover
	as="div"
	gap="sm"
	class={cn('collection-table-list', className)}
	top={listToolbar}
	aria-busy={loading}
	bottom={listPagination}
>
	<Scroll axis="y" name="Collection records" class="rounded-md border bg-card">
		{#if loading}
			<div class="divide-y" aria-label="Loading records">
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
					<p class="text-sm font-medium text-destructive">Unable to load records</p>
					<p class="text-xs text-muted-foreground">{error}</p>
				</Stack>
			</Inline>
		{:else if rows.length === 0}
			<Inline justify="center" align="center" class="min-h-48 p-4">
				{#if emptyPlaceholder}
					{@render emptyPlaceholder()}
				{:else}
					<Stack gap="xs" class="text-center">
						<Icon icon="lucide:inbox" class="mx-auto size-6" />
						<p class="text-sm font-medium">No results found</p>
						<p class="text-xs text-muted-foreground">Try adjusting your search or filters</p>
					</Stack>
				{/if}
			</Inline>
		{:else}
			<div class="divide-y" role="list">
				{#each rows as row (row.id)}
					{@const isDetailActive = activeRecordId != null && activeRecordId === row.id}
					<Inline
						gap="none"
						align="stretch"
						class={cn(
							'relative min-w-0 bg-card transition-colors',
							isDetailActive ? 'bg-accent/50' : row.selected ? 'bg-accent/40' : 'hover:bg-muted/40'
						)}
						data-detail-active={isDetailActive ? 'true' : undefined}
						data-record-id={row.id}
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
							<Inline gap="xs" class="pr-1">
								{#each rowActions as action}
									{@render action({ row: row.record, hovered: true })}
								{/each}
							</Inline>
						{/if}
					</Inline>
				{/each}
			</div>
		{/if}
	</Scroll>
</Cover>

{#snippet listPagination()}
	<Inline gap="md" justify="between" align="center">
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
	</Inline>
{/snippet}

<style>
	:global(.collection-table-list-toolbar button) {
		min-height: 2.75rem;
	}
</style>
