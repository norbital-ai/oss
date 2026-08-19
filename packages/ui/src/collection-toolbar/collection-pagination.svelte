<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Cluster, Inline } from '#lib/layout';
	import { Separator } from '#lib/separator';
	import { Tooltip } from '#lib/tooltip';
	import { cn } from '#lib/utils';
	import type { CollectionQueryState } from '#lib/collection-query';

	const { t } = useI18n<UiKeys>();

	let {
		query,
		total,
		hasNextPage,
		disabled = false,
		selectedCount,
		class: className
	}: {
		query: CollectionQueryState<TRow>;
		/** Rows the current narrowing matches, which fixes the page count. */
		total: number;
		/**
		 * Whether another page exists. Cursor-paged surfaces cannot infer this from `total`: the
		 * count and the page come from two queries, and the cursor is the only honest answer.
		 */
		hasNextPage?: boolean;
		disabled?: boolean;
		/** Omit on a surface with no row selection. */
		selectedCount?: number;
		class?: string;
	} = $props();

	let pageSizeError = $state(false);

	const pageCount = $derived(Math.max(1, Math.ceil(total / query.pageSize)));
	const canGoForward = $derived(hasNextPage ?? query.pageIndex + 1 < pageCount);

	const commitPageSize = debounce((size: number) => query.setPageSize(size), 300);
	onDestroy(() => commitPageSize.cancel());

	function updatePageSize(event: Event & { currentTarget: HTMLInputElement }): void {
		if (disabled) return;
		const raw = event.currentTarget.value;
		if (raw === '') {
			pageSizeError = false;
			commitPageSize.cancel();
			return;
		}
		const size = Number.parseInt(raw, 10);
		if (Number.isNaN(size) || size < 1 || size > 500) {
			pageSizeError = true;
			commitPageSize.cancel();
			return;
		}
		pageSizeError = false;
		commitPageSize(size);
	}

	/** Six figures of rows in a footer cell is a number nobody reads; the exact tally is the title. */
	function abbreviate(count: number): string {
		if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
		if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`;
		return count.toLocaleString();
	}
</script>

<!--
	One pagination bar for every collection surface: the table's grid, its narrow list, and authored
	boards. Its home is the foot of the surface, never the toolbar — a page stepper sitting next to
	search reads as another way to narrow the set rather than a way to walk it, and the surfaces that
	put it there each grew their own spelling of `1/6 ‹ ›`.
-->
<Cluster
	gap="md"
	justify="between"
	align="center"
	shrink={false}
	class={cn('collection-pagination p-1 text-meta', className)}
	data-collection-pagination
>
	<Cluster gap="sm">
		{#if selectedCount != null}
			<span
				class="whitespace-nowrap"
				title={t('common.selectedOfTotal', {
					selected: selectedCount.toLocaleString(),
					total: total.toLocaleString()
				})}
			>
				{t('table.selectedFraction', {
					selected: abbreviate(selectedCount),
					total: abbreviate(total)
				})}
			</span>
			<Separator orientation="vertical" class="h-4" />
		{/if}
		<Tooltip delayDuration={0} text={disabled ? t('table.pageSizeDisabled') : undefined}>
			{#snippet trigger({ props })}
				<Inline gap="xs" {...props}>
					<Input
						type="number"
						class={cn('h-6 w-14 text-xs', pageSizeError && 'border-red-500')}
						max={500}
						min={1}
						aria-label={t('table.rowsPerPage')}
						value={query.pageSize}
						oninput={updatePageSize}
						{disabled}
					/>
					<span class="text-meta">{t('table.perPage')}</span>
				</Inline>
			{/snippet}
		</Tooltip>
	</Cluster>

	<Inline gap="sm" justify="center">
		<Button
			type="button"
			variant="outline"
			size="icon"
			class="size-8"
			aria-label={t('table.previousPage')}
			disabled={disabled || query.pageIndex === 0}
			onclick={() => query.setPageIndex(query.pageIndex - 1)}
		>
			<Icon icon="lucide:chevron-left" class="size-4" />
		</Button>
		<span class="min-w-20 text-center tabular-nums">
			{t('table.pageOf', { page: query.pageIndex + 1, pages: pageCount })}
		</span>
		<Button
			type="button"
			variant="outline"
			size="icon"
			class="size-8"
			aria-label={t('table.nextPage')}
			disabled={disabled || !canGoForward}
			onclick={() => query.setPageIndex(query.pageIndex + 1)}
		>
			<Icon icon="lucide:chevron-right" class="size-4" />
		</Button>
	</Inline>
</Cluster>

<style>
	/*
		Global because the class rides on a child component's root, which never carries this
		component's scope hash — a scoped selector here would simply never match.

		The bar declares its own container so the touch sizing holds wherever it is mounted, rather
		than only inside a surface that happens to declare one further up.
	*/
	:global(.collection-pagination) {
		container-type: inline-size;
	}

	@container (max-width: 30rem) {
		:global(.collection-pagination button) {
			min-height: 2.75rem;
			min-width: 2.75rem;
		}
	}
</style>
